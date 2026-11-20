// MCP tool definitions and handlers. Job store, model catalogue and config are injected.
// opencode_ask, opencode_models and opencode_status keep their v1 contracts and text output.

import { normalizeRun, normalizeLegacyAsk, TERMINAL_STATES, RETRYABLE_CATEGORIES, ValidationError, PLAN_NEXT_PROMPT, envHint } from './contracts.mjs';

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const isTerminal = (view) => TERMINAL_STATES.includes(view?.state);

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n\n[output truncated at ${max} chars]` : s;
}

function requireJobId(args) {
  const id = args?.job_id;
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) throw new ValidationError('job_id must be a job id returned by opencode_run');
  return id.toLowerCase();
}

const MAX_LISTED_FILES = 30;

function summarizeChanges(changes) {
  if (!changes) return null;
  const limits = changes.limitations?.length ? `; ${changes.limitations.join('; ')}` : '';
  if (changes.changes_detected === null) return `unknown (${changes.coverage}${limits})`;
  if (!changes.changes_detected) return `none observed (${changes.coverage}${limits})`;
  const files = changes.files || [];
  const more = files.length > MAX_LISTED_FILES ? `, and ${files.length - MAX_LISTED_FILES} more (run \`git status\` in cwd for the full list)` : '';
  return `${files.length} file(s) changed during the job (${changes.coverage}${limits}): ${files.slice(0, MAX_LISTED_FILES).join(', ')}${more}`;
}

function withEnvHint(text) {
  const hint = envHint();
  return hint ? `${text} ${hint}` : text;
}

function formatAttempts(attempts = []) {
  return attempts
    .map((t) => `${t.model} → ${t.category}${t.retry_after_ms ? ` (retry after ${Math.round(t.retry_after_ms / 1000)}s)` : ''} [${fmtMs(t.elapsed_ms)}]`)
    .join('; ');
}

/** What the caller should do next, or null. Text line and `next_step` in structuredContent. */
export function nextStep(view) {
  const r = view.result || {};
  if (!isTerminal(view)) return `The job is ${view.state}. Call opencode_wait (blocks up to ~90 s) or opencode_status with this job_id.`;
  const sid = r.session_id || view.session_id;
  if (view.state === 'done' && view.mode === 'plan') {
    return (
      `Show the plan to the user. After they approve, call opencode_run with mode "edit", session_id "${sid}", ` +
      `model "${r.model_used || view.model}" and a prompt such as "${PLAN_NEXT_PROMPT}" Do not implement without approval.`
    );
  }
  if (view.state === 'done' && view.mode === 'ask' && r.changes?.changes_detected) {
    return 'Files changed while this read-only job ran (possibly by someone else). Tell the user and show `git diff`; do not revert automatically.';
  }
  const lastAttempt = (r.attempts || [])[r.attempts?.length - 1];
  if (view.state === 'failed' && view.mode === 'edit' && lastAttempt?.tool_calls > 0 && RETRYABLE_CATEGORIES.includes(r.failure_reason)) {
    return 'Fallback was stopped because the failed attempt may already have changed files. Inspect `git diff` before retrying.';
  }
  switch (r.failure_reason) {
    case 'rate_limited':
    case 'quota_exhausted':
    case 'unavailable':
    case 'server_error':
      return 'Every candidate model failed with an availability error. Retry later or pass other fallback_models (see opencode_models).';
    case 'model_unavailable':
      return 'The model is not available on the gateway. Pick another one from opencode_models.';
    case 'auth_required':
      return withEnvHint('Authentication failed. Check the API key of this provider in the opencode config.');
    case 'launch_failed':
      return withEnvHint('opencode could not be started. Run `node opencode-mcp.mjs doctor` on this machine.');
    case 'timeout':
      return sid ? `The attempt timed out. Continue with session_id "${sid}" or retry with a larger timeout_ms.` : 'The attempt timed out; retry with a larger timeout_ms.';
    default:
      return null;
  }
}

