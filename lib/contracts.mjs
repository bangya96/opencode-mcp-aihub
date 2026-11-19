// Shared constants, configuration and run-request validation for opencode-mcp v2.
// Owned by Claude. Interfaces are frozen by PLAN.md; change only by agreement.

import { isAbsolute, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const SCHEMA_VERSION = 1;
export const MODES = Object.freeze(['plan', 'ask', 'edit']);
export const STATES = Object.freeze(['starting', 'running', 'done', 'failed', 'cancelled']);
export const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled']);

// Attempt-level outcome categories.
export const CATEGORIES = Object.freeze([
  'ok',
  'rate_limited', // 429 / too many requests
  'quota_exhausted', // budget, credits or quota wall
  'unavailable', // 502/503/504, overloaded, connection failures
  'model_unavailable', // model not found / not available on the gateway
  'server_error', // 500 / unexpected server error
  'auth_required', // 401/403, missing or invalid credentials
  'timeout', // the attempt outlived timeout_ms
  'launch_failed', // opencode could not be started
  'cancelled',
  'task_error', // opencode ran but the task failed; never triggers fallback
]);
export const RETRYABLE_CATEGORIES = Object.freeze(['rate_limited', 'quota_exhausted', 'unavailable', 'model_unavailable', 'server_error']);
export const FAILURE_REASONS = Object.freeze([...CATEGORIES.filter((c) => c !== 'ok' && c !== 'cancelled'), 'interrupted', 'unknown']);

// Name of the dedicated read-only agent injected through OPENCODE_CONFIG_CONTENT (kept from v1).
export const READ_ONLY_AGENT = 'opencode-mcp-readonly';

export const PLAN_PREAMBLE = [
  'You are in read-only PLANNING mode. File edits and shell commands are disabled.',
  'Study the code with the read and search tools, then reply with an implementation plan:',
  'the goal, the files to change and how, the risks, and how to verify the change.',
  'Do not ask for permission to switch modes; the user will review the plan and approve it separately.',
].join('\n');

export const PLAN_NEXT_PROMPT = 'The plan is approved. Implement it now, then verify the change.';

export const DEFAULTS = Object.freeze({
  timeout_ms: 600_000,
  min_timeout_ms: 10_000,
  max_timeout_ms: 2 * 60 * 60_000,
  sync_wait_ms: 90_000,
  max_concurrency: 4,
  job_ttl_ms: 24 * 60 * 60_000,
  max_output_chars: 120_000,
});

export class ValidationError extends Error {
  constructor(message, code = 'invalid_params') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultStateDir(env = process.env, platform = process.platform) {
  const home = homedir();
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'opencode-mcp');
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'opencode-mcp');
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    bin: env.OPENCODE_MCP_BIN || null,
    default_model: env.OPENCODE_MCP_MODEL || null,
    default_timeout_ms: Math.min(num(env.OPENCODE_MCP_TIMEOUT_MS, DEFAULTS.timeout_ms), DEFAULTS.max_timeout_ms),
    min_timeout_ms: DEFAULTS.min_timeout_ms,
    max_timeout_ms: DEFAULTS.max_timeout_ms,
    max_output_chars: Math.floor(num(env.OPENCODE_MCP_MAX_OUTPUT, DEFAULTS.max_output_chars)),
    prompt_via_argv: env.OPENCODE_MCP_PROMPT_ARGV === '1',
    state_dir: env.OPENCODE_MCP_STATE_DIR || defaultStateDir(env),
    sync_wait_ms: num(env.OPENCODE_MCP_SYNC_WAIT_MS, DEFAULTS.sync_wait_ms),
    max_concurrency: Math.floor(num(env.OPENCODE_MCP_MAX_CONCURRENCY, DEFAULTS.max_concurrency)),
    job_ttl_ms: num(env.OPENCODE_MCP_JOB_TTL_MS, DEFAULTS.job_ttl_ms),
    debug: env.OPENCODE_MCP_DEBUG === '1',
  });
}

// Values reach opencode as `--name=value` argv entries; a leading "-" is still refused so a value
// can never look like a flag (v1 rule).
const SAFE_ARG = /^[\w.:/@+[\]][\w.:/@+[\]-]*$/;
export function isSafeArg(value) {
  return typeof value === 'string' && SAFE_ARG.test(value);
}

function canonicalDir(path, label) {
  if (typeof path !== 'string' || !path.trim()) throw new ValidationError(`${label} must be a non-empty string`);
  if (!isAbsolute(path)) throw new ValidationError(`${label} must be an absolute path: ${path}`);
  let real;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new ValidationError(`${label} does not exist: ${path}`);
  }
  if (!statSync(real).isDirectory()) throw new ValidationError(`${label} is not a directory: ${path}`);
  return real;
}

