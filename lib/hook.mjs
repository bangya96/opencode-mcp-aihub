// Claude Code completion wake: `node opencode-mcp.mjs hook-wait` runs as an async PostToolUse hook
// (asyncRewake: true) after opencode_run / opencode_run_sync. It waits for the job and exits 2 so
// Claude is woken with the stderr line, unless a tool already returned the outcome (`collected`).
// Internal errors exit 0 so the observed tool call is never disrupted. Reads the disk contract
// directly (PLAN.md), so it does not depend on the job store implementation.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL_STATES } from './contracts.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const JOB_ID_RE = new RegExp(`job_id[\\\\"'\\s]*[:=][\\\\"'\\s]*(${UUID})`, 'i');

export function extractJobId(payload) {
  const haystack = JSON.stringify(payload?.tool_response ?? payload ?? '');
  const m = JOB_ID_RE.exec(haystack);
  return m ? m[1].toLowerCase() : null;
}

function readTerminal(dir) {
  for (const file of ['result.json', 'status.json']) {
    try {
      const view = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (TERMINAL_STATES.includes(view?.state)) return view;
    } catch {
      // missing or mid-write
    }
  }
  return null;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function hookWait(payload, { state_dir, timeout_ms = 3_600_000, poll_ms = 250, grace_ms = 1000, signal } = {}) {
  const silent = { exit_code: 0, stderr: '' };
  try {
    const jobId = extractJobId(payload);
    if (!jobId || !state_dir) return silent;
    const dir = join(state_dir, 'jobs', jobId);
    if (!existsSync(join(dir, 'meta.json'))) return silent;

    const who = payload?.agent_type ? ` (started by subagent "${payload.agent_type}")` : '';
    const deadline = Date.now() + timeout_ms;
    for (;;) {
      const view = readTerminal(dir);
      if (view) {
        const collected = () => existsSync(join(dir, 'collected'));
        const graceEnd = Date.now() + grace_ms;
        while (!collected() && Date.now() < graceEnd && !signal?.aborted) await sleep(Math.min(poll_ms, 100), signal);
        if (collected()) return silent;
        const reason = view.result?.failure_reason ? ` (${view.result.failure_reason})` : '';
        const mode = view.mode ? ` ${view.mode}` : '';
        return {
          exit_code: 2,
          stderr: `opencode:${mode} job ${jobId}${who} finished: ${view.state}${reason}. Call opencode_status with job_id "${jobId}" to read the result.`,
        };
      }
      if (signal?.aborted) {
        return { exit_code: 2, stderr: `opencode: wait interrupted for job ${jobId}${who}; it may still be running. Call opencode_wait or opencode_status with job_id "${jobId}".` };
      }
      if (Date.now() >= deadline) {
        return { exit_code: 2, stderr: `opencode: job ${jobId}${who} is still running after ${Math.round(timeout_ms / 60_000)} min. Call opencode_wait or opencode_status with job_id "${jobId}".` };
      }
      await sleep(poll_ms, signal);
    }
  } catch {
    return silent;
  }
}
