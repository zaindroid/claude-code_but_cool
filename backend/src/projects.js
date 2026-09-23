// Each project is one directory under DATA_DIR/projects -- that directory is both what the file
// browser shows and the cwd the terminal's shell starts in, so "a project" is just a folder, the
// same mental model as opening a folder in any local editor.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidProjectName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// The one place a project name becomes a real path -- every route below goes through this, so a
// name that is not exactly a direct child of PROJECTS_DIR (no "..", no absolute path, no symlink
// escape) never reaches the filesystem at all.
export function projectPath(name) {
  if (!isValidProjectName(name)) return null;
  const full = path.join(PROJECTS_DIR, name);
  const real = path.resolve(full);
  if (real !== path.resolve(PROJECTS_DIR, name)) return null;
  return full;
}

export function listProjects() {
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const stat = fs.statSync(path.join(PROJECTS_DIR, e.name));
      return { name: e.name, createdAt: stat.birthtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createProject(name) {
  const dir = projectPath(name);
  if (!dir) throw Object.assign(new Error('Invalid project name -- letters, numbers, dots, dashes and underscores only'), { status: 400 });
  if (fs.existsSync(dir)) throw Object.assign(new Error('A project with this name already exists'), { status: 409 });
  fs.mkdirSync(dir, { recursive: true });
  return { name, createdAt: new Date().toISOString() };
}