/** Canonical git worktree root of cwd (or cwd itself), lower-cased on Windows. */
export function workspaceKey(cwd, platform = process.platform) {
  let root = cwd;
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) root = realpathSync.native(r.stdout.trim());
  } catch {
    // git missing or not a repo: the cwd itself is the workspace
  }
  return platform === 'win32' ? root.toLowerCase() : root;
}

const RUN_FIELDS = new Set(['prompt', 'mode', 'model', 'fallback_models', 'cwd', 'timeout_ms', 'variant', 'session_id', 'title', 'idempotency_key']);
const LEGACY_FIELDS = new Set(['prompt', 'model', 'fallback_models', 'allow_edits', 'cwd', 'timeout_ms', 'variant', 'session_id', 'title']);

function build(input, config, { mode, platform, defaultCwd }) {
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new ValidationError('prompt must be a non-empty string');
  if (!MODES.includes(mode)) throw new ValidationError(`mode must be one of: ${MODES.join(', ')}`);

  const cwd = canonicalDir(input.cwd ?? defaultCwd, 'cwd');

  const model = input.model ?? config.default_model;
  if (model === undefined || model === null || model === '') {
    throw new ValidationError(
      'No model given and OPENCODE_MCP_MODEL is not set. Pass model (provider/model, see opencode_models) or set OPENCODE_MCP_MODEL.',
      'model_required',
    );
  }
  if (!isSafeArg(model) || !model.includes('/')) throw new ValidationError(`model must be a provider/model id: ${model}`);

  let fallback_models = [];
  if (input.fallback_models !== undefined) {
    if (!Array.isArray(input.fallback_models)) throw new ValidationError('fallback_models must be an array of provider/model ids');
    for (const m of input.fallback_models) {
      if (!isSafeArg(m) || !m.includes('/')) throw new ValidationError(`fallback_models entry is not a provider/model id: ${m}`);
    }
    fallback_models = [...new Set(input.fallback_models)].filter((m) => m !== model);
  }

  let timeout_ms = config.default_timeout_ms;
  if (input.timeout_ms !== undefined) {
    timeout_ms = Number(input.timeout_ms);
    if (!Number.isFinite(timeout_ms)) throw new ValidationError('timeout_ms must be a number');
    if (timeout_ms < config.min_timeout_ms || timeout_ms > config.max_timeout_ms) {
      throw new ValidationError(`timeout_ms must be between ${config.min_timeout_ms} and ${config.max_timeout_ms}`);
    }
    timeout_ms = Math.floor(timeout_ms);
  }

  const request = { prompt, mode, cwd, workspace_key: workspaceKey(cwd, platform), model, fallback_models: Object.freeze(fallback_models), timeout_ms };
  for (const key of ['variant', 'session_id']) {
    if (input[key] !== undefined) {
      if (!isSafeArg(input[key])) throw new ValidationError(`${key} has an invalid format`);
      request[key] = input[key];
    }
  }
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('title must be a non-empty string');
    request.title = input.title.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  if (input.idempotency_key !== undefined) {
    const k = input.idempotency_key;
    if (typeof k !== 'string' || !k.trim() || k.length > 200) throw new ValidationError('idempotency_key must be a 1-200 char string');
    request.idempotency_key = k;
  }
  if (platform === 'win32' && config.prompt_via_argv && prompt.length > 30_000) {
    throw new ValidationError('prompt too long for the Windows command line; unset OPENCODE_MCP_PROMPT_ARGV so it goes over stdin');
  }
  return Object.freeze(request);
}

function rejectUnknown(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('arguments must be an object');
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new ValidationError(`unknown field: ${key}`);
}

/** New tools (opencode_run, opencode_run_sync). Default mode: ask. */
export function normalizeRun(input, config, { platform = process.platform, defaultCwd = process.cwd() } = {}) {
  rejectUnknown(input, RUN_FIELDS);
  return build(input, config, { mode: input.mode ?? 'ask', platform, defaultCwd });
}

/** Legacy opencode_ask: allow_edits true -> edit, otherwise ask. */
export function normalizeLegacyAsk(input, config, { platform = process.platform, defaultCwd = process.cwd() } = {}) {
  rejectUnknown(input, LEGACY_FIELDS);
  if (input.allow_edits !== undefined && typeof input.allow_edits !== 'boolean') throw new ValidationError('allow_edits must be a boolean');
  const { allow_edits, ...rest } = input;
  return build(rest, config, { mode: allow_edits ? 'edit' : 'ask', platform, defaultCwd });
}

/** Stable identity of a request for idempotency comparison (excludes idempotency_key). */
export function requestKey(request) {
  const { idempotency_key, ...rest } = request;
  const sorted = {};
  for (const key of Object.keys(rest).sort()) sorted[key] = rest[key];
  return JSON.stringify(sorted);
}

/** JSON.parse that tolerates raw control characters inside strings. */
export function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}
