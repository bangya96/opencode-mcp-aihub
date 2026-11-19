import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TERMINAL_STATES, requestKey } from './contracts.mjs';
import { atomicWriteJson, readJson, isAlive } from './platform.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => createHash('sha256').update(s).digest('hex');
const terminal = v => TERMINAL_STATES.includes(v?.state);
const error = (code, message = code) => Object.assign(new Error(message), { code });
const entries = async dir => fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });

// Lamport's bakery gate. Each caller owns a unique file, so reclaiming a dead
// contender never unlinks a successor's lock (including concurrent reclaimers).
export async function withStateLock(state, fn) {
  const gate = join(state, 'locks', '.admission'); await fs.mkdir(gate, { recursive: true });
  const token = randomUUID(), ownerPath = join(gate, `${token}.json`);
  await atomicWriteJson(ownerPath, { pid: process.pid, token, ticket: 0 });
  try {
    let ticket = 1;
    for (const name of await entries(gate)) {
      if (!name.endsWith('.json')) continue;
      const owner = await readJson(join(gate, name));
      if (owner && isAlive(owner.pid)) ticket = Math.max(ticket, owner.ticket + 1);
    }
    await atomicWriteJson(ownerPath, { pid: process.pid, token, ticket });
    for (;;) {
      let blocked = false;
      for (const name of await entries(gate)) {
        if (!name.endsWith('.json') || name === `${token}.json`) continue;
        const path = join(gate, name), owner = await readJson(path);
        if (!owner) continue;
        if (!isAlive(owner.pid)) { await fs.unlink(path).catch(() => {}); continue; }
        if (owner.ticket === 0 || owner.ticket < ticket || (owner.ticket === ticket && owner.token < token)) blocked = true;
      }
      if (!blocked) break;
      await sleep(20);
    }
    return await fn();
  } finally { await fs.unlink(ownerPath).catch(() => {}); }
}
export function lockNames(request) {
  return [...(request.session_id ? [`session-${hash(request.session_id)}.json`] : []), ...(request.mode === 'edit' ? [`workspace-${hash(request.workspace_key)}.json`] : [])];
}
export async function releaseLocks(state, request, job_id, token) {
  await withStateLock(state, async () => {
    for (const name of await entries(join(state, 'locks'))) {
      if (!name.endsWith('.json')) continue;
      const path = join(state, 'locks', name), lock = await readJson(path);
      if (lock?.job_id === job_id && lock.token === token) await fs.unlink(path).catch(() => {});
    }
  });
}
export function createJobStore({ config, launch }) {
  const state = resolve(config.state_dir), jobsDir = join(state, 'jobs');
  const jobPath = id => { if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw error('not_found'); return join(jobsDir, id); };
  const view = v => {
    const { pid, worker_pid, token, heartbeat_at, ...publicView } = v;
    publicView.elapsed_ms = Math.max(0, (v.finished_at ?? Date.now()) - (v.started_at ?? v.created_at)); return publicView;
  };
  const dead = v => Date.now() - (v.heartbeat_at ?? v.created_at) > 30000 && !isAlive(v.pid) && !isAlive(v.worker_pid);
  async function status(id) {
    const dir = jobPath(id);
    let current = await readJson(join(dir, 'result.json')) || await readJson(join(dir, 'status.json'));
    if (!current) throw error('not_found', `Job not found: ${id}`);
    if (!terminal(current) && dead(current)) {
      current = await readJson(join(dir, 'result.json')) || { ...view(current), state: 'failed', finished_at: Date.now(), result: { text: '', partial: true, attempts: [], failure_reason: 'interrupted', error: 'Supervisor disappeared before committing a result.' } };
      await atomicWriteJson(join(dir, 'result.json'), current); await fs.writeFile(join(dir, 'done'), '');
    }
    return view(current);
  }
  async function stale(lock) {
    const dir = jobPath(lock.job_id), running = await readJson(join(dir, 'status.json'));
    if (isAlive(running?.worker_pid)) return false;
    const current = await readJson(join(dir, 'result.json')) || running;
    return terminal(current) || dead(current || lock);
  }
  async function start(request) {
    if (!launch) throw error('launch_failed', 'opencode not found; configure OPENCODE_MCP_BIN.');
    let id;
    await withStateLock(state, async () => {
      await fs.mkdir(jobsDir, { recursive: true }); await fs.mkdir(join(state, 'idem'), { recursive: true });
      const idemPath = request.idempotency_key ? join(state, 'idem', `${hash(request.idempotency_key)}.json`) : null;
      if (idemPath) {
        const previous = await readJson(idemPath);
        if (previous && await readJson(join(jobPath(previous.job_id), 'meta.json'))) {
          if (previous.request_key !== requestKey(request)) throw error('idempotency_conflict');
          id = previous.job_id; return;
        }
      }
      const names = lockNames(request);
      for (const name of names) {
        const path = join(state, 'locks', name), lock = await readJson(path);
        if (lock && await stale(lock)) await fs.unlink(path);
        else if (lock) throw error(name.startsWith('session') ? 'busy_session' : 'busy_workspace');
      }
      let live = 0;
      for (const existing of await entries(jobsDir)) { try { if (!terminal(await status(existing))) live++; } catch (e) { if (e.code !== 'not_found') throw e; } }
      if (live >= config.max_concurrency) throw error('concurrency_limit');
      id = randomUUID(); const token = randomUUID(), created_at = Date.now(), dir = jobPath(id);
      await fs.mkdir(dir);
      const meta = { schema_version: 1, job_id: id, created_at, request, runtime: { launch, max_output_chars: config.max_output_chars, prompt_via_argv: config.prompt_via_argv } };
      const initial = { job_id: id, state: 'starting', mode: request.mode, cwd: request.cwd, created_at, elapsed_ms: 0, pid: process.pid, token, heartbeat_at: created_at, model: request.model, ...(request.session_id && { session_id: request.session_id }) };
      const acquired = [];
      try {
        await atomicWriteJson(join(dir, 'meta.json'), meta); await atomicWriteJson(join(dir, 'status.json'), initial);
        for (const name of names) { const path = join(state, 'locks', name); await fs.writeFile(path, JSON.stringify({ job_id: id, pid: process.pid, token, created_at }), { flag: 'wx', mode: 0o600 }); acquired.push(path); }
        if (idemPath) await atomicWriteJson(idemPath, { job_id: id, request_key: requestKey(request) });
        const child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), dir], { cwd: state, detached: true, stdio: 'ignore', windowsHide: true });
        await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
        await atomicWriteJson(join(dir, 'status.json'), { ...initial, pid: child.pid });
        for (const path of acquired) await atomicWriteJson(path, { job_id: id, pid: child.pid, token, created_at });
      } catch (e) {
        for (const path of acquired) await fs.unlink(path).catch(() => {});
        await atomicWriteJson(join(dir, 'result.json'), { ...view(initial), state: 'failed', finished_at: Date.now(), result: { text: '', partial: true, attempts: [], failure_reason: 'launch_failed', error: e.message } });
        await fs.writeFile(join(dir, 'done'), ''); throw e;
      }
    });
    return status(id);
  }
  async function wait(id, { wait_ms = config.sync_wait_ms, signal } = {}) {
    const until = Date.now() + wait_ms;
    for (;;) { const current = await status(id); if (terminal(current) || signal?.aborted || Date.now() >= until) return current; await sleep(Math.min(100, Math.max(0, until - Date.now()))); }
  }
  async function cancel(id) { const current = await status(id); if (!terminal(current)) await fs.writeFile(join(jobPath(id), 'cancel'), ''); return status(id); }
  async function list({ limit = 100, include_completed = false } = {}) {
    const jobs = [];
    for (const id of await entries(jobsDir)) { try { const job = await status(id); if (include_completed || !terminal(job)) jobs.push(job); } catch (e) { if (e.code !== 'not_found') throw e; } }
    jobs.sort((a, b) => b.created_at - a.created_at || b.job_id.localeCompare(a.job_id)); return { jobs: jobs.slice(0, Math.max(0, limit)) };
  }
  async function markCollected(id) { await status(id); await fs.writeFile(join(jobPath(id), 'collected'), ''); }
  async function gc() {
    return withStateLock(state, async () => {
      let removed = 0; const removedIds = new Set();
      for (const id of await entries(jobsDir)) {
        let current; try { current = await status(id); } catch (e) { if (e.code === 'not_found') continue; throw e; }
        const running = await readJson(join(jobPath(id), 'status.json'));
        if (terminal(current) && !isAlive(running?.worker_pid) && Date.now() - current.finished_at > config.job_ttl_ms) { await fs.rm(jobPath(id), { recursive: true, force: true }); removedIds.add(id); removed++; }
      }
      for (const name of await entries(join(state, 'locks'))) {
        if (!name.endsWith('.json')) continue;
        const path = join(state, 'locks', name), lock = await readJson(path);
        if (lock && (removedIds.has(lock.job_id) || await stale(lock))) await fs.unlink(path).catch(() => {});
      }
      for (const name of await entries(join(state, 'idem'))) {
        const path = join(state, 'idem', name), idem = await readJson(path);
        if (!idem || !await readJson(join(jobPath(idem.job_id), 'meta.json'))) await fs.unlink(path).catch(() => {});
      }
      return { removed };
    });
  }
  return { start, status, wait, cancel, list, markCollected, gc };
}
