#!/usr/bin/env node
// Minimal stdio MCP server exposing opencode as a tool.
// Dependency-free: speaks JSON-RPC 2.0 over newline-delimited stdin/stdout.
// stdout is reserved for protocol frames — never log to it (use debug()).
// Runs on macOS, Linux and Windows.
//
// Tools:
//   opencode_ask     run `opencode run` with a prompt; optional in-MCP fallback
//                    across models for availability errors (429/quota/5xx/…)
//   opencode_models  list the models opencode currently has configured
//   opencode_status  list runs still in flight (useful after a timeout)
//
// Env:
//   OPENCODE_MCP_MODEL        default model (provider/model)
//   OPENCODE_MCP_TIMEOUT_MS   default per-attempt timeout (ms)
//   OPENCODE_MCP_BIN          opencode binary (default: "opencode", looked up on
//                             PATH and then in the usual install locations)
//   OPENCODE_MCP_MAX_OUTPUT   max chars returned per run (default 120000)
//   OPENCODE_MCP_PROMPT_ARGV  1 = pass the prompt as a command-line argument
//                             instead of stdin (old behaviour; subject to the
//                             32 767-char command-line limit on Windows)
//   OPENCODE_MCP_DEBUG=1      log to stderr

import { spawn } from 'node:child_process';
import { statSync, accessSync, readdirSync, realpathSync, constants as FS } from 'node:fs';
import { dirname, join, isAbsolute, delimiter, basename, sep } from 'node:path';
import { homedir } from 'node:os';

const IS_WIN = process.platform === 'win32';
const HOME = homedir();
const EXE = IS_WIN ? '.exe' : '';
// The npm package `opencode-ai` is a JS launcher; the real binary lives in a
// per-platform package next to it (opencode-darwin-arm64, opencode-windows-x64, …).
const PLATFORM_PKG = `opencode-${IS_WIN ? 'windows' : process.platform}-${process.arch}`;

const OPENCODE_BIN_RAW = process.env.OPENCODE_MCP_BIN || 'opencode';
const OPENCODE_BIN = OPENCODE_BIN_RAW; // display name in messages
const DEFAULT_MODEL = process.env.OPENCODE_MCP_MODEL ?? 'ai-hub/ag/gemini-3.8-flash-high';
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCODE_MCP_TIMEOUT_MS ?? 600_000);
const MAX_OUTPUT = Number(process.env.OPENCODE_MCP_MAX_OUTPUT ?? 120_000);
const PROMPT_VIA_ARGV = process.env.OPENCODE_MCP_PROMPT_ARGV === '1';
const CATALOGUE_TTL_MS = 5 * 60_000;
const KILL_GRACE_MS = 5_000;
const DEBUG = process.env.OPENCODE_MCP_DEBUG === '1';

// allow_edits=false must not depend on the user's opencode config: by default
// opencode's build agent writes files and runs shell commands without asking.
// Denying both removes those tools for the run (read, search and fetch remain).
const READ_ONLY_PERMISSION = JSON.stringify({ edit: 'deny', bash: 'deny' });

// Option values reach opencode as separate argv entries, so a value starting
// with "-" would be parsed as a flag (a variant of "--auto" would switch on
// auto-approve). Accept plain identifiers only.
const SAFE_ARG = /^[\w.:\/@+\[\]][\w.:\/@+\[\]-]*$/;
function isSafeArg(v) { return typeof v === 'string' && SAFE_ARG.test(v); }

function debug(...a) {
  if (DEBUG) process.stderr.write(`[opencode-mcp] ${a.join(' ')}\n`);
}

// ---------------------------------------------------------------- binary lookup
//
// Claude Code (especially the macOS app) starts MCP servers with a minimal PATH
// that often lacks Homebrew, nvm or the official installer's ~/.opencode/bin, so
// a bare `spawn("opencode")` fails with ENOENT. On Windows `opencode` on PATH is
// usually the npm shim opencode.cmd, which Node cannot spawn directly. So:
//   1. scan PATH ourselves (honouring PATHEXT on Windows);
//   2. then try the usual install locations for each platform;
//   3. map npm shims/launchers to the native binary they wrap;
//   4. never cache a failed lookup, so installing opencode later (or switching
//      node versions) is picked up without restarting the server.

function isExe(p) {
  try {
    if (!statSync(p).isFile()) return false;
    if (!IS_WIN) accessSync(p, FS.X_OK);
    return true;
  } catch { return false; }
}

