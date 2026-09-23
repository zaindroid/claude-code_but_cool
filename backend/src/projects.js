// Each project is one directory under the signed-in user's own home (see osUsers.js), owned by
// their Linux uid -- so "list of projects" and "does this path exist" are naturally scoped to one
// person without an app-level ownership check doing that work; the filesystem already refuses
// another user's process from reading in here at all.
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';
import { checkCanCreateProject } from './diskUsage.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidProjectName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// The one place a project name becomes a real path -- every route below goes through this, so a
// name that is not exactly a direct child of the user's own projects dir (no "..", no absolute
// path, no symlink escape) never reaches the filesystem at all.
export function projectPath(user, name) {
  if (!isValidProjectName(name)) return null;
  const root = user.projectsDir;
  const full = path.join(root, name);
  const real = path.resolve(full);
  if (real !== path.resolve(root, name)) return null;
  return full;
}

export function listProjects(user) {
  return fs
    .readdirSync(user.projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const stat = fs.statSync(path.join(user.projectsDir, e.name));
      return { name: e.name, createdAt: stat.birthtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createProject(user, name) {
  const dir = projectPath(user, name);
  if (!dir) throw Object.assign(new Error('Invalid project name -- letters, numbers, dots, dashes and underscores only'), { status: 400 });
  if (fs.existsSync(dir)) throw Object.assign(new Error('A project with this name already exists'), { status: 409 });
  // Checked here, not just once at signup -- a project created when there was headroom can still
  // grow past quota later through the terminal (a big git clone, node_modules, ...); this is the
  // one point new *growth* through Codez's own UI can actually be stopped. See diskUsage.js for
  // why this is an honest, app-level limit, not a kernel-enforced one.
  checkCanCreateProject(user, { dataDir: DATA_DIR });
  fs.mkdirSync(dir, { recursive: true });
  chownToUser(dir, user.uid, user.gid);
  return { name, createdAt: new Date().toISOString() };
}
