import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { READ_ONLY_AGENT, PLAN_PREAMBLE, RETRYABLE_CATEGORIES, parseJsonLenient } from './contracts.mjs';
import { childEnv, killTree } from './platform.mjs';

export function buildInvocation(request, model, { config, env = process.env }) {
  const args = ['run', '--format=json', `--model=${model}`];
  if (request.mode === 'edit') args.push('--auto');
  else {
    args.push(`--agent=${READ_ONLY_AGENT}`);
    let content; try { content = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}'); } catch {}
    if (!content || typeof content !== 'object' || Array.isArray(content)) content = {};
    content.agent = { ...content.agent, [READ_ONLY_AGENT]: { mode: 'primary', description: 'Read-only worker started by opencode-mcp', permission: { edit: 'deny', bash: 'deny' }, tools: { write: false, edit: false, patch: false, bash: false, task: false } } };
    env = { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(content), OPENCODE_PERMISSION: JSON.stringify({ edit: 'deny', bash: 'deny' }), OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
  }
  args.push(`--dir=${request.cwd}`);
  for (const [key, flag] of [['variant', 'variant'], ['session_id', 'session']]) if (request[key]) args.push(`--${flag}=${request[key]}`);
  const title = (request.title || request.prompt.split(/\r?\n/)[0]).replace(/[\x00-\x1f\x7f]/g, ' ').trim().replace(/^-+/, '').trim().slice(0, request.title ? 120 : 60) || 'OpenCode task';
  args.push(`--title=${title}`);
  const prompt = request.mode === 'plan' ? `${PLAN_PREAMBLE}\n\n${request.prompt}` : request.prompt;
  if (config.prompt_via_argv) args.push('--', prompt);
  return { args, stdin: config.prompt_via_argv ? null : prompt, env };
}

const patterns = [
  [/\b429\b|too many requests|rate[ -]?limit/i, 'rate_limited'],
  [/usage limit|quota|credit|token allowance|insufficient (balance|funds)/i, 'quota_exhausted'],
  [/overloaded|at capacity|capacity exceeded/i, 'unavailable'],
  [/model .*(not found|unavailable|disabled|does not exist|not (available|supported))|unknown model|invalid model/i, 'model_unavailable'],
  [/bad gateway|gateway time-?out|service unavailable|\b50[234]\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i, 'unavailable'],
  [/unexpected server error|internal server error|\b500\b/i, 'server_error'],
];
function classify(e) {
  const d = e.data || {}, status = Number(d.statusCode), message = String(d.message || e.message || '');
  if (status === 429) return 'rate_limited';
  if (status === 402 || /budget|quota|credit|insufficient/i.test(message)) return 'quota_exhausted';
  if ([401, 403].includes(status)) return 'auth_required';
  if (status === 404 || /model_not_found|model .* (?:not found|unavailable)/i.test(message)) return 'model_unavailable';
  if (status === 500 || e.name === 'UnknownError') return 'server_error';
  if ([502, 503, 504].includes(status) || d.isRetryable === true) return 'unavailable';
  return 'task_error';
}
function retryAfter(text) {
  const m = text.match(/reset(?:s)? after\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m && (m[1] || m[2] || m[3])) return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
  const r = text.match(/retry[- ]after[:\s]+(\d+)/i); return r ? Number(r[1]) * 1000 : undefined;
}

async function execute(args, { launch, stdin = null, cwd, env, timeout_ms, signal, on_stdout, on_stderr, on_spawn }) {
  let stderr = '', stdout = '', timed_out = false, spawnError, killing, callbackError;
  if (signal?.aborted) return { exit_code: null, stdout, stderr };
  let child;
  try { child = spawn(launch.file, [...(launch.argsPrefix || []), ...args], { cwd, env, stdio: [stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
  catch (e) { return { exit_code: null, stdout, stderr, spawnError: e }; }
  const stop = () => { killing ||= killTree(child.pid).catch(() => {}); };
  const notify = (fn, value) => { try { const p = fn?.(value); if (p?.catch) p.catch(e => { callbackError = e; stop(); }); } catch (e) { callbackError = e; stop(); } };
  child.once('spawn', () => notify(on_spawn, child.pid));
  child.once('error', e => { spawnError = e; });
  const timer = setTimeout(() => { timed_out = true; stop(); }, timeout_ms);
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
  const output = s => { if (on_stdout) notify(on_stdout, s); else stdout = (stdout + s).slice(0, 4_000_000); };
  const diagnostic = s => { stderr = (stderr + s).slice(-65536); notify(on_stderr, s); };
  child.stdout.on('data', b => output(out.write(b))); child.stderr.on('data', b => diagnostic(err.write(b)));
  if (child.stdin) { child.stdin.on('error', e => { if (e.code !== 'EPIPE') { spawnError = e; stop(); } }); child.stdin.end(stdin); }
  const exit_code = await new Promise(done => child.once('close', done));
  output(out.end()); diagnostic(err.end()); clearTimeout(timer); signal?.removeEventListener('abort', stop); await killing;
  if (callbackError) throw callbackError;
  return { exit_code, stdout, stderr, timed_out, spawnError };
}

export async function runAttempt(request, options) {
  const { config, model = request.model, launch, signal } = options, started = Date.now();
  const invocation = buildInvocation(request, model, { config, env: childEnv(launch.file) });
  let pending = '', dropping = false, text = '', text_truncated = false, session_id, stopped = false, tool_calls = 0, errorEvent, malformed_lines = 0, oversize_lines = 0;
  const usage = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, cost: 0 };
  const line = raw => {
    if (!raw.trim()) return;
    let event; try { event = parseJsonLenient(raw); } catch { malformed_lines++; return; }
    if (!event || typeof event !== 'object') { malformed_lines++; return; }
    session_id ||= event.sessionID;
    const part = event.part || {};
    if (event.type === 'text' && typeof part.text === 'string') {
      if (text.length + part.text.length > config.max_output_chars) text_truncated = true;
      text = (text + part.text).slice(0, config.max_output_chars);
    }
    if (event.type === 'tool_use') tool_calls++;
    if (event.type === 'error') errorEvent = event.error || {};
    if (event.type === 'step_finish') {
      if (part.reason === 'stop') stopped = true;
      const t = part.tokens || {};
      for (const [k, v] of Object.entries({ input: t.input, output: t.output, reasoning: t.reasoning, cache_read: t.cache?.read, cache_write: t.cache?.write, cost: part.cost })) if (typeof v === 'number' && Number.isFinite(v)) usage[k] += v;
    }
    options.on_event?.(event);
  };
  const execution = await execute(invocation.args, { ...options, ...invocation, cwd: request.cwd, timeout_ms: request.timeout_ms, on_stdout: chunk => {
    options.on_stdout?.(chunk);
    const pieces = chunk.split('\n');
    for (let i = 0; i < pieces.length; i++) {
      if (!dropping) { pending += pieces[i]; if (Buffer.byteLength(pending) > 1024 * 1024) { pending = ''; dropping = true; oversize_lines++; } }
      if (i < pieces.length - 1) { if (!dropping) line(pending); pending = ''; dropping = false; }
    }
  } });
  if (!dropping) line(pending);
  const category = execution.spawnError ? 'launch_failed' : signal?.aborted ? 'cancelled' : execution.timed_out ? 'timeout' : errorEvent ? classify(errorEvent) : execution.exit_code !== 0 ? patterns.find(([re]) => re.test(execution.stderr))?.[1] || 'task_error' : 'ok';
  const error = category !== 'ok' ? String(execution.spawnError?.message || errorEvent?.data?.message || errorEvent?.message || execution.stderr.trim() || category).slice(0, config.max_output_chars) : !stopped ? 'opencode exited before finishing the answer' : undefined;
  const retry_after_ms = retryAfter(`${errorEvent?.data?.message || ''}\n${execution.stderr}`);
  return { text, ...(text_truncated && { text_truncated: true }), partial: !stopped, exit_code: execution.exit_code, category, retryable: RETRYABLE_CATEGORIES.includes(category), side_effects_possible: request.mode === 'edit' && tool_calls > 0, elapsed_ms: Date.now() - started, tool_calls, usage, malformed_lines, oversize_lines, ...(session_id && { session_id }), ...(error && { error }), ...(retry_after_ms !== undefined && { retry_after_ms }) };
}
export async function probeOpenCode(kind, { launch, timeout_ms = 15000, provider }) {
  if (!['version', 'models'].includes(kind)) throw new Error(`Unknown probe: ${kind}`);
  const { spawnError, ...result } = await execute(kind === 'version' ? ['--version'] : ['models', ...(provider ? [provider] : [])], { launch, timeout_ms, env: childEnv(launch.file) });
  if (spawnError) result.stderr = spawnError.message;
  return result;
}
