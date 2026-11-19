#!/usr/bin/env node
// Fake `opencode` for tests. Mimics the flags and `--format json` events measured against
// opencode 1.19.6, so tests need no gateway or API key.
// Launch it as {file: process.execPath, argsPrefix: [<path to this file>]}.
//
// Env:
//   FAKE_OC_SCENARIO   ok (default) | slow | hang | descendant | mutate | tool_then_429 | error_429 |
//                      error_model | unknown_error | auth_401 | quota | malformed | truncated |
//                      task_error | bash_tool
//   FAKE_OC_FAIL_MODELS  comma-separated models that answer with a retryable 429 (fallback tests)
//   FAKE_OC_RESPONSE   answer text (default "OK from fake opencode ✓ é")
//   FAKE_OC_DELAY_MS   delay for "slow" (default 1500)
//   FAKE_OC_MUTATE_FILE  file written (relative to --dir) by "mutate" and "tool_then_429" (default fake-oc-wrote.txt)
//   FAKE_OC_CHILD_PID_FILE  where "descendant" writes its child's pid
//   FAKE_OC_ARGV_LOG   append one JSON line per run: {argv, cwd, stdin, read_only}
//   FAKE_OC_MODELS     newline-separated catalogue for `models` (default: a small ai-hub list)
//
// Read-only detection mirrors opencode: when OPENCODE_PERMISSION denies edit, or the read-only agent
// is selected, write and bash tools are refused (an "edit denied" text is answered instead).

