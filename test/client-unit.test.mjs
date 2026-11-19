// Claude-owned modules: contracts, MCP framing, models, hook, doctor, tool formatting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeRun, normalizeLegacyAsk, requestKey, workspaceKey, ValidationError } from '../lib/contracts.mjs';
import { createServer, RPC_ERRORS } from '../lib/mcp.mjs';
import { createModels, parseModelList } from '../lib/models.mjs';
import { hookWait, extractJobId } from '../lib/hook.mjs';
import { runDoctor, formatDoctor } from '../lib/doctor.mjs';
import { formatLegacy, formatJobView, nextStep } from '../lib/tools.mjs';

const FAKE = fileURLToPath(new URL('../fixtures/fake-opencode.mjs', import.meta.url));
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), p)));
const config = loadConfig({ OPENCODE_MCP_STATE_DIR: tmp('ocmcp-state-') });

// ---------------------------------------------------------------- contracts

test('model is required unless OPENCODE_MCP_MODEL is set', () => {
  const dir = tmp('ocmcp-c-');
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir }, config), (e) => e.code === 'model_required');
  const withDefault = loadConfig({ OPENCODE_MCP_MODEL: 'ai-hub/model-a', OPENCODE_MCP_STATE_DIR: dir });
  assert.equal(normalizeRun({ prompt: 'x', cwd: dir }, withDefault).model, 'ai-hub/model-a');
});

test('normalizeRun validates and freezes', () => {
  const dir = tmp('ocmcp-c-');
  const r = normalizeRun({ prompt: 'x', cwd: dir, model: 'ai-hub/a', fallback_models: ['ai-hub/b', 'ai-hub/a', 'ai-hub/b'], mode: 'plan' }, config);
  assert.equal(r.mode, 'plan');
  assert.deepEqual([...r.fallback_models], ['ai-hub/b']);
  assert.ok(Object.isFrozen(r));
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, model: '--auto' }, config), ValidationError);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, model: 'ai-hub/a', variant: '--auto' }, config), /variant/);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, model: 'ai-hub/a', allow_edits: true }, config), /unknown field/);
});

test('normalizeLegacyAsk maps allow_edits to modes', () => {
  const dir = tmp('ocmcp-c-');
  assert.equal(normalizeLegacyAsk({ prompt: 'x', cwd: dir, model: 'ai-hub/a' }, config).mode, 'ask');
  assert.equal(normalizeLegacyAsk({ prompt: 'x', cwd: dir, model: 'ai-hub/a', allow_edits: true }, config).mode, 'edit');
  assert.throws(() => normalizeLegacyAsk({ prompt: 'x', cwd: dir, model: 'ai-hub/a', mode: 'edit' }, config), /unknown field/);
});

test('workspaceKey finds the git root without spawning git', () => {
  const repo = tmp('ocmcp-ws-');
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'a', 'b'), { recursive: true });
  const expected = process.platform === 'win32' ? repo.toLowerCase() : repo;
  assert.equal(workspaceKey(join(repo, 'a', 'b')), expected);
  const plain = tmp('ocmcp-plain-');
  assert.equal(workspaceKey(plain), process.platform === 'win32' ? plain.toLowerCase() : plain);
});

test('requestKey ignores the idempotency key', () => {
  const dir = tmp('ocmcp-c-');
  const a = normalizeRun({ prompt: 'x', cwd: dir, model: 'ai-hub/a', idempotency_key: 'k1' }, config);
  const b = normalizeRun({ prompt: 'x', cwd: dir, model: 'ai-hub/a', idempotency_key: 'k2' }, config);
  assert.equal(requestKey(a), requestKey(b));
});

// ---------------------------------------------------------------- MCP framing

test('MCP framing: initialize, oversized frames, split UTF-8', async () => {
  const s = createServer({
    name: 't', version: '1', maxFrameChars: 200,
    tools: [{ definition: { name: 'echo', inputSchema: { type: 'object' } }, handler: async (a) => ({ content: [{ type: 'text', text: JSON.stringify(a) }] }) }],
  });
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c) => (out += c));
  const closed = new Promise((resolve) => s.serveStdio({ stdin, stdout, onClose: resolve }));
  stdin.write(`{"jsonrpc":"2.0","id":2,"method":"ping","pad":"${'x'.repeat(300)}"}\n`); // oversized, newline-terminated
  const msg = Buffer.from('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"s":"✓é"}}}\n');
  stdin.write(msg.subarray(0, 70));
  stdin.write(msg.subarray(70));
  stdin.end();
  await closed;
  const frames = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(frames.some((f) => f.error?.code === RPC_ERRORS.PARSE && /too large/.test(f.error.message)));
  assert.ok(!frames.some((f) => f.id === 2), 'oversized frame must not be dispatched');
  assert.equal(frames.find((f) => f.id === 3).result.content[0].text, '{"s":"✓é"}');
});

// ---------------------------------------------------------------- models

