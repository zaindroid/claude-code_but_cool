// Read-only browsing of one project's files -- editing happens in the terminal, through Claude
// Code or any other CLI tool, not through this API. Keeping this read-only removes an entire
// class of path-traversal-to-write bugs for a v1 that does not need write access here at all.
import fs from 'node:fs';
import path from 'node:path';
import { projectPath } from './projects.js';

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB -- large enough for real source files, small enough to not hang the browser tab
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);

// Resolves a project-relative path to a real filesystem path, refusing anything that would land
// outside the project's own directory (a symlink someone dropped in there included).
function resolveWithin(root, relPath) {
  const clean = path.normalize(relPath || '.').replace(/^([/\\])+/, '');
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

export function listDir(project, relPath) {
  const root = projectPath(project);
  if (!root) return null;
  const full = resolveWithin(root, relPath);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) return null;
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isFile() ? fs.statSync(path.join(full, e.name)).size : undefined,
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export function readFile(project, relPath) {
  const root = projectPath(project);
  if (!root) return null;
  const full = resolveWithin(root, relPath);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const stat = fs.statSync(full);
  if (stat.size > MAX_READ_BYTES) {
    return { truncated: true, size: stat.size, content: fs.readFileSync(full, { encoding: 'utf8', flag: 'r' }).slice(0, MAX_READ_BYTES) };
  }
  return { truncated: false, size: stat.size, content: fs.readFileSync(full, 'utf8') };
}