// Expand "*" path segments (e.g. ~/.nvm/versions/node/*/bin/opencode), newest-looking first.
function glob(pattern) {
  const star = pattern.indexOf('*');
  if (star === -1) return [pattern];
  const base = pattern.slice(0, pattern.lastIndexOf(sep, star)) || sep;
  const end = pattern.indexOf(sep, star);
  const rest = end === -1 ? '' : pattern.slice(end + 1);
  let entries = [];
  try { entries = readdirSync(base); } catch { return []; }
  entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return entries.flatMap((e) => glob(join(base, e, rest)));
}

// Given an npm launcher path (…/node_modules/opencode-ai/bin/opencode, which may
// not even exist on disk), return the native binary of that install, if any.
function nativeFromNpm(launcher) {
  let real = launcher;
  try { real = realpathSync(launcher); } catch {}
  const pkgDir = dirname(dirname(real)); // …/node_modules/opencode-ai
  if (basename(pkgDir) !== 'opencode-ai') return null;
  const candidates = [
    join(pkgDir, 'node_modules', PLATFORM_PKG, 'bin', `opencode${EXE}`),
    join(dirname(pkgDir), PLATFORM_PKG, 'bin', `opencode${EXE}`), // hoisted
  ];
  if (IS_WIN) candidates.unshift(join(pkgDir, 'bin', 'opencode.exe')); // opencode-ai 1.x ships the exe here
  return candidates.find(isExe) ?? null;
}

// npm global layout: Windows keeps shims and node_modules in the prefix dir;
// POSIX keeps shims in <prefix>/bin and packages in <prefix>/lib/node_modules.
function npmLaunchersNear(shimDir) {
  const roots = IS_WIN
    ? [join(shimDir, 'node_modules')]
    : [join(shimDir, '..', 'lib', 'node_modules'), join(shimDir, 'node_modules')];
  return roots.map((r) => join(r, 'opencode-ai', 'bin', 'opencode'));
}

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const hits = [];
  for (const d of dirs) for (const ext of exts) {
    const p = join(d, name + ext.toLowerCase());
    if (isExe(p)) hits.push(p);
  }
  return hits;
}

