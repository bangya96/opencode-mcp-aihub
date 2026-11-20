// JSON-RPC 2.0 over newline-delimited stdio: the subset of MCP this server needs.
// stdout carries protocol frames only; diagnostics go through the injected logger (stderr).
// Adapted from agycli-mcp (same owner), with oversized frames rejected before parsing.

import { StringDecoder } from 'node:string_decoder';
import { envHint } from './contracts.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const RPC_ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  BUSY: -32000,
});

export const MAX_FRAME_CHARS = 16 * 1024 * 1024;

export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export function formatToolError(err) {
  const code = err && typeof err === 'object' && err.code ? `${err.code}: ` : '';
  let text = `${code}${err?.message || String(err)}`;
  if (Array.isArray(err?.searched) && err.searched.length) {
    text += `\nSearched:\n${err.searched.map((p) => `  ${p}`).join('\n')}\nSet OPENCODE_MCP_BIN to the opencode binary.`;
  }
  if (err?.code === 'launch_failed') {
    const hint = envHint();
    if (hint) text += `\n${hint}`;
  }
  return text;
}

/**
 * tools: [{definition: {name, description, inputSchema, annotations?}, handler(args, {signal})}]
 * A handler returns an MCP CallToolResult. Thrown errors become isError results.
 */
export function createServer({ name, version, instructions, tools, maxInFlight = 16, maxFrameChars = MAX_FRAME_CHARS, log = () => {} }) {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const inFlight = new Map(); // JSON(id) -> AbortController

  const error = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });

  async function callTool(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) return error(id, RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${params?.name}`);
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return error(id, RPC_ERRORS.INVALID_PARAMS, 'Tool arguments must be an object');
    }
    const controller = new AbortController();
    const key = JSON.stringify(id);
    inFlight.set(key, controller);
    try {
      return result(id, await tool.handler(args, { signal: controller.signal }));
    } catch (err) {
      if (!(err && (err.code === 'invalid_params' || err.code === 'model_required'))) log(`tool ${params.name} failed: ${err?.stack || err}`);
      return result(id, { content: [{ type: 'text', text: formatToolError(err) }], isError: true });
    } finally {
      inFlight.delete(key);
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
    if (!('method' in msg) && ('result' in msg || 'error' in msg)) return null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(msg.id, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
    const isNotification = !('id' in msg);
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        return result(id, {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      case 'notifications/initialized':
        return null;
      case 'notifications/cancelled':
        inFlight.get(JSON.stringify(params?.requestId))?.abort();
        return null;
      case 'ping':
        return isNotification ? null : result(id, {});
      case 'tools/list':
        return result(id, { tools: [...byName.values()].map((t) => t.definition) });
      case 'tools/call':
        if (isNotification) return null;
        if (inFlight.size >= maxInFlight) return error(id, RPC_ERRORS.BUSY, 'Server busy: too many concurrent tool calls');
        return callTool(id, params);
      default:
        return isNotification ? null : error(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function handleLine(line) {
    if (line.length > maxFrameChars) return error(null, RPC_ERRORS.PARSE, 'Parse error: message too large');
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return error(null, RPC_ERRORS.PARSE, 'Parse error');
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) return error(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
      const responses = (await Promise.all(msg.map(handle))).filter(Boolean);
      return responses.length ? responses : null;
    }
    return handle(msg);
  }

  function serveStdio({ stdin = process.stdin, stdout = process.stdout, onClose } = {}) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let discarding = false; // inside an oversized frame: drop bytes until the next newline
    const pending = new Set();
    const write = (response) => {
      if (response) stdout.write(`${JSON.stringify(response)}\n`);
    };
    const dispatch = (line) => {
      const p = handleLine(line)
        .then(write)
        .catch((err) => {
          log(`dispatch failed: ${err?.stack || err}`);
          write(error(null, RPC_ERRORS.INTERNAL, 'Internal error'));
        })
        .finally(() => pending.delete(p));
      pending.add(p);
    };
    stdin.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (discarding) {
          discarding = false;
          continue;
        }
        if (line.trim()) dispatch(line);
      }
      if (buffer.length > maxFrameChars) {
        buffer = '';
        if (!discarding) write(error(null, RPC_ERRORS.PARSE, 'Parse error: message too large'));
        discarding = true;
      }
    });
    stdin.on('end', async () => {
      const rest = (buffer + decoder.end()).trim();
      buffer = '';
      if (rest && !discarding) dispatch(rest);
      await Promise.allSettled([...pending]);
      onClose?.();
    });
  }

  return { handle, handleLine, serveStdio };
}
