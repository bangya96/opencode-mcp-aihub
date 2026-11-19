#!/usr/bin/env node
// opencode-mcp v2: dependency-free MCP server that lets MCP clients delegate work to OpenCode.
//
//   node opencode-mcp.mjs              MCP server over stdio
//   node opencode-mcp.mjs doctor       preflight checks
//   node opencode-mcp.mjs hook-wait    Claude Code async PostToolUse hook (completion wake)
//   node opencode-mcp.mjs --version
//
// The v1 single-file servers (opencode-mcp-macos.mjs / opencode-mcp-windows.mjs) are kept unchanged.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/contracts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const INSTRUCTIONS = [
  'opencode-mcp delegates work to the OpenCode CLI as jobs that survive client disconnects.',
  'Modes: ask = read-only agent (edit, shell and subagent tools disabled); plan = same read-only agent answering with an implementation plan; edit = may change files and run commands.',
  'Plan-first workflow: opencode_run with mode plan, show the plan to the user, and only after approval call opencode_run with mode edit and the plan job\'s session_id.',
  'opencode_ask is the blocking v1 call. For longer work use opencode_run, then opencode_wait or opencode_status.',
  'Always pass an absolute cwd and an explicit model (see opencode_models). opencode has no memory of this conversation.',
].join('\n');

const USAGE = `opencode-mcp ${VERSION}
Usage:
  node opencode-mcp.mjs              start the MCP server on stdio
  node opencode-mcp.mjs doctor       check opencode, the model catalogue and directories
  node opencode-mcp.mjs hook-wait [--timeout-ms N]
                                     Claude Code async PostToolUse hook (reads the payload on stdin)
  node opencode-mcp.mjs --version`;

async function serve() {
  const config = loadConfig();
  const log = (msg) => {
    if (config.debug) process.stderr.write(`[opencode-mcp] ${msg}\n`);
  };
  const [{ createServer }, { createTools }, { createModels }, platform, opencode, jobs] = await Promise.all([
    import('./lib/mcp.mjs'),
    import('./lib/tools.mjs'),
    import('./lib/models.mjs'),
    import('./lib/platform.mjs'),
    import('./lib/opencode.mjs'),
    import('./lib/jobs.mjs'),
  ]);

  let cachedLaunch = null;
  const getLaunch = async () => {
    if (!cachedLaunch) cachedLaunch = await platform.resolveLaunch(config);
    return cachedLaunch;
  };

  // Disk-backed and cheap; without opencode it still serves status/wait/cancel, and is rebuilt
  // once opencode can be resolved.
  let store = null;
  let storeHasLaunch = false;
  const getStore = async ({ need_launch = false } = {}) => {
    if (store && (storeHasLaunch || !need_launch)) return store;
    let launch = null;
    try {
      launch = await getLaunch();
    } catch (err) {
      if (need_launch) throw err;
    }
    store = jobs.createJobStore({ config, launch });
    storeHasLaunch = Boolean(launch);
    return store;
  };

  const models = createModels({ getLaunch, probeOpenCode: opencode.probeOpenCode });
  const tools = createTools({ config, getStore, models });
  const server = createServer({ name: 'opencode-mcp', version: VERSION, instructions: INSTRUCTIONS, tools, log });

  const gc = () => {
    Promise.resolve()
      .then(async () => (await getStore()).gc())
      .catch((err) => log(`gc failed: ${err?.message || err}`));
  };
  setTimeout(gc, 5_000).unref();
  setInterval(gc, 60 * 60_000).unref();

  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack || err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

  // Jobs run in detached supervisors; the client going away never cancels them.
  server.serveStdio({ onClose: () => process.exit(0) });
  log(`opencode-mcp ${VERSION} ready (state dir ${config.state_dir})`);
}

async function doctor() {
  const config = loadConfig();
  const [{ runDoctor, formatDoctor }, platform, opencode] = await Promise.all([
    import('./lib/doctor.mjs'),
    import('./lib/platform.mjs'),
    import('./lib/opencode.mjs'),
  ]);
  const report = await runDoctor({ config, resolveLaunch: platform.resolveLaunch, probeOpenCode: opencode.probeOpenCode });
  process.stdout.write(`${formatDoctor(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

async function hookWaitCommand(args) {
  try {
    const config = loadConfig();
    const { hookWait } = await import('./lib/hook.mjs');
    const i = args.indexOf('--timeout-ms');
    const timeout_ms = Number(i !== -1 ? args[i + 1] : process.env.OPENCODE_MCP_HOOK_TIMEOUT_MS) || 3_600_000;
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    let payload;
    try {
      payload = JSON.parse(input);
    } catch {
      process.exit(0);
    }
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    process.on('SIGTERM', () => controller.abort());
    const { exit_code, stderr } = await hookWait(payload, { state_dir: config.state_dir, timeout_ms, signal: controller.signal });
    if (stderr) process.stderr.write(`${stderr}\n`);
    process.exit(exit_code);
  } catch {
    process.exit(0);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) await serve();
else if (cmd === 'doctor') await doctor();
else if (cmd === 'hook-wait') await hookWaitCommand(rest);
else if (cmd === '--version' || cmd === '-v') process.stdout.write(`${VERSION}\n`);
else if (cmd === '--help' || cmd === '-h' || cmd === 'help') process.stdout.write(`${USAGE}\n`);
else {
  process.stderr.write(`unknown command: ${cmd}\n${USAGE}\n`);
  process.exitCode = 2;
}
