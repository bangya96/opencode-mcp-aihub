import { promises as fs, constants, realpathSync } from 'node:fs';
import { join, resolve, delimiter, dirname, basename, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export async function resolveLaunch(config) {
  const searched = [], win = process.platform === 'win32', home = homedir();
  const usable = async (p, script = false) => {
    searched.push(p);
    try { await fs.access(p, win || script ? constants.F_OK : constants.X_OK); return (await fs.stat(p)).isFile(); } catch { return false; }
  };
  const native = async (launcher) => {
    const real = await fs.realpath(launcher).catch(() => launcher), pkg = dirname(dirname(real));
    if (basename(pkg) !== 'opencode-ai') return null;
    const platformPkg = `opencode-${win ? 'windows' : process.platform}-${process.arch}`;
    for (const p of [...(win ? [join(pkg, 'bin', 'opencode.exe')] : []), join(pkg, 'node_modules', platformPkg, 'bin', `opencode${win ? '.exe' : ''}`), join(dirname(pkg), platformPkg, 'bin', `opencode${win ? '.exe' : ''}`)]) if (await usable(p)) return p;
    return null;
  };
  const consider = async (p, source) => {
    if (/\.(mjs|cjs|js)$/i.test(p) && await usable(p, true)) return { file: process.execPath, argsPrefix: [resolve(p)], source };
    let n = await native(p);
    if (n) return { file: n, argsPrefix: [], source };
    if (win && /\.(cmd|bat)$/i.test(p)) {
      n = await native(join(dirname(p), 'node_modules', 'opencode-ai', 'bin', 'opencode'));
      if (n) return { file: n, argsPrefix: [], source };
      searched.push(p); return null; // Never invoke a shell shim.
    }
    return await usable(p) ? { file: p, argsPrefix: [], source } : null;
  };
  const expand = async (p) => {
    const star = p.indexOf('*'); if (star < 0) return [p];
    const base = p.slice(0, p.lastIndexOf(sep, star)) || sep, end = p.indexOf(sep, star);
    const names = await fs.readdir(base).catch(() => []);
    names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return (await Promise.all(names.map(n => expand(join(base, n, end < 0 ? '' : p.slice(end + 1)))))).flat();
  };
  if (config.bin) {
    const found = await consider(resolve(config.bin), 'env'); if (found) return found;
  } else {
    for (const dir of (process.env.PATH || process.env.Path || '').split(delimiter).map(d => d.replace(/^"|"$/g, '')).filter(d => d && isAbsolute(d))) {
      for (const ext of win ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : ['']) {
        const found = await consider(resolve(dir.replace(/^"|"$/g, ''), `opencode${ext.toLowerCase()}`), 'path'); if (found) return found;
      }
    }
    const L = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const known = win ? [
      join(home, '.opencode', 'bin', 'opencode.exe'), join(home, 'scoop', 'shims', 'opencode.exe'), join(home, 'scoop', 'apps', 'opencode', 'current', 'opencode.exe'),
      join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'opencode.exe'), join(L, 'Programs', 'opencode', 'opencode.exe'), join(home, '.bun', 'bin', 'opencode.exe'),
      join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode'),
      join(process.env.NVM_SYMLINK || 'C:\\nvm4w\\nodejs', 'node_modules', 'opencode-ai', 'bin', 'opencode'),
      join(process.env.NVM_HOME || join(L, 'nvm'), '*', 'node_modules', 'opencode-ai', 'bin', 'opencode'),
      join(L, 'pnpm', 'global', '*', 'node_modules', 'opencode-ai', 'bin', 'opencode'), join(L, 'Volta', 'tools', 'image', 'packages', 'opencode-ai', 'bin', 'opencode'),
    ] : [join(home, '.opencode', 'bin', 'opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', '/home/linuxbrew/.linuxbrew/bin/opencode', ...['.local', '.bun', '.volta', '.npm-global'].map(d => join(home, d, 'bin', 'opencode')), join(home, 'Library', 'pnpm', 'opencode'), join(home, '.local', 'share', 'pnpm', 'opencode'), join(home, '.nvm', 'versions', 'node', '*', 'bin', 'opencode'), ...[join(home, 'Library', 'Application Support', 'fnm'), join(home, '.local', 'share', 'fnm')].map(d => join(d, 'node-versions', '*', 'installation', 'bin', 'opencode')), join(home, '.asdf', 'shims', 'opencode'), '/usr/bin/opencode'];
    for (const pattern of known) for (const p of await expand(pattern)) { const found = await consider(p, 'known'); if (found) return found; }
  }
  throw Object.assign(new Error('opencode not found; set OPENCODE_MCP_BIN to its executable.'), { code: 'launch_failed', searched });
}

export function childEnv(bin, env = process.env) {
  const extra = [dirname(bin)]; try { extra.push(dirname(realpathSync(bin))); } catch {}
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [key]: [...new Set([...extra, ...(env[key] || '').split(delimiter)])].filter(Boolean).join(delimiter) };
}
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export async function killTree(pid, { grace_ms = 500 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise(done => { const taskkill = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe'); // absolute: never a taskkill.exe planted in the cwd
      const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); child.once('error', done); child.once('close', done); }); return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
  await new Promise(r => setTimeout(r, grace_ms));
  try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
export async function atomicWriteJson(path, value) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`); let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, path); break; } catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 40) throw e;
        await new Promise(r => setTimeout(r, 25));
      }
    }
  } finally { await handle?.close(); await fs.unlink(temp).catch(() => {}); }
}
export async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
}