function fakeProbe(env = {}) {
  const calls = [];
  const probe = async (kind, { provider } = {}) => {
    calls.push(kind);
    const args = kind === 'version' ? ['--version'] : ['models', ...(provider ? [provider] : [])];
    const r = spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
    return { exit_code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { probe, calls };
}

test('models: catalogue, provider filter, candidates', async () => {
  assert.deepEqual(parseModelList('noise\nai-hub/a\nai-hub/a\nfoo\n'), ['ai-hub/a']);
  const { probe, calls } = fakeProbe();
  const m = createModels({ getLaunch: async () => ({}), probeOpenCode: probe });
  assert.ok((await m.list()).includes('ai-hub/model-a'));
  await m.list();
  assert.equal(calls.length, 1, 'cached');
  assert.deepEqual(await m.list({ provider: 'other' }), ['other/model-x']);
  const c = await m.candidates({ model: 'ai-hub/nope', fallback_models: ['ai-hub/model-b', 'ai-hub/model-c'] });
  assert.equal(c.model, 'ai-hub/model-b');
  assert.deepEqual(c.fallback_models, ['ai-hub/model-c']);
  assert.match(c.notes[0], /ai-hub\/nope/);
  await assert.rejects(m.candidates({ model: 'ai-hub/nope', fallback_models: [] }), (e) => e.code === 'model_unavailable');
});

// ---------------------------------------------------------------- hook

function makeJob(stateDir, state, { collected = false } = {}) {
  const id = randomUUID();
  const dir = join(stateDir, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), '{}');
  if (state) writeFileSync(join(dir, 'result.json'), JSON.stringify({ job_id: id, state, mode: 'edit', result: state === 'failed' ? { failure_reason: 'rate_limited' } : {} }));
  if (collected) writeFileSync(join(dir, 'collected'), '');
  return id;
}

test('hook: wake, collected, still running', async () => {
  const stateDir = tmp('ocmcp-hook-');
  const payload = (id) => ({ tool_response: [{ type: 'text', text: `job_id: ${id}` }] });
  assert.equal(extractJobId({ tool_response: { structuredContent: { job_id: 'ABCDEF01-0000-4000-8000-000000000000' } } }), 'abcdef01-0000-4000-8000-000000000000');
  const failed = makeJob(stateDir, 'failed');
  const r1 = await hookWait(payload(failed), { state_dir: stateDir, grace_ms: 30, poll_ms: 10 });
  assert.equal(r1.exit_code, 2);
  assert.match(r1.stderr, /finished: failed \(rate_limited\).*opencode_status/);
  const collected = makeJob(stateDir, 'done', { collected: true });
  assert.equal((await hookWait(payload(collected), { state_dir: stateDir, grace_ms: 30, poll_ms: 10 })).exit_code, 0);
  const running = makeJob(stateDir, null);
  const r3 = await hookWait(payload(running), { state_dir: stateDir, timeout_ms: 80, poll_ms: 10 });
  assert.equal(r3.exit_code, 2);
  assert.match(r3.stderr, /still running/);
  assert.equal((await hookWait(payload(randomUUID()), { state_dir: stateDir })).exit_code, 0);
});

// ---------------------------------------------------------------- doctor

test('doctor: healthy, missing default model, missing binary', async () => {
  const { probe } = fakeProbe();
  const launch = async () => ({ file: process.execPath, argsPrefix: [FAKE], source: 'env' });
  const ok = await runDoctor({ config: loadConfig({ OPENCODE_MCP_MODEL: 'ai-hub/model-a', OPENCODE_MCP_STATE_DIR: tmp('ocmcp-d-') }), resolveLaunch: launch, probeOpenCode: probe });
  assert.equal(ok.ok, true, formatDoctor(ok));
  const unset = await runDoctor({ config, resolveLaunch: launch, probeOpenCode: probe });
  assert.equal(unset.checks.find((c) => c.name === 'default model').status, 'warn');
  const bad = await runDoctor({ config: loadConfig({ OPENCODE_MCP_MODEL: 'ai-hub/dead', OPENCODE_MCP_STATE_DIR: tmp('ocmcp-d-') }), resolveLaunch: launch, probeOpenCode: probe });
  assert.equal(bad.ok, false);
  const missing = await runDoctor({
    config,
    resolveLaunch: async () => {
      throw Object.assign(new Error('opencode not found'), { code: 'launch_failed', searched: ['/x/opencode'] });
    },
    probeOpenCode: probe,
  });
  assert.equal(missing.ok, false);
  assert.match(formatDoctor(missing), /\/x\/opencode/);
});

// ---------------------------------------------------------------- formatting

const doneView = {
  job_id: randomUUID(), state: 'done', mode: 'plan', cwd: '/r', created_at: 0, elapsed_ms: 2500, model: 'ai-hub/a',
  result: { text: 'Plan: do X', partial: false, model_used: 'ai-hub/b', session_id: 'ses_1', attempts: [{ model: 'ai-hub/a', category: 'rate_limited', elapsed_ms: 300, tool_calls: 0 }, { model: 'ai-hub/b', category: 'ok', elapsed_ms: 2000, tool_calls: 0 }] },
};

test('legacy opencode_ask text keeps the v1 header', () => {
  const t = formatLegacy(doneView);
  assert.match(t, /^status: ok\ncategory: ok\nmodel_used: ai-hub\/b\nattempts: ai-hub\/a → rate_limited \[300ms\]; ai-hub\/b → ok \[2\.0s\]\nelapsed: 2\.3s\n/);
  assert.match(t, /\n\nPlan: do X$/);
  const failed = formatLegacy({ ...doneView, state: 'failed', result: { ...doneView.result, failure_reason: 'rate_limited', text: '' , error: 'Too Many Requests' } });
  assert.match(failed, /^status: error\ncategory: rate_limited/);
});

test('plan results carry an approval next step', () => {
  assert.match(nextStep(doneView), /mode "edit", session_id "ses_1"/);
  assert.match(formatJobView(doneView), /next: Show the plan/);
  const edit = { ...doneView, mode: 'edit', state: 'failed', result: { ...doneView.result, failure_reason: 'rate_limited', attempts: [{ model: 'ai-hub/a', category: 'rate_limited', elapsed_ms: 1, tool_calls: 2 }] } };
  assert.match(nextStep(edit), /may already have changed files/);
});
