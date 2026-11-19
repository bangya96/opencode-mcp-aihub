import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveGitPath } from './contracts.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
// git is resolved from absolute PATH entries only: on Windows a bare 'git' would first be looked up
// in the (untrusted) project directory.
const GIT = resolveGitPath();
const GIT_SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '--no-optional-locks'];
const git = (cwd, args) => (GIT
  // Repository config must not be able to run commands during a snapshot: disable fsmonitor hooks
  // and the untracked cache, take no optional locks, and never prompt.
  ? spawnSync(GIT, [...GIT_SAFE_ARGS, ...args], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
  : { status: null, stdout: '', stderr: '', error: Object.assign(new Error('git not found'), { code: 'ENOENT' }) });

export async function snapshot(dirs) {
  const limitations = ['Git-ignored files are not checked.'];
  const repositories = [];
  for (const dir of [...new Set(dirs)]) {
    const rootResult = git(dir, ['rev-parse', '--show-toplevel']);
    if (rootResult.status !== 0) { limitations.push(rootResult.error?.code === 'ENOENT' ? 'Git is unavailable.' : `Not a git work tree: ${dir}`); repositories.push({ dir, available: false }); continue; }
    const root = rootResult.stdout.trim();
    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv']);
    const cached = git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv']);
    if ([status, diff, cached].some((r) => r.status !== 0)) { limitations.push(`Git snapshot failed: ${dir}`); repositories.push({ dir, available: false }); continue; }
    const head = git(root, ['rev-parse', 'HEAD']);
    const paths = new Set(); const records = status.stdout.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; if (!record) continue;
      paths.add(record.slice(3));
      if (/[RC]/.test(record.slice(0, 2))) paths.add(records[++i]);
    }
    const files = {};
    if (paths.size > 2000) limitations.push(`File hashing capped at 2000 paths: ${root}`);
    for (const name of [...paths].filter(Boolean).slice(0, 2000)) {
      const path = resolve(root, name);
      try {
        const stat = await fs.lstat(path);
        if (stat.size > 5 * 1024 * 1024) { limitations.push(`File larger than 5 MB skipped: ${path}`); files[path] = null; }
        else if (stat.isSymbolicLink()) files[path] = hash(await fs.readlink(path));
        else if (stat.isFile()) files[path] = hash(await fs.readFile(path));
        else { files[path] = null; limitations.push(`Non-regular path not hashed: ${path}`); }
      } catch (e) { files[path] = null; if (e.code !== 'ENOENT') limitations.push(`Could not hash: ${path}`); }
    }
    repositories.push({ dir, root, available: true, head: head.status === 0 ? head.stdout.trim() : null, status: status.stdout, diff: hash(diff.stdout), cached: hash(cached.stdout), files });
  }
  return { repositories, limitations: [...new Set(limitations)] };
}

export async function compare(before, after) {
  const files = new Set(); let changed = false, available = 0;
  for (const next of after.repositories) {
    const previous = before.repositories.find((r) => r.dir === next.dir);
    if (!previous?.available || !next.available) continue;
    available++;
    if (['head', 'status', 'diff', 'cached'].some((key) => previous[key] !== next[key])) changed = true;
    for (const path of new Set([...Object.keys(previous.files), ...Object.keys(next.files)])) {
      if (previous.files[path] !== next.files[path] || !(path in previous.files) || !(path in next.files)) { changed = true; files.add(path); }
    }
  }
  return { changes_detected: available ? changed : null, files: [...files].sort(), coverage: !available ? 'none' : available === after.repositories.length ? 'git' : 'partial', limitations: [...new Set([...before.limitations, ...after.limitations])] };
}
