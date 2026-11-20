// End to end: real entry point, job store and supervisor; fake opencode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../opencode-mcp.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-opencode.mjs', import.meta.url));
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), p)));

function gitRepo() {
  const repo = tmp('ocmcp-e2e-repo-');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

// Roughly what a filtering MCP client passes a stdio server. POSIX: Hermes Agent's documented
// baseline. Windows (undocumented for Hermes): the MCP Python SDK's default inherited set.
const POSIX_BASELINE = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR'];
const WINDOWS_BASELINE = ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE'];

function filteredEnv() {
  const win = process.platform === 'win32';
  const keep = new Set(win ? WINDOWS_BASELINE : POSIX_BASELINE);
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => (win ? keep.has(k.toUpperCase()) : keep.has(k) || k.startsWith('XDG_'))),
  );
}

function startServer(extraEnv = {}, { baseEnv = process.env, stateDir: reuseState } = {}) {
  const stateDir = reuseState || tmp('ocmcp-e2e-state-');
  const env = { ...baseEnv, OPENCODE_MCP_BIN: FAKE, OPENCODE_MCP_STATE_DIR: stateDir, ...extraEnv };
  delete env.OPENCODE_MCP_MODEL;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buf = '';
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, nl)); // non-JSON on stdout fails the test
      buf = buf.slice(nl + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 60_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name, args) => {
    const m = await request('tools/call', { name, arguments: args });
    assert.ok(m.result, `no result for ${name}: ${JSON.stringify(m)}`);
    return m.result;
  };
  const close = () => new Promise((resolve) => { child.on('close', resolve); child.stdin.end(); });
  return { request, call, close, stateDir };
}

