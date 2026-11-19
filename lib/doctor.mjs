// `node opencode-mcp.mjs doctor`: read-only preflight checks. Exit 0 when nothing failed.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseModelList } from './models.mjs';
import { resolveGitPath } from './contracts.mjs';

function tail(r) {
  return `${r.stderr || ''}\n${r.stdout || ''}`.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300);
}

export async function runDoctor({ config, resolveLaunch, probeOpenCode, nodeVersion = process.versions.node, gitPath = resolveGitPath }) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const major = Number(String(nodeVersion).split('.')[0]);
  add('node', major >= 18 ? 'ok' : 'fail', major >= 18 ? `Node ${nodeVersion}` : `Node ${nodeVersion}; Node 18 or newer is required`);

  let launch = null;
  try {
    launch = await resolveLaunch(config);
    add('opencode binary', 'ok', `${[launch.file, ...(launch.argsPrefix || [])].join(' ')} (${launch.source})`);
  } catch (err) {
    const searched = Array.isArray(err?.searched) && err.searched.length ? ` Searched: ${err.searched.join(', ')}.` : '';
    add('opencode binary', 'fail', `${err?.message || err}.${searched} Set OPENCODE_MCP_BIN to the opencode binary.`);
  }

  if (launch) {
    const v = await probeOpenCode('version', { launch, timeout_ms: 20_000 });
    const version = (String(v.stdout).match(/\d+\.\d+\.\d+/) || [])[0];
    add('opencode version', v.exit_code === 0 && version ? 'ok' : 'fail', version || `could not read the version: ${tail(v)}`);

    const m = await probeOpenCode('models', { launch, timeout_ms: 60_000 });
    const models = m.exit_code === 0 ? parseModelList(m.stdout) : [];
    if (!models.length) {
      add('model catalogue', 'fail', `\`opencode models\` returned no models: ${tail(m) || `exit ${m.exit_code}`}. Check your opencode provider config.`);
    } else {
      add('model catalogue', 'ok', `${models.length} models configured`);
      if (!config.default_model) {
        add('default model', 'warn', 'OPENCODE_MCP_MODEL is not set; every call must pass model.');
      } else if (!models.includes(config.default_model)) {
        add('default model', 'fail', `OPENCODE_MCP_MODEL=${config.default_model} is not in the catalogue.`);
      } else {
        add('default model', 'ok', config.default_model);
      }
    }
    add('note', 'ok', 'Catalogue membership does not prove the gateway accepts the model; the first run does.');
  }

  add('git', gitPath() ? 'ok' : 'warn', gitPath() || 'git not found on PATH; change detection will report "unknown".');

  try {
    mkdirSync(config.state_dir, { recursive: true });
    const probe = join(config.state_dir, `.doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    add('state dir', 'ok', config.state_dir);
  } catch (err) {
    add('state dir', 'fail', `${config.state_dir}: ${err?.message || err}`);
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

export function formatDoctor(report) {
  const tag = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };
  const lines = report.checks.map((c) => `${tag[c.status] || '[ ?? ]'} ${c.name}: ${c.detail}`);
  lines.push(report.ok ? 'opencode-mcp doctor: ready' : 'opencode-mcp doctor: problems found');
  return lines.join('\n');
}
