import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { snapshot, compare } from '../lib/change-detection.mjs';
import { loadConfig, READ_ONLY_AGENT, PLAN_PREAMBLE } from '../lib/contracts.mjs';
import { buildInvocation, runAttempt, probeOpenCode } from '../lib/opencode.mjs';
import { createJobStore, withStateLock, lockNames } from '../lib/jobs.mjs';
import { atomicWriteJson, readJson, isAlive, killTree, resolveLaunch } from '../lib/platform.mjs';

const launch = { file: process.execPath, argsPrefix: [fileURLToPath(new URL('../fixtures/fake-opencode.mjs', import.meta.url))] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function setup(t) {
  const dir = realpathSync.native(await fs.mkdtemp(join(tmpdir(), 'oc-runtime-')));
  // Detached supervisors may still be releasing their locks when a test ends; retry the removal.
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const config = { ...loadConfig({}), state_dir: join(dir, 'state'), sync_wait_ms: 10000 };
  const request = { prompt: 'hello', mode: 'ask', cwd: dir, workspace_key: dir, model: 'ai-hub/model-a', fallback_models: [], timeout_ms: 3000 };
  return { dir, config, request, store: createJobStore({ config, launch }) };
}
async function scenario(name, fn) {
  const previous = process.env.FAKE_OC_SCENARIO; process.env.FAKE_OC_SCENARIO = name;
  try { return await fn(); } finally { if (previous === undefined) delete process.env.FAKE_OC_SCENARIO; else process.env.FAKE_OC_SCENARIO = previous; }
}

test('invocation modes, env merge, stdin/argv and safe titles', async t => {
  const { config, request } = await setup(t);
  for (const mode of ['ask', 'plan', 'edit']) for (const prompt_via_argv of [false, true]) {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { existing: {} }, theme: 'x' }) };
    const r = buildInvocation({ ...request, mode, prompt: '--unsafe\nsecond', session_id: 'ses_1', variant: 'high' }, request.model, { config: { ...config, prompt_via_argv }, env });
    const prompt = mode === 'plan' ? `${PLAN_PREAMBLE}\n\n--unsafe\nsecond` : '--unsafe\nsecond';
    assert.equal(r.stdin, prompt_via_argv ? null : prompt);
    assert.ok(r.args.includes('--title=unsafe')); assert.ok(r.args.includes('--session=ses_1'));
    if (prompt_via_argv) assert.deepEqual(r.args.slice(-2), ['--', prompt]);
    if (mode === 'edit') { assert.ok(r.args.includes('--auto')); assert.equal(r.env, env); }
    else { assert.ok(r.args.includes(`--agent=${READ_ONLY_AGENT}`)); assert.equal(JSON.parse(r.env.OPENCODE_PERMISSION).bash, 'deny'); assert.equal(JSON.parse(r.env.OPENCODE_CONFIG_CONTENT).theme, 'x'); assert.equal(JSON.parse(r.env.OPENCODE_CONFIG_CONTENT).agent[READ_ONLY_AGENT].tools.task, false); assert.equal(r.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1'); }
  }
});
test('resolve explicit scripts and missing executable; probes', async t => {
  const { dir } = await setup(t);
  assert.equal((await resolveLaunch({ bin: launch.argsPrefix[0] })).file, process.execPath);
  await assert.rejects(resolveLaunch({ bin: join(dir, 'missing.mjs') }), e => e.code === 'launch_failed' && e.searched.length > 0);
  assert.match((await probeOpenCode('version', { launch })).stdout, /1\.19\.6/);
  assert.equal((await probeOpenCode('models', { launch, provider: 'other' })).stdout.trim(), 'other/model-x');
});
test('attempt classifications, unicode, usage and malformed/truncated streams', async t => {
  const { request, config } = await setup(t);
  for (const [name, category] of [['ok', 'ok'], ['error_429', 'rate_limited'], ['quota', 'quota_exhausted'], ['auth_401', 'auth_required'], ['error_model', 'model_unavailable'], ['unknown_error', 'server_error'], ['task_error', 'task_error'], ['malformed', 'ok'], ['truncated', 'ok']]) {
    const r = await scenario(name, () => runAttempt(request, { config, launch }));
    assert.equal(r.category, category, name); assert.match(r.session_id, /^ses_/);
    if (name === 'ok') { assert.equal(r.text, 'OK from fake opencode ✓ é'); assert.equal(r.usage.input, 1000); assert.equal(r.partial, false); }
    if (name === 'task_error') assert.equal(r.retryable, false);
    if (name === 'malformed') { assert.ok(r.malformed_lines > 0); assert.equal(r.partial, false); }
    if (name === 'truncated') { assert.equal(r.partial, true); assert.equal(r.error, 'opencode exited before finishing the answer'); }
  }
  const summed = await scenario('bash_tool', () => runAttempt({ ...request, mode: 'edit' }, { config, launch }));
  assert.equal(summed.usage.input, 2000); assert.equal(summed.usage.cost, 0.002);
  for (const mode of ['edit', 'ask']) {
    const r = await scenario('tool_then_429', () => runAttempt({ ...request, mode }, { config, launch }));
    assert.equal(r.tool_calls, 1); assert.equal(r.side_effects_possible, mode === 'edit');
  }
});
test('hang timeout, abort, launch failure and descendant cleanup', async t => {
  const { request, config, dir } = await setup(t);
  const timeout = await scenario('hang', () => runAttempt({ ...request, timeout_ms: 250 }, { config, launch })); assert.equal(timeout.category, 'timeout');
  const controller = new AbortController();
  const cancelled = await scenario('hang', () => runAttempt(request, { config, launch, signal: controller.signal, on_spawn: () => setTimeout(() => controller.abort(), 100) })); assert.equal(cancelled.category, 'cancelled');
  assert.equal((await runAttempt(request, { config, launch: { file: join(dir, 'missing') } })).category, 'launch_failed');
  if (process.platform !== 'win32') {
    process.env.FAKE_OC_CHILD_PID_FILE = join(dir, 'child');
    try {
      const r = await scenario('descendant', () => runAttempt({ ...request, timeout_ms: 500 }, { config, launch })); assert.equal(r.category, 'timeout');
      const pid = Number(await fs.readFile(process.env.FAKE_OC_CHILD_PID_FILE, 'utf8'));
      for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(50);
      assert.equal(isAlive(pid), false);
    } finally { delete process.env.FAKE_OC_CHILD_PID_FILE; }
  }
});
test('store done, restart survival, idempotency, collection, list and gc', async t => {
  const { store, request, config, dir } = await setup(t);
  const req = { ...request, idempotency_key: 'same' }, job = await store.start(req);
  assert.equal((await store.start(req)).job_id, job.job_id);
  await assert.rejects(store.start({ ...req, prompt: 'different' }), { code: 'idempotency_conflict' });
  const restarted = createJobStore({ config, launch: null });
  await assert.rejects(restarted.start(request), { code: 'launch_failed' });
  const done = await restarted.wait(job.job_id); assert.equal(done.state, 'done'); assert.equal(done.result.model_used, request.model); assert.equal(done.result.attempts.length, 1); assert.ok(done.result.changes);
  assert.equal((await restarted.list({ include_completed: false })).jobs.length, 0);
  assert.equal((await restarted.list({ include_completed: true })).jobs.length, 1);
  await restarted.markCollected(job.job_id); await fs.stat(join(dir, 'state', 'jobs', job.job_id, 'collected'));
  assert.equal((await restarted.cancel(job.job_id)).state, 'done');
  await sleep(50);
  assert.equal((await createJobStore({ config: { ...config, job_ttl_ms: 1 }, launch }).gc()).removed, 1);
});
test('fallback models use fresh sessions; edit side effects stop fallback', async t => {
  const { store, request, dir } = await setup(t);
  process.env.FAKE_OC_FAIL_MODELS = request.model;
  let job;
  try { job = await store.start({ ...request, fallback_models: ['ai-hub/model-b'] }); } finally { delete process.env.FAKE_OC_FAIL_MODELS; }
  const done = await store.wait(job.job_id); assert.equal(done.state, 'done'); assert.equal(done.result.model_used, 'ai-hub/model-b');
  assert.deepEqual(done.result.attempts.map(a => a.category), ['rate_limited', 'ok']); assert.notEqual(done.result.attempts[0].session_id, done.result.attempts[1].session_id);
  const events = (await fs.readFile(join(dir, 'state', 'jobs', job.job_id, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); assert.ok(events.some(e => e.attempt === 2));
  for (const mode of ['edit', 'ask']) {
    const started = await scenario('tool_then_429', () => store.start({ ...request, mode, fallback_models: ['ai-hub/model-b'] }));
    const result = await store.wait(started.job_id); assert.equal(result.state, 'failed'); assert.equal(result.result.attempts.length, mode === 'edit' ? 1 : 2);
  }
});
test('session/workspace locks, overlapping asks, concurrency and cancellation', async t => {
  const { store, request, config } = await setup(t);
  const jobs = [];
  try {
    const edit = await scenario('hang', () => store.start({ ...request, mode: 'edit', session_id: 'ses_busy' })); jobs.push(edit);
    await assert.rejects(store.start({ ...request, session_id: 'ses_busy' }), { code: 'busy_session' });
    await assert.rejects(store.start({ ...request, mode: 'edit' }), { code: 'busy_workspace' });
    for (let i = 0; i < 2; i++) jobs.push(await scenario('hang', () => store.start(request)));
    const limited = createJobStore({ config: { ...config, max_concurrency: 3 }, launch });
    await assert.rejects(limited.start(request), { code: 'concurrency_limit' });
    assert.equal((await store.list()).jobs.length, 3);
  } finally { for (const job of jobs) { await store.cancel(job.job_id); assert.equal((await store.wait(job.job_id)).state, 'cancelled'); } }
});
test('stale supervisor retains live-worker locks and gc protection', async t => {
  const { store, request, config } = await setup(t), id = 'orphan';
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
  await new Promise((r, reject) => { child.once('spawn', r); child.once('error', reject); });
  const dir = join(config.state_dir, 'jobs', id); await fs.mkdir(dir, { recursive: true }); await fs.mkdir(join(config.state_dir, 'locks'), { recursive: true });
  const req = { ...request, mode: 'edit' }, old = Date.now() - 60000;
  await atomicWriteJson(join(dir, 'status.json'), { job_id: id, state: 'running', mode: 'edit', cwd: request.cwd, created_at: old, heartbeat_at: old, pid: 2147483647, worker_pid: child.pid });
  await atomicWriteJson(join(config.state_dir, 'locks', lockNames(req)[0]), { job_id: id, pid: 2147483647, created_at: old });
  try {
    assert.equal((await store.status(id)).state, 'running'); await assert.rejects(store.start(req), { code: 'busy_workspace' }); assert.equal((await store.gc()).removed, 0);
  } finally { await killTree(child.pid); }
  assert.equal((await store.status(id)).result.failure_reason, 'interrupted');
  const next = await store.start(req); assert.equal((await store.wait(next.job_id)).state, 'done');
});
test('admission serializes concurrent contenders and dead-owner reclamation', async t => {
  const { config } = await setup(t), gate = join(config.state_dir, 'locks', '.admission');
  await fs.mkdir(gate, { recursive: true }); await atomicWriteJson(join(gate, 'dead.json'), { pid: 2147483647, token: 'dead', ticket: 1 });
  let inside = 0, count = 0;
  await Promise.all(Array.from({ length: 15 }, () => withStateLock(config.state_dir, async () => { assert.equal(inside++, 0); await sleep(3); count++; inside--; })));
  assert.equal(count, 15); assert.equal(await readJson(join(gate, 'dead.json')), null);
  const module = new URL('../lib/jobs.mjs', import.meta.url).href;
  const code = `import {withStateLock} from ${JSON.stringify(module)}; import {promises as fs} from 'node:fs'; const state=process.argv[1]; for(let i=0;i<8;i++) await withStateLock(state,async()=>{const p=state+'/exclusive'; const h=await fs.open(p,'wx'); await new Promise(r=>setTimeout(r,3)); await h.close(); await fs.unlink(p);});`;
  await Promise.all(Array.from({ length: 5 }, () => new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, config.state_dir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error(stderr)));
  })));
});
test('git snapshots report observed mutation in edit and no mutation in ask', async t => {
  const { dir, store, request } = await setup(t);
  await new Promise((done, reject) => {
    const child = spawn('git', ['init', '--quiet', dir], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error(`git init: ${code}`)));
  });
  // Keep the persistent runtime journal out of this repository's snapshot.
  await fs.writeFile(join(dir, '.gitignore'), 'state/\n');
  const before = await snapshot([dir]); await fs.writeFile(join(dir, 'observed'), 'new');
  const changes = await compare(before, await snapshot([dir])); assert.equal(changes.changes_detected, true); assert.ok(changes.files.includes(join(dir, 'observed')));
  for (const mode of ['ask', 'edit']) {
    const job = await scenario('mutate', () => store.start({ ...request, mode })); const done = await store.wait(job.job_id);
    assert.equal(done.state, 'done'); assert.equal(done.result.changes.coverage, 'git'); assert.equal(done.result.changes.changes_detected, mode === 'edit');
  }
});