function knownLocations() {
  if (IS_WIN) {
    const L = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local');
    const R = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');
    const P = process.env.ProgramData || 'C:\\ProgramData';
    return [
      join(HOME, '.opencode', 'bin', 'opencode.exe'),                       // official installer
      join(HOME, 'scoop', 'shims', 'opencode.exe'),
      join(HOME, 'scoop', 'apps', 'opencode', 'current', 'opencode.exe'),
      join(P, 'chocolatey', 'bin', 'opencode.exe'),
      join(L, 'Programs', 'opencode', 'opencode.exe'),
      join(HOME, '.bun', 'bin', 'opencode.exe'),
      join(R, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode'),     // npm -g, default prefix
      join(process.env.NVM_SYMLINK || 'C:\\nvm4w\\nodejs', 'node_modules', 'opencode-ai', 'bin', 'opencode'),
      join(process.env.NVM_HOME || join(L, 'nvm'), '*', 'node_modules', 'opencode-ai', 'bin', 'opencode'), // nvm-windows, every node version
      join(L, 'pnpm', 'global', '*', 'node_modules', 'opencode-ai', 'bin', 'opencode'),
      join(L, 'Volta', 'tools', 'image', 'packages', 'opencode-ai', 'bin', 'opencode'),
    ];
  }
  return [
    join(HOME, '.opencode', 'bin', 'opencode'),                              // official install script
    '/opt/homebrew/bin/opencode',                                            // Homebrew, Apple Silicon
    '/usr/local/bin/opencode',                                               // Homebrew Intel, npm -g default prefix
    '/home/linuxbrew/.linuxbrew/bin/opencode',
    join(HOME, '.local', 'bin', 'opencode'),
    join(HOME, '.bun', 'bin', 'opencode'),
    join(HOME, '.volta', 'bin', 'opencode'),
    join(HOME, '.npm-global', 'bin', 'opencode'),
    join(HOME, 'Library', 'pnpm', 'opencode'),
    join(HOME, '.local', 'share', 'pnpm', 'opencode'),
    join(HOME, '.nvm', 'versions', 'node', '*', 'bin', 'opencode'),
    join(HOME, 'Library', 'Application Support', 'fnm', 'node-versions', '*', 'installation', 'bin', 'opencode'),
    join(HOME, '.local', 'share', 'fnm', 'node-versions', '*', 'installation', 'bin', 'opencode'),
    join(HOME, '.asdf', 'shims', 'opencode'),
    '/usr/bin/opencode',
  ];
}

let resolved = null;        // { bin, viaCmd } once a real file has been found
let lastLookup = [];        // places tried in the last failed lookup, for the error message

// Returns { bin, viaCmd } or null. viaCmd=true means `bin` is a Windows .cmd/.bat
// shim that must be run through cmd.exe (only used when no native exe was found).
function resolveBin() {
  if (resolved) return resolved;
  const tried = [];
  let shim = null;

  // Something that might be opencode: a native binary, an npm launcher/shim, a symlink.
  const consider = (p) => {
    if (!isExe(p)) {
      const n = nativeFromNpm(p); // launcher path may not exist, but its install might
      if (n) return { bin: n, viaCmd: false };
      tried.push(p);
      return null;
    }
    if (IS_WIN && /\.(cmd|bat)$/i.test(p)) {
      for (const l of npmLaunchersNear(dirname(p))) {
        const n = nativeFromNpm(l);
        if (n) return { bin: n, viaCmd: false };
      }
      shim = shim || p;
      tried.push(`${p} (shim; no native binary found beside it)`);
      return null;
    }
    return { bin: nativeFromNpm(p) || p, viaCmd: false };
  };

  const raw = OPENCODE_BIN_RAW;
  const candidates = [];
  if (isAbsolute(raw) || /[\\/]/.test(raw)) {
    candidates.push(raw);
    if (IS_WIN && !/\.[a-z]+$/i.test(raw)) candidates.push(`${raw}.exe`);
  } else {
    candidates.push(...findOnPath(raw));
    if (raw === 'opencode') candidates.push(...knownLocations().flatMap(glob));
  }

  let found = null;
  for (const c of candidates) {
    found = consider(c);
    if (found) break;
  }
  if (!found && shim) found = { bin: shim, viaCmd: true };

  if (found) {
    resolved = found;
    debug(`opencode binary: ${found.bin}${found.viaCmd ? ' (via cmd.exe)' : ''}`);
  } else {
    lastLookup = tried;
    debug(`opencode binary not found; tried ${tried.length} locations`);
  }
  return found;
}

function notFoundMessage() {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean).length;
  const how = IS_WIN
    ? 'npm i -g opencode-ai, scoop install opencode, or choco install opencode'
    : 'brew install opencode, npm i -g opencode-ai, or curl -fsSL https://opencode.ai/install | bash';
  return (
    `Failed to launch ${OPENCODE_BIN}: binary not found.\n` +
    `Looked on PATH (${dirs} directories) and in:\n${lastLookup.map((p) => `  ${p}`).join('\n')}\n` +
    `Install it (${how}) or set OPENCODE_MCP_BIN to the full path of the opencode binary.`
  );
}

// Put the binary's own directory first on the child's PATH, so an npm launcher
// finds its sibling `node` even when the server itself was started without it.
function childEnv(bin) {
  const extra = [dirname(bin)];
  try { extra.push(dirname(realpathSync(bin))); } catch {}
  const current = (process.env.PATH || '').split(delimiter);
  const PATH = [...new Set([...extra, ...current])].filter(Boolean).join(delimiter);
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...process.env, [key]: PATH };
}