import { randomBytes } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const env = process.env;
const argv = process.argv.slice(2);
const scenario = env.FAKE_OC_SCENARIO || 'ok';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function opt(name) {
  const prefix = `--${name}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('-') ? argv[i + 1] : undefined;
}
const has = (name) => argv.includes(`--${name}`);

const DEFAULT_MODELS = ['ai-hub/model-a', 'ai-hub/model-b', 'ai-hub/model-c', 'ai-hub/deepseek-v4.1-flash', 'other/model-x'];

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

let session = null;
let msg = `msg_${randomBytes(6).toString('hex')}`;
const now = () => Date.now();
const id = (p) => `${p}_${randomBytes(8).toString('hex')}`;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const part = (fields) => ({ id: id('prt'), messageID: msg, sessionID: session, ...fields });
const stepStart = () => out({ type: 'step_start', timestamp: now(), sessionID: session, part: part({ type: 'step-start' }) });
const stepFinish = (reason) =>
  out({
    type: 'step_finish', timestamp: now(), sessionID: session,
    part: part({ type: 'step-finish', reason, tokens: { total: 1234, input: 1000, output: 34, reasoning: 0, cache: { write: 0, read: 200 } }, cost: 0.001 }),
  });
const text = (t) => out({ type: 'text', timestamp: now(), sessionID: session, part: part({ type: 'text', text: t }) });
const tool = (name, input, output) =>
  out({ type: 'tool_use', timestamp: now(), sessionID: session, part: part({ type: 'tool', tool: name, callID: id('call'), state: { status: 'completed', input, output } }) });
const apiError = (statusCode, message, isRetryable) =>
  out({ type: 'error', timestamp: now(), sessionID: session, error: { name: 'APIError', data: { message, statusCode, isRetryable } } });

async function main() {
  if (has('version') || argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write('1.19.6\n');
    return;
  }
  if (argv[0] === 'models') {
    const list = (env.FAKE_OC_MODELS ? env.FAKE_OC_MODELS.split('\n') : DEFAULT_MODELS).filter(Boolean);
    const provider = argv[1] && !argv[1].startsWith('-') ? argv[1] : null;
    for (const m of list) if (!provider || m.startsWith(`${provider}/`)) process.stdout.write(`${m}\n`);
    return;
  }
  if (argv[0] !== 'run') {
    process.stderr.write(`fake opencode: unsupported command ${argv[0]}\n`);
    process.exitCode = 2;
    return;
  }

  const dd = argv.indexOf('--');
  const prompt = dd !== -1 ? argv.slice(dd + 1).join(' ') : await readStdin();
  const model = opt('model');
  const dir = opt('dir') || process.cwd();
  let readOnly = opt('agent') === 'opencode-mcp-readonly';
  try {
    const perm = JSON.parse(env.OPENCODE_PERMISSION || '{}');
    if (perm.edit === 'deny') readOnly = true;
  } catch {
    // ignore
  }
  session = opt('session') || id('ses');

  if (env.FAKE_OC_ARGV_LOG) {
    appendFileSync(env.FAKE_OC_ARGV_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), stdin: dd === -1 ? prompt : null, read_only: readOnly })}\n`);
  }
  if (opt('format') !== 'json') {
    process.stdout.write(`${env.FAKE_OC_RESPONSE || 'OK from fake opencode ✓ é'}\n`);
    return;
  }
  if (!prompt.trim()) {
    process.stderr.write('Error: You must provide a message or a command\n');
    process.exitCode = 1;
    return;
  }

  const failModels = (env.FAKE_OC_FAIL_MODELS || '').split(',').filter(Boolean);
  const response = env.FAKE_OC_RESPONSE || 'OK from fake opencode ✓ é';
  stepStart();

  if (failModels.includes(model)) {
    apiError(429, 'Too Many Requests: rate limit reached for this model', true);
    process.exitCode = 1;
    return;
  }

  const mutateFile = resolve(dir, env.FAKE_OC_MUTATE_FILE || 'fake-oc-wrote.txt');
  switch (scenario) {
    case 'hang':
      setInterval(() => {}, 1 << 30);
      return;
    case 'descendant': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
      if (env.FAKE_OC_CHILD_PID_FILE) writeFileSync(env.FAKE_OC_CHILD_PID_FILE, String(child.pid));
      setInterval(() => {}, 1 << 30);
      return;
    }
    case 'error_429':
      apiError(429, 'Too Many Requests', true);
      process.exitCode = 1;
      return;
    case 'quota':
      apiError(402, 'Budget exceeded: your token balance is used up', false);
      process.exitCode = 1;
      return;
    case 'error_model':
      apiError(404, 'Not Found: {"error":{"message":"No active credentials for provider","code":"model_not_found"}}', false);
      process.exitCode = 1;
      return;
    case 'auth_401':
      apiError(401, 'Unauthorized: invalid API key', false);
      process.exitCode = 1;
      return;
    case 'unknown_error':
      out({ type: 'error', timestamp: now(), sessionID: session, error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.' } } });
      process.exitCode = 1;
      return;
    case 'tool_then_429':
      if (!readOnly) writeFileSync(mutateFile, 'half-done by fake opencode\n');
      tool(readOnly ? 'read' : 'write', { filePath: mutateFile }, readOnly ? 'content' : 'written');
      stepFinish('tool-calls');
      stepStart();
      apiError(429, 'Too Many Requests', true);
      process.exitCode = 1;
      return;
    case 'task_error':
      // Exit 1 with output that mentions quota / 500 / credit: must NOT be classified as availability.
      text('Tests failed: expected status 500 from the quota endpoint, got 200; credit check broken.');
      stepFinish('stop');
      process.stderr.write('Error: task failed\n');
      process.exitCode = 1;
      return;
    case 'malformed':
      process.stdout.write('not json at all\n');
      process.stdout.write(`{"type":"text","sessionID":"${session}","part":{"type":"text","text":"line1\nline2"}}\n`);
      stepFinish('stop');
      return;
    case 'truncated':
      text('Partial answer that never finishes');
      return; // exit 0 without step_finish stop
    case 'mutate':
    case 'bash_tool':
      if (readOnly) {
        text('edit denied: this agent cannot write files or run commands');
        stepFinish('stop');
        return;
      }
      if (scenario === 'mutate') {
        writeFileSync(mutateFile, 'written by fake opencode\n');
        tool('write', { filePath: mutateFile }, 'ok');
      } else {
        tool('bash', { command: 'ls -la' }, 'total 0');
      }
      stepFinish('tool-calls');
      stepStart();
      break;
    default:
      break;
  }

  if (scenario === 'slow') await sleep(Number(env.FAKE_OC_DELAY_MS || 1500));
  // Split a multi-byte character across two writes.
  const line = Buffer.from(`${JSON.stringify({ type: 'text', timestamp: now(), sessionID: session, part: part({ type: 'text', text: response }) })}\n`);
  const cut = Math.max(1, line.indexOf(Buffer.from('✓')) + 1 || Math.floor(line.length / 2));
  process.stdout.write(line.subarray(0, cut));
  await sleep(20);
  process.stdout.write(line.subarray(cut));
  stepFinish('stop');
}

main().catch((err) => {
  process.stderr.write(`fake opencode crashed: ${err?.stack || err}\n`);
  process.exitCode = 99;
});