/** Text for the new tools. */
export function formatJobView(view, notes = []) {
  const r = view.result || {};
  const lines = [`job_id: ${view.job_id}`];
  let state = `state: ${view.state}`;
  if (r.failure_reason) state += ` (${r.failure_reason})`;
  if (r.partial) state += ' [partial]';
  lines.push(state);
  const meta = [`mode: ${view.mode}`];
  const sid = r.session_id || view.session_id;
  if (sid) meta.push(`session_id: ${sid}`);
  if (r.model_used || view.model) meta.push(`model: ${r.model_used || view.model}`);
  meta.push(`elapsed: ${fmtMs(view.elapsed_ms)}`);
  lines.push(meta.join(' | '));
  if (view.cwd) lines.push(`cwd: ${view.cwd}`);
  if (r.text_truncated) lines.push(`response: truncated to ${String(r.text).length} characters (raise OPENCODE_MCP_MAX_OUTPUT for more)`);
  if (r.attempts?.length) lines.push(`attempts: ${formatAttempts(r.attempts)}`);
  if (r.error) lines.push(`error: ${r.error}`);
  const changes = summarizeChanges(r.changes);
  if (changes) lines.push(`changes: ${changes}`);
  for (const note of notes) lines.push(`note: ${note}`);
  const next = nextStep(view);
  if (next) lines.push(`next: ${next}`);
  if (r.text) lines.push('', `--- response${r.text_truncated ? ' [truncated]' : ''} ---`, String(r.text).trimEnd());
  return lines.join('\n');
}

/** v1 opencode_ask output: status header, then the worker output. */
export function formatLegacy(view, notes = [], maxChars = 120_000) {
  const r = view.result || {};
  if (!isTerminal(view)) {
    return [
      'status: running',
      `category: ${view.state}`,
      `job_id: ${view.job_id}`,
      '',
      `opencode is still running. It keeps running in the background; call opencode_wait or opencode_status with job_id "${view.job_id}".`,
    ].join('\n');
  }
  const ok = view.state === 'done';
  const attempts = r.attempts || [];
  const header = [
    `status: ${ok ? 'ok' : 'error'}`,
    `category: ${ok ? 'ok' : r.failure_reason || view.state}`,
    `model_used: ${r.model_used || view.model || '?'}`,
    `attempts: ${formatAttempts(attempts) || '(none)'}`,
    `elapsed: ${fmtMs(attempts.length ? attempts.reduce((s, t) => s + (t.elapsed_ms || 0), 0) : view.elapsed_ms)}`,
  ];
  const sid = r.session_id || view.session_id;
  if (sid) header.push(`session_id: ${sid}`);
  header.push(`job_id: ${view.job_id}`);
  const changes = summarizeChanges(r.changes);
  if (changes && (view.mode === 'edit' || r.changes?.changes_detected)) header.push(`changes: ${changes}`);
  for (const note of notes) header.push(`note: ${note}`);
  const body = r.text || r.error || '(opencode produced no output)';
  return `${header.join('\n')}\n\n${clip(body, maxChars)}`;
}

const RUN_PROPERTIES = {
  prompt: {
    type: 'string',
    description:
      'The full instruction. opencode has no memory of this conversation: include the absolute project root, file paths, decisions made, and the answer shape you want.',
  },
  mode: {
    type: 'string',
    enum: ['plan', 'ask', 'edit'],
    default: 'ask',
    description:
      'ask: read-only agent (edit, shell and subagent tools disabled). plan: same read-only agent, answers with an implementation plan and returns session_id; ' +
      'continue that session with mode edit after the user approves. edit: may change files and run commands (--auto). Default ask.',
  },
  model: { type: 'string', description: 'provider/model, e.g. ai-hub/cx/gpt-6.1-terra. Required unless OPENCODE_MCP_MODEL is set. See opencode_models.' },
  fallback_models: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Ordered provider/model ids to try when an attempt fails for an availability reason (429, quota, 5xx, model unavailable). ' +
      'Never used for task failures, and in edit mode not after the failed attempt used a tool.',
  },
  cwd: { type: 'string', description: 'Absolute directory to run in. Defaults to the server process working directory.' },
  timeout_ms: { type: 'number', description: 'Per-attempt timeout in ms (10 s to 2 h). Default 600000.' },
  variant: { type: 'string', description: 'Provider-specific reasoning effort passed as --variant (e.g. high, max, minimal).' },
  session_id: { type: 'string', description: 'opencode session id to continue, e.g. a plan job\'s session_id with mode edit.' },
  title: { type: 'string', description: 'Session title. Defaults to the first line of the prompt.' },
  idempotency_key: { type: 'string', description: 'Retry-safe start: the same key with the same request returns the existing job.' },
};
const JOB_ID_SCHEMA = { job_id: { type: 'string', description: 'Job id returned by opencode_run or opencode_run_sync.' } };
const RUN_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * deps:
 *   config                       from loadConfig()
 *   getStore({need_launch})      -> Promise<JobStore>
 *   models                       {list, candidates} from createModels()
 */