function spawnOpencode(r, args, opts) {
  const base = { windowsHide: true, env: childEnv(r.bin), ...opts };
  if (r.viaCmd) {
    // Last resort: run the npm .cmd shim through cmd.exe. The prompt goes over
    // stdin, so only short arguments reach the command line. Each is quoted, which
    // makes & | < > ^ literal; quotes, % and ! are removed because cmd.exe would
    // still expand %VAR% / !VAR! inside quotes (the title comes from the prompt).
    const line = [r.bin, ...args].map((s) => `"${String(s).replace(/["%!\r\n]/g, '')}"`).join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...base, windowsVerbatimArguments: true });
  }
  return spawn(r.bin, args, base);
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'opencode_ask',
    description:
      'Ask opencode (a separate coding agent run via AI Hub) to answer a question, review code, ' +
      'investigate a codebase, or implement changes. Read-only by default: it can read and search ' +
      'files, but its edit and shell tools are disabled; set allow_edits to let it change files ' +
      'and run commands. Every call is a fresh ' +
      'session with no memory of this conversation. The model is validated against the configured ' +
      'catalogue before running; on availability errors (rate limit, quota, overloaded, 5xx, model ' +
      'unavailable) it automatically tries fallback_models in order. Task-level failures (bad code, ' +
      'failing checks, missing files) never trigger fallback. The reply starts with a status header ' +
      '(status, category, model_used, attempts, elapsed) followed by the worker output.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The full instruction. opencode has no memory of this conversation, so include all ' +
            'context it needs: absolute project root, file paths, what to look at, decisions made, ' +
            'and the shape of answer you want.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute directory to run in. Defaults to the server process working directory.',
        },
        model: {
          type: 'string',
          description: `Model as provider/model. Defaults to ${DEFAULT_MODEL}. Must exist in the configured catalogue (see opencode_models).`,
        },
        fallback_models: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered provider/model IDs to try next if the previous one fails for an availability ' +
            'reason (429, quota/usage limit, overloaded, bad gateway/5xx, model unavailable or not ' +
            'configured). Duplicates and models missing from the catalogue are skipped. Not used ' +
            'for task-level errors.',
        },
        allow_edits: {
          type: 'boolean',
          description:
            'Auto-approve file modifications so opencode can write code (passes --auto). Default ' +
            'false: read-only, enforced by denying the edit and bash tools for the run. Only set true ' +
            'when the caller explicitly asked opencode to make ' +
            'changes. Refused if another editing run is already in flight in the same cwd.',
        },
        timeout_ms: {
          type: 'number',
          description: `Per-attempt timeout in ms. Defaults to ${DEFAULT_TIMEOUT_MS}. On timeout the whole opencode process group is killed and any partial output is returned.`,
        },
        variant: {
          type: 'string',
          description: 'Optional provider-specific reasoning effort passed as --variant (e.g. high, max, minimal).',
        },
        session_id: {
          type: 'string',
          description: 'Optional opencode session id to continue (passes --session). Get ids from `opencode session list`.',
        },
        title: {
          type: 'string',
          description: 'Optional session title (passes --title). Defaults to the first line of the prompt, truncated.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'opencode_models',
    description:
      'List the models opencode currently has configured (provider/model ids), as reported by ' +
      '`opencode models`. Use this to pick a valid model or fallback list before calling opencode_ask.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Optional provider id to filter by (e.g. ai-hub). Defaults to all providers.',
        },
        refresh: {
          type: 'boolean',
          description: 'Bypass the 5-minute cache and re-read the catalogue.',
        },
      },
    },
  },
  {
    name: 'opencode_status',
    description:
      'List opencode runs started by this server that are still in flight (model, cwd, edits, ' +
      'elapsed). Runs killed by timeout are not listed. Use after a timeout or lost connection ' +
      'before starting another editing run.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------- helpers

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function result(id, payload) {
  send({ jsonrpc: '2.0', id, result: payload });
}
function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
function toolText(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

// CSI sequences (ESC [ … final), OSC sequences (ESC ] … BEL/ST), stray ESC.
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

// `opencode run` prints a "> build · provider/model" banner on stderr.
function stripBanner(s) {
  return s.replace(/^\s*>\s*\S+\s*·\s*\S+\s*$/gm, '');
}

function clip(s) {
  if (s.length <= MAX_OUTPUT) return s;
  const head = Math.floor(MAX_OUTPUT * 0.7);
  const tail = MAX_OUTPUT - head;
  return `${s.slice(0, head)}\n\n[… ${s.length - MAX_OUTPUT} chars omitted by opencode-mcp (limit ${MAX_OUTPUT}) …]\n\n${s.slice(-tail)}`;
}

function fmtMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Availability-class errors: switching model can plausibly help.
const AVAILABILITY_PATTERNS = [
  { re: /\b429\b|too many requests|rate[ -]?limit/i, category: 'rate_limit' },
  { re: /usage limit|quota|credit|token allowance|insufficient (balance|funds)/i, category: 'quota' },
  { re: /overloaded|at capacity|capacity exceeded/i, category: 'unavailable' },
  { re: /model .*(not found|unavailable|disabled|does not exist|not (available|supported))|unknown model|invalid model/i, category: 'model_unavailable' },
  { re: /bad gateway|gateway time-?out|service unavailable|\b50[234]\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i, category: 'unavailable' },
  { re: /unexpected server error|internal server error|\b500\b/i, category: 'server_error' },
];

function classifyError(text) {
  for (const { re, category } of AVAILABILITY_PATTERNS) {
    if (re.test(text)) return { category, retryable: true };
  }
  return { category: 'task_error', retryable: false };
}

function parseRetryAfter(text) {
  const m = text.match(/reset(?:s)? after\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const secs = (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
    return secs ? `${secs}s` : null;
  }
  const r = text.match(/retry[- ]after[:\s]+(\d+)/i);
  return r ? `${r[1]}s` : null;
}

// ---------------------------------------------------------------- catalogue

let catalogueCache = { at: 0, models: null };
let catalogueInflight = null; // concurrent `opencode models` invocations can fail; share one read

function readCatalogue({ refresh = false } = {}) {
  if (!refresh && catalogueCache.models && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) {
    return Promise.resolve(catalogueCache.models);
  }
  if (catalogueInflight) return catalogueInflight;
  catalogueInflight = readCatalogueUncached().finally(() => { catalogueInflight = null; });
  return catalogueInflight;
}

function readCatalogueUncached() {
  return new Promise((resolve) => {
    const r = resolveBin();
    if (!r) return resolve(null);
    let child;
    try {
      child = spawnOpencode(r, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const models = stripAnsi(out)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l.includes('/') && !/\s/.test(l));
      if (models.length === 0) return resolve(null);
      catalogueCache = { at: Date.now(), models };
      resolve(models);
    });
  });
}

// ---------------------------------------------------------------- runs

const inflight = new Map(); // runId -> { model, cwd, allowEdits, startedAt, pid }
let runSeq = 0;

function killGroup(child) {
  if (IS_WIN) {
    // No process groups on Windows: taskkill /T kills the whole tree.
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { try { child.kill(); } catch {} }
    return;
  }
  // detached:true puts the child in its own process group so that any
  // helpers opencode spawns die with it instead of lingering after a timeout.
  const pgid = child.pid;
  const sig = (s) => { try { process.kill(-pgid, s); } catch { try { child.kill(s); } catch {} } };
  sig('SIGTERM');
  setTimeout(() => sig('SIGKILL'), KILL_GRACE_MS).unref();
}

function runOnce({ prompt, cwd, model, allowEdits, timeoutMs, variant, sessionId, title }) {
  return new Promise((resolve) => {
    const r = resolveBin();
    if (!r) {
      resolve({ ok: false, category: 'launch_failed', text: notFoundMessage(), elapsed: 0 });
      return;
    }

    const args = ['run', '-m', model];
    if (allowEdits) args.push('--auto');
    if (cwd) args.push(`--dir=${cwd}`); // one argv entry, so a path can never be read as a flag
    if (variant) args.push('--variant', variant);
    if (sessionId) args.push('--session', sessionId);
    args.push('--title', title);
    // The prompt normally goes over stdin (`opencode run` reads it when stdin is
    // not a TTY): no command-line length limit, no shell quoting on any platform.
    if (PROMPT_VIA_ARGV) args.push('--', prompt); // "--" so a prompt starting with "-" is not parsed as a flag

    const startedAt = Date.now();
    let child;
    try {
      child = spawnOpencode(r, args, {
        cwd: cwd || process.cwd(),
        stdio: [PROMPT_VIA_ARGV ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: allowEdits ? childEnv(r.bin) : { ...childEnv(r.bin), OPENCODE_PERMISSION: READ_ONLY_PERMISSION },
        detached: !IS_WIN, // own process group on POSIX (see killGroup); on Windows this would pop a console
      });
    } catch (err) {
      resolve({ ok: false, category: 'launch_failed', text: `Failed to launch ${OPENCODE_BIN}: ${err.message}`, elapsed: 0 });
      return;
    }

    const runId = ++runSeq;
    inflight.set(runId, { model, cwd: cwd || process.cwd(), allowEdits, startedAt, pid: child.pid });
    debug(`run#${runId} start model=${model} pid=${child.pid} cwd=${cwd || process.cwd()}`);

    if (!PROMPT_VIA_ARGV) {
      child.stdin.on('error', () => {}); // EPIPE if opencode dies before reading; reported via close/error below
      child.stdin.end(prompt, 'utf8');
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const finish = (r) => {
      clearTimeout(timer);
      inflight.delete(runId);
      debug(`run#${runId} end ok=${r.ok} category=${r.category} elapsed=${fmtMs(r.elapsed)}`);
      resolve(r);
    };

    child.on('error', (err) => {
      finish({ ok: false, category: 'launch_failed', text: `Failed to launch ${OPENCODE_BIN} (${r.bin}): ${err.message}`, elapsed: Date.now() - startedAt });
    });

    child.on('close', (code, signal) => {
      const elapsed = Date.now() - startedAt;
      const out = stripAnsi(stdout).trim();
      const err = stripBanner(stripAnsi(stderr)).trim();
      if (timedOut) {
        const partial = [out, err].filter(Boolean).join('\n');
        finish({
          ok: false,
          category: 'timeout',
          text: `opencode timed out after ${fmtMs(timeoutMs)} (process group killed).` + (partial ? `\n\nPartial output:\n${partial}` : ''),
          elapsed,
        });
        return;
      }
      if (code !== 0) {
        const combined = [out, err].filter(Boolean).join('\n');
        const { category } = classifyError(combined);
        finish({
          ok: false,
          category,
          retryAfter: parseRetryAfter(combined),
          text: `opencode exited with code ${code ?? signal}.\n${combined}`.trim(),
          elapsed,
        });
        return;
      }
      finish({ ok: true, category: 'ok', text: out || err || '(opencode produced no output)', elapsed });
    });
  });
}

async function runWithFallback(a) {
  const prompt = a.prompt;
  const cwd = a.cwd;
  const allowEdits = a.allow_edits === true;
  const timeoutMs = Number(a.timeout_ms) > 0 ? Number(a.timeout_ms) : DEFAULT_TIMEOUT_MS;
  const variant = typeof a.variant === 'string' && a.variant ? a.variant : undefined;
  const sessionId = typeof a.session_id === 'string' && a.session_id ? a.session_id : undefined;
  // A title starting with "-" would be parsed by opencode as a flag.
  const rawTitle = (typeof a.title === 'string' && a.title.trim()) || prompt.split('\n').find((l) => l.trim()) || '';
  const title = rawTitle.trim().replace(/^[-\s]+/, '').slice(0, 80) || 'opencode-mcp';
  for (const [k, v] of [['variant', variant], ['session_id', sessionId]]) {
    if (v !== undefined && !isSafeArg(v)) {
      return toolText(`status: error\ncategory: bad_argument\n\n${k} must be a plain identifier (${SAFE_ARG}) and not start with "-": ${v}`, true);
    }
  }

  if (cwd) {
    let st = null;
    try { st = statSync(cwd); } catch {}
    if (!st || !st.isDirectory()) {
      return toolText(`status: error\ncategory: bad_cwd\n\ncwd does not exist or is not a directory: ${cwd}`, true);
    }
  }

  if (allowEdits) {
    const dir = cwd || process.cwd();
    const clash = [...inflight.values()].find((r) => r.allowEdits && r.cwd === dir);
    if (clash) {
      return toolText(
        `status: error\ncategory: edit_conflict\n\nRefused: another editing run (model ${clash.model}, pid ${clash.pid}, ` +
        `running ${fmtMs(Date.now() - clash.startedAt)}) is already in flight in ${dir}. ` +
        `Wait for it or check opencode_status; overlapping editing workers corrupt each other's changes.`,
        true,
      );
    }
  }

  const requested = [typeof a.model === 'string' && a.model ? a.model : DEFAULT_MODEL];
  if (!isSafeArg(requested[0])) {
    return toolText(`status: error\ncategory: bad_argument\n\nmodel must be a plain provider/model id (${SAFE_ARG}) and not start with "-": ${requested[0]}`, true);
  }
  const notes = [];
  if (Array.isArray(a.fallback_models)) {
    for (const m of a.fallback_models) {
      if (typeof m !== 'string' || !m) continue;
      if (isSafeArg(m)) requested.push(m);
      else notes.push(`skipped (invalid id): ${m}`);
    }
  }
  const candidates = [...new Set(requested)];

  const catalogue = await readCatalogue();
  let plan = candidates;
  if (catalogue) {
    const missing = candidates.filter((m) => !catalogue.includes(m));
    plan = candidates.filter((m) => catalogue.includes(m));
    if (missing.length) notes.push(`skipped (not in catalogue): ${missing.join(', ')}`);
    if (plan.length === 0) {
      return toolText(
        `status: error\ncategory: model_not_configured\n\nNone of the requested models exist in the opencode catalogue: ${candidates.join(', ')}.\n` +
        `Configured models:\n${catalogue.map((m) => `  ${m}`).join('\n')}`,
        true,
      );
    }
  } else {
    notes.push('catalogue unavailable; model ids not validated');
  }

  const attempts = [];
  let last = null;
  for (const model of plan) {
    const r = await runOnce({ prompt, cwd, model, allowEdits, timeoutMs, variant, sessionId, title });
    attempts.push({ model, category: r.category, elapsed: r.elapsed, retryAfter: r.retryAfter });
    last = { ...r, model };
    if (r.ok) break;
    // Only availability-class failures justify trying another model. A timeout
    // on an editing run is also not retried automatically: the worker may have
    // left partial changes that need inspecting first.
    const retryable = classifyError(r.text).retryable && r.category !== 'timeout' && r.category !== 'launch_failed';
    if (!retryable) break;
    if (allowEdits && attempts.length > 0 && r.category === 'timeout') break;
  }

  const header = [
    `status: ${last.ok ? 'ok' : 'error'}`,
    `category: ${last.category}`,
    `model_used: ${last.model}`,
    `attempts: ${attempts.map((t) => `${t.model} → ${t.category}${t.retryAfter ? ` (retry after ${t.retryAfter})` : ''} [${fmtMs(t.elapsed)}]`).join('; ')}`,
    `elapsed: ${fmtMs(attempts.reduce((s, t) => s + t.elapsed, 0))}`,
    ...(notes.length ? [`notes: ${notes.join('; ')}`] : []),
  ].join('\n');

  return toolText(`${header}\n\n${clip(last.text)}`, !last.ok);
}

// ---------------------------------------------------------------- dispatch

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    result(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'opencode', version: '0.3.0' },
    });
    return;
  }

  // Notifications carry no id and expect no reply.
  if (id === undefined) return;

  if (method === 'tools/list') { result(id, { tools: TOOLS }); return; }
  if (method === 'ping') { result(id, {}); return; }

  if (method === 'tools/call') {
    const name = params?.name;
    const a = params?.arguments ?? {};

    if (name === 'opencode_ask') {
      if (!a.prompt || typeof a.prompt !== 'string') {
        failure(id, -32602, 'prompt is required and must be a string');
        return;
      }
      result(id, await runWithFallback(a));
      return;
    }

    if (name === 'opencode_models') {
      const models = await readCatalogue({ refresh: a.refresh === true });
      if (!models) {
        const why = resolved ? `\`${OPENCODE_BIN} models\` failed (binary: ${resolved.bin}).` : notFoundMessage();
        result(id, toolText(`Could not read the model catalogue. ${why}`, true));
        return;
      }
      const filtered = typeof a.provider === 'string' && a.provider
        ? models.filter((m) => m.startsWith(`${a.provider}/`))
        : models;
      result(id, toolText(filtered.length ? filtered.join('\n') : `No models configured for provider "${a.provider}".`));
      return;
    }

    if (name === 'opencode_status') {
      if (inflight.size === 0) { result(id, toolText('No opencode runs in flight.')); return; }
      const lines = [...inflight.entries()].map(([rid, r]) =>
        `run#${rid} pid=${r.pid} model=${r.model} edits=${r.allowEdits} elapsed=${fmtMs(Date.now() - r.startedAt)} cwd=${r.cwd}`);
      result(id, toolText(lines.join('\n')));
      return;
    }

    failure(id, -32602, `Unknown tool: ${name}`);
    return;
  }

  failure(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- transport

let buffer = '';
let pending = 0;      // in-flight requests
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore unparseable frames rather than crashing the server
    }
    pending++;
    handle(msg)
      .catch((err) => {
        if (msg.id !== undefined) failure(msg.id, -32603, `Internal error: ${err.message}`);
      })
      .finally(() => {
        pending--;
        maybeExit();
      });
  }
});

// Don't tear down while a tool call is still running: piped stdin ends
// immediately, and exiting here would drop the in-flight response.
process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});

// If the client dies, don't leave opencode workers orphaned.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    for (const r of inflight.values()) {
      if (IS_WIN) { try { spawn('taskkill', ['/pid', String(r.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
      else { try { process.kill(-r.pid, 'SIGTERM'); } catch {} }
    }
    process.exit(0);
  });
}