test('tools are listed, including the v1 names', async () => {
  const s = startServer();
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const names = (await s.request('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['opencode_ask', 'opencode_cancel', 'opencode_models', 'opencode_run', 'opencode_run_sync', 'opencode_status', 'opencode_wait']);
  } finally {
    await s.close();
  }
});

test('legacy opencode_ask: v1 header, fallback on 429, model_required', async () => {
  const s = startServer({ FAKE_OC_FAIL_MODELS: 'ai-hub/model-a' });
  const cwd = tmp('ocmcp-e2e-cwd-');
  try {
    const r = await s.call('opencode_ask', { prompt: 'hi', cwd, model: 'ai-hub/model-a', fallback_models: ['ai-hub/model-b'] });
    const text = r.content[0].text;
    assert.equal(r.isError, false, text);
    assert.match(text, /^status: ok\ncategory: ok\nmodel_used: ai-hub\/model-b\nattempts: ai-hub\/model-a → rate_limited \[[^\]]+\]; ai-hub\/model-b → ok/);
    assert.match(text, /OK from fake opencode ✓ é/);
    const noModel = await s.call('opencode_ask', { prompt: 'hi', cwd });
    assert.equal(noModel.isError, true);
    assert.match(noModel.content[0].text, /model_required/);
    const unknown = await s.call('opencode_ask', { prompt: 'hi', cwd, model: 'ai-hub/not-there' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /model_unavailable/);
  } finally {
    await s.close();
  }
});

test('plan then edit on the same session; read-only plan writes nothing', async () => {
  const s = startServer({ FAKE_OC_SCENARIO: 'mutate' });
  const repo = gitRepo();
  try {
    const plan = await s.call('opencode_run_sync', { prompt: 'plan it', mode: 'plan', cwd: repo, model: 'ai-hub/model-a', wait_ms: 30_000 });
    const pv = plan.structuredContent;
    assert.equal(pv.state, 'done', plan.content[0].text);
    assert.equal(existsSync(join(repo, 'fake-oc-wrote.txt')), false);
    assert.match(pv.next_step, /mode "edit", session_id "ses_/);
    const sid = pv.result.session_id;
    const edit = await s.call('opencode_run_sync', { prompt: 'The plan is approved. Implement it.', mode: 'edit', session_id: sid, cwd: repo, model: 'ai-hub/model-a', wait_ms: 30_000 });
    const ev = edit.structuredContent;
    assert.equal(ev.state, 'done', edit.content[0].text);
    assert.equal(ev.result.session_id, sid);
    assert.ok(existsSync(join(repo, 'fake-oc-wrote.txt')));
    assert.equal(ev.result.changes.changes_detected, true);
    assert.ok(ev.result.changes.files.some((f) => f.endsWith('fake-oc-wrote.txt')));
  } finally {
    await s.close();
  }
});

test('edit fallback stops after a tool call; background job, busy workspace, cancel, status list', async () => {
  const s = startServer({ FAKE_OC_SCENARIO: 'tool_then_429' });
  const repo = gitRepo();
  try {
    const r = await s.call('opencode_run_sync', { prompt: 'edit', mode: 'edit', cwd: repo, model: 'ai-hub/model-a', fallback_models: ['ai-hub/model-b'], wait_ms: 30_000 });
    const v = r.structuredContent;
    assert.equal(v.state, 'failed', r.content[0].text);
    assert.equal(v.result.attempts.length, 1, 'no fallback after side effects');
    assert.match(v.next_step, /may already have changed files/);
  } finally {
    await s.close();
  }

  const h = startServer({ FAKE_OC_SCENARIO: 'hang' });
  try {
    const started = await h.call('opencode_run', { prompt: 'hang', mode: 'edit', cwd: repo, model: 'ai-hub/model-a' });
    const id = started.structuredContent.job_id;
    const busy = await h.call('opencode_run', { prompt: 'second', mode: 'edit', cwd: repo, model: 'ai-hub/model-a' });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /busy_workspace/);
    const listed = await h.call('opencode_status', {});
    assert.ok(listed.structuredContent.jobs.some((j) => j.job_id === id));
    await h.call('opencode_cancel', { job_id: id });
    let state;
    for (let i = 0; i < 60 && state !== 'cancelled'; i++) state = (await h.call('opencode_wait', { job_id: id, wait_ms: 500 })).structuredContent.state;
    assert.equal(state, 'cancelled');
    assert.equal((await h.call('opencode_status', {})).content[0].text, 'No opencode runs in flight.');
  } finally {
    await h.close();
  }
});

// A client that reads only the text content (never structuredContent), with a filtered
// environment, that reconnects mid-job: roughly how Hermes Agent drives the server.
test('text-only client with a filtered environment: plan, poll, reconnect, edit', async () => {
  const text = (r) => r.content.map((c) => c.text).join('\n');
  const repo = gitRepo();
  let s = startServer({ FAKE_OC_SCENARIO: 'mutate' }, { baseEnv: filteredEnv() });
  const { stateDir } = s;
  let id;
  try {
    const started = text(await s.call('opencode_run', { prompt: 'plan it', mode: 'plan', cwd: repo, model: 'ai-hub/model-a' }));
    id = (started.match(/^job_id: ([0-9a-f-]{36})$/m) || [])[1];
    assert.ok(id, started);
    assert.match(started, /^next: .*opencode_wait/m);
    assert.ok(started.split('\n').includes(`cwd: ${repo}`), started);
  } finally {
    await s.close();
  }

  // Reconnect: a new server process on the same state dir finds and finishes the job.
  s = startServer({ FAKE_OC_SCENARIO: 'mutate' }, { baseEnv: filteredEnv(), stateDir });
  try {
    let done;
    for (let i = 0; i < 60 && !done; i++) {
      const t = text(await s.call('opencode_wait', { job_id: id, wait_ms: 1000 }));
      if (/^state: done/m.test(t)) done = t;
      else assert.match(t, /^state: (starting|running)/m, t);
    }
    assert.ok(done, 'plan job did not finish');
    assert.equal(existsSync(join(repo, 'fake-oc-wrote.txt')), false);
    const sid = (done.match(/session_id: (ses_\S+)/) || [])[1];
    assert.ok(sid, done);
    const body = done.indexOf('--- response');
    assert.ok(done.search(/^next: .*mode "edit", session_id "ses_/m) < body, done);

    const edit = text(await s.call('opencode_run_sync', { prompt: 'The plan is approved. Implement it.', mode: 'edit', session_id: sid, cwd: repo, model: 'ai-hub/model-a', wait_ms: 30_000 }));
    assert.match(edit, /^state: done/m, edit);
    assert.match(edit, new RegExp(`session_id: ${sid}`));
    assert.match(edit, /^changes: 1 file\(s\) changed .*fake-oc-wrote\.txt/m, edit);
  } finally {
    await s.close();
  }
});

test('error results carry readable text', async () => {
  const s = startServer({}, { baseEnv: filteredEnv() });
  try {
    const r = await s.call('opencode_status', { job_id: 'not-a-job' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /job_id/);
  } finally {
    await s.close();
  }
});