export function createTools({ config, getStore, models }) {
  const clampWait = (ms) => {
    const n = Number(ms);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, config.sync_wait_ms) : config.sync_wait_ms;
  };
  const collect = async (store, view) => {
    if (isTerminal(view)) await store.markCollected(view.job_id);
    return view;
  };
  const withCatalogue = async (request) => {
    const c = await models.candidates(request);
    return { request: Object.freeze({ ...request, model: c.model, fallback_models: Object.freeze(c.fallback_models) }), notes: c.notes };
  };
  const jobResult = (view, notes = []) => {
    const next = nextStep(view);
    const structured = { ...view, ...(next ? { next_step: next } : {}), ...(notes.length ? { notes } : {}) };
    return { content: [{ type: 'text', text: formatJobView(view, notes) }], structuredContent: structured };
  };

  return [
    {
      definition: {
        name: 'opencode_ask',
        description:
          'Ask opencode (a separate coding agent run via AI Hub) to answer a question, review code, investigate a codebase, or implement changes, and wait for the answer. ' +
          'Read-only by default: a dedicated agent without edit, shell or subagent tools that ignores the project opencode config; set allow_edits to let it change files and run commands. ' +
          'Every call is a fresh session unless session_id is given. The model is validated against the catalogue; on availability errors (rate limit, quota, overloaded, 5xx, model unavailable) ' +
          'it tries fallback_models in order. Task failures never trigger fallback. The reply starts with a status header (status, category, model_used, attempts, elapsed) followed by the worker output. ' +
          'For long work prefer opencode_run (background job).',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: RUN_PROPERTIES.prompt,
            cwd: RUN_PROPERTIES.cwd,
            model: RUN_PROPERTIES.model,
            fallback_models: RUN_PROPERTIES.fallback_models,
            allow_edits: {
              type: 'boolean',
              description: 'Let opencode change files and run commands (--auto). Default false: read-only. Refused while another editing job runs in the same repository.',
            },
            timeout_ms: RUN_PROPERTIES.timeout_ms,
            variant: RUN_PROPERTIES.variant,
            session_id: RUN_PROPERTIES.session_id,
            title: RUN_PROPERTIES.title,
          },
          required: ['prompt'],
        },
        annotations: { title: 'Ask opencode and wait', ...RUN_ANNOTATIONS },
      },
      handler: async (args, { signal }) => {
        const { request, notes } = await withCatalogue(normalizeLegacyAsk(args, config));
        const store = await getStore({ need_launch: true });
        let view = await store.start(request);
        const budget = request.timeout_ms * (1 + request.fallback_models.length) + 30_000;
        if (!isTerminal(view)) view = await store.wait(view.job_id, { wait_ms: budget, signal });
        await collect(store, view);
        return { content: [{ type: 'text', text: formatLegacy(view, notes, config.max_output_chars) }], isError: isTerminal(view) && view.state !== 'done' };
      },
    },
    {
      definition: {
        name: 'opencode_run',
        description:
          'Start an opencode job in the background and return its job_id (and session_id) immediately. Collect it with opencode_wait or opencode_status. ' +
          'Modes: plan (read-only, returns a plan to approve), ask (read-only), edit (can change files).',
        inputSchema: { type: 'object', properties: RUN_PROPERTIES, required: ['prompt'], additionalProperties: false },
        annotations: { title: 'Start opencode job', ...RUN_ANNOTATIONS },
      },
      handler: async (args) => {
        const { request, notes } = await withCatalogue(normalizeRun(args, config));
        const view = await (await getStore({ need_launch: true })).start(request);
        return jobResult(view, notes);
      },
    },
    {
      definition: {
        name: 'opencode_run_sync',
        description: 'Start an opencode job and wait inline up to wait_ms (capped at about 90 s). Returns the result, or a running job_id for opencode_wait.',
        inputSchema: {
          type: 'object',
          properties: { ...RUN_PROPERTIES, wait_ms: { type: 'number', description: 'Max inline wait in ms (capped by the server, default about 90 s).' } },
          required: ['prompt'],
          additionalProperties: false,
        },
        annotations: { title: 'Run opencode job and wait', ...RUN_ANNOTATIONS },
      },
      handler: async (args, { signal }) => {
        const { wait_ms, ...rest } = args;
        const { request, notes } = await withCatalogue(normalizeRun(rest, config));
        const store = await getStore({ need_launch: true });
        let view = await store.start(request);
        if (!isTerminal(view)) view = await store.wait(view.job_id, { wait_ms: clampWait(wait_ms), signal });
        return jobResult(await collect(store, view), notes);
      },
    },
    {
      definition: {
        name: 'opencode_wait',
        description: 'Block until an opencode job finishes or wait_ms elapses (capped at about 90 s). Call again if it is still running.',
        inputSchema: {
          type: 'object',
          properties: { ...JOB_ID_SCHEMA, wait_ms: { type: 'number', description: 'Max wait in ms (capped by the server).' } },
          required: ['job_id'],
          additionalProperties: false,
        },
        annotations: { title: 'Wait for opencode job', ...READ_ANNOTATIONS },
      },
      handler: async (args, { signal }) => {
        const store = await getStore();
        return jobResult(await collect(store, await store.wait(requireJobId(args), { wait_ms: clampWait(args.wait_ms), signal })));
      },
    },
    {
      definition: {
        name: 'opencode_cancel',
        description: 'Cancel an opencode job (kills its process tree). Asynchronous; check opencode_status afterwards.',
        inputSchema: { type: 'object', properties: JOB_ID_SCHEMA, required: ['job_id'], additionalProperties: false },
        annotations: { title: 'Cancel opencode job', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      handler: async (args) => jobResult(await (await getStore()).cancel(requireJobId(args))),
    },
    {
      definition: {
        name: 'opencode_status',
        description:
          'With job_id: state and result of that job. Without: list opencode jobs still in flight (include_completed for recent finished ones). ' +
          'Use after a timeout or lost connection before starting another editing run.',
        inputSchema: {
          type: 'object',
          properties: {
            ...JOB_ID_SCHEMA,
            include_completed: { type: 'boolean', description: 'Also list finished jobs (newest first).' },
            limit: { type: 'number', description: 'Max jobs to list (default 20).' },
          },
        },
        annotations: { title: 'opencode job status', ...READ_ANNOTATIONS },
      },
      handler: async (args) => {
        const store = await getStore();
        if (args.job_id !== undefined) return jobResult(await collect(store, await store.status(requireJobId(args))));
        const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit) || 20)));
        const { jobs } = await store.list({ limit, include_completed: Boolean(args.include_completed) });
        const text = jobs.length
          ? jobs
              .map((j) => `${j.job_id} ${j.state} mode=${j.mode} model=${j.result?.model_used || j.model || '?'} elapsed=${fmtMs(j.elapsed_ms)} cwd=${j.cwd}`)
              .join('\n')
          : args.include_completed ? 'No opencode jobs.' : 'No opencode runs in flight.';
        return { content: [{ type: 'text', text }], structuredContent: { jobs } };
      },
    },
    {
      definition: {
        name: 'opencode_models',
        description: 'List the models opencode has configured (provider/model ids), as reported by `opencode models`. Use it to pick a model or fallback list.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { type: 'string', description: 'Optional provider id to filter by (e.g. ai-hub).' },
            refresh: { type: 'boolean', description: 'Bypass the 5-minute cache and re-read the catalogue.' },
          },
        },
        annotations: { title: 'opencode models', ...READ_ANNOTATIONS },
      },
      handler: async (args) => {
        if (args.provider !== undefined && (typeof args.provider !== 'string' || !/^[\w.-]+$/.test(args.provider))) {
          throw new ValidationError('provider must be a plain provider id');
        }
        const list = await models.list({ provider: args.provider, refresh: Boolean(args.refresh) });
        const text = list.length ? list.join('\n') : args.provider ? `No models configured for provider "${args.provider}".` : 'No models configured.';
        return { content: [{ type: 'text', text }] };
      },
    },
  ];
}
