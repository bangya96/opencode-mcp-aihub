import { promises as fs, existsSync, appendFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJson } from './platform.mjs';
import { releaseLocks, withStateLock, lockNames } from './jobs.mjs';
import { runAttempt } from './opencode.mjs';
import { snapshot, compare } from './change-detection.mjs';

export async function supervise(jobDir) {
  const stateDir = dirname(dirname(jobDir)), controller = new AbortController();
  let meta, current, heartbeat, poll, finishing = false, cancelled = false, writes = Promise.resolve(), sessionWrites = Promise.resolve();
  const notes = [];
  const persist = () => {
    const copy = { ...current, heartbeat_at: Date.now(), elapsed_ms: Date.now() - current.started_at };
    writes = writes.then(() => atomicWriteJson(join(jobDir, 'status.json'), copy)); return writes;
  };
  const stopTimers = () => { clearInterval(heartbeat); clearInterval(poll); };
  const checkCancel = () => { if (!finishing && existsSync(join(jobDir, 'cancel'))) { cancelled = true; controller.abort(); } };
  async function finish(result) {
    if (finishing) return;
    finishing = true; stopTimers(); await writes; await sessionWrites;
    if (await readJson(join(jobDir, 'result.json'))) return;
    const finished_at = Date.now(), { pid, worker_pid, token, heartbeat_at, ...view } = current;
    if (cancelled) { delete result.failure_reason; result.partial = true; }
    if (notes.length) result.notes = notes;
    const final = { ...view, state: cancelled ? 'cancelled' : result.failure_reason ? 'failed' : 'done', finished_at, elapsed_ms: finished_at - current.started_at, result, ...(result.session_id && { session_id: result.session_id }) };
    await atomicWriteJson(join(jobDir, 'result.json'), final); await fs.writeFile(join(jobDir, 'done'), '');
  }
  try {
    meta = await readJson(join(jobDir, 'meta.json')); if (!meta) throw new Error('Missing meta.json');
    await withStateLock(stateDir, async () => {
      current = { ...await readJson(join(jobDir, 'status.json')), state: 'running', started_at: Date.now(), pid: process.pid };
      for (const name of lockNames(meta.request)) { const lock = await readJson(join(stateDir, 'locks', name)); if (lock?.job_id !== meta.job_id || lock.token !== current.token) throw new Error('Job lock ownership lost'); }
      await persist();
    });
    heartbeat = setInterval(() => { persist().catch(() => controller.abort()); }, 5000);
    poll = setInterval(checkCancel, 100); checkCancel();
    const before = await snapshot([meta.request.cwd]);
    let eventBytes = 0, stderrBytes = 0;
    const append = (name, text, events) => {
      const buffer = Buffer.from(text), remaining = Math.max(0, 1024 * 1024 - (events ? eventBytes : stderrBytes));
      // Never leave a truncated JSON line in the event journal.
      const part = events ? (buffer.length <= remaining ? buffer : Buffer.alloc(0)) : buffer.subarray(0, remaining);
      if (part.length) appendFileSync(join(jobDir, name), part);
      if (events) eventBytes += part.length; else stderrBytes += part.length;
    };
    await fs.writeFile(join(jobDir, 'events.jsonl'), ''); await fs.writeFile(join(jobDir, 'stderr.log'), '');
    const attempts = [], seen = new Set(); let last, model_used;
    for (const model of [meta.request.model, ...meta.request.fallback_models]) {
      checkCancel(); model_used = model;
      last = await runAttempt(meta.request, {
        model, launch: meta.runtime.launch, config: meta.runtime, signal: controller.signal,
        on_spawn: pid => { current.worker_pid = pid; return persist(); },
        on_stderr: s => append('stderr.log', s, false),
        on_event: event => {
          append('events.jsonl', `${JSON.stringify({ ...event, attempt: attempts.length + 1 })}\n`, true);
          const sid = event.sessionID;
          if (!sid || seen.has(sid)) return;
          seen.add(sid); current.session_id = sid;
          sessionWrites = sessionWrites.then(() => withStateLock(stateDir, async () => {
            const name = lockNames({ mode: 'ask', session_id: sid })[0], path = join(stateDir, 'locks', name), lock = await readJson(path);
            if (lock && (lock.job_id !== meta.job_id || lock.token !== current.token)) { notes.push(`Could not acquire discovered session lock: ${sid}`); return; }
            if (!lock) await fs.writeFile(path, JSON.stringify({ job_id: meta.job_id, pid: process.pid, token: current.token, created_at: Date.now() }), { flag: 'wx', mode: 0o600 });
          })).catch(e => { notes.push(`Could not acquire discovered session lock: ${sid}: ${e.message}`); });
          persist().catch(() => controller.abort());
        },
      });
      await writes; current.worker_pid = null; await persist(); await sessionWrites;
      const { category, elapsed_ms, session_id, error, tool_calls } = last;
      attempts.push({ model, category, elapsed_ms, tool_calls, ...(session_id && { session_id }), ...(error && { error }) });
      checkCancel();
      if (cancelled || !last.retryable || (meta.request.mode === 'edit' && last.side_effects_possible)) break;
    }
    const { text, partial, usage, session_id, error } = last;
    const result = { text, partial, usage, session_id, model_used, attempts, ...(error && { error }), ...(last.category !== 'ok' && last.category !== 'cancelled' && { failure_reason: last.category }) };
    result.changes = await compare(before, await snapshot([meta.request.cwd])); checkCancel(); await finish(result);
  } catch (e) {
    controller.abort();
    if (!current && meta) current = { job_id: meta.job_id, mode: meta.request.mode, cwd: meta.request.cwd, created_at: meta.created_at, started_at: Date.now() };
    if (current) { finishing = false; await finish({ text: '', partial: true, attempts: [], failure_reason: 'unknown', error: e.message }).catch(() => {}); }
  } finally {
    stopTimers(); if (meta && current) await releaseLocks(stateDir, meta.request, meta.job_id, current.token).catch(() => {});
  }
}
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
})();
if (isMain) await supervise(resolve(process.argv[2]));
