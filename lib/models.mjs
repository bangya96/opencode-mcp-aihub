// The opencode model catalogue (`opencode models [provider]`), cached, and validation of the
// requested model plus fallbacks against it (kept from v1: missing models are skipped with a note).

import { ValidationError } from './contracts.mjs';

const TTL_MS = 5 * 60_000;
const MODEL_LINE = /^[\w.-]+\/\S+$/;

export function parseModelList(stdout) {
  return [...new Set(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => MODEL_LINE.test(l)))];
}

/**
 * getLaunch(): async, returns the opencode launch spec or throws.
 * probeOpenCode(kind, {launch, timeout_ms, provider}) -> {exit_code, stdout, stderr, timed_out?}
 */
export function createModels({ getLaunch, probeOpenCode, now = Date.now }) {
  const cache = new Map(); // provider|'' -> {at, models}
  const inflight = new Map();

  async function list({ provider, refresh = false } = {}) {
    const key = provider || '';
    const hit = cache.get(key);
    if (!refresh && hit && now() - hit.at <= TTL_MS) return hit.models;
    if (!inflight.has(key)) {
      // Concurrent `opencode models` invocations can fail; share one read (v1 lesson).
      inflight.set(
        key,
        (async () => {
          const r = await probeOpenCode('models', { launch: await getLaunch(), timeout_ms: 60_000, provider });
          if (r.exit_code !== 0) {
            const tail = `${r.stderr || ''}`.trim().split(/\r?\n/).slice(-2).join(' | ');
            throw new Error(`\`opencode models\` failed (exit ${r.exit_code})${tail ? `: ${tail.slice(0, 300)}` : ''}`);
          }
          const models = parseModelList(r.stdout);
          cache.set(key, { at: now(), models });
          return models;
        })().finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  }

  /**
   * Filter [request.model, ...request.fallback_models] against the catalogue.
   * Returns {model, fallback_models, notes}; throws model_unavailable when none remain.
   * When the catalogue cannot be read, the request is used as-is with a note.
   */
  async function candidates(request) {
    const requested = [request.model, ...(request.fallback_models || [])];
    let catalogue;
    try {
      catalogue = new Set(await list());
    } catch (err) {
      return { model: request.model, fallback_models: [...(request.fallback_models || [])], notes: [`catalogue unavailable (${err.message}); model ids not validated`] };
    }
    const kept = requested.filter((m) => catalogue.has(m));
    const missing = requested.filter((m) => !catalogue.has(m));
    if (!kept.length) {
      throw new ValidationError(`None of the requested models exist in the opencode catalogue: ${requested.join(', ')}. See opencode_models.`, 'model_unavailable');
    }
    return { model: kept[0], fallback_models: kept.slice(1), notes: missing.length ? [`skipped (not in catalogue): ${missing.join(', ')}`] : [] };
  }

  return { list, candidates };
}
