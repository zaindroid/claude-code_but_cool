// Per-project metadata Codez itself owns -- which agent this project was set up for, and which
// template (if any) it started from. Lives inside the project directory as `.codez/config.json`,
// owned by the account's own uid like everything else under their home (see osUsers.js), so it
// moves and backs up with the project itself rather than living in some separate app database.
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';

function configPath(projectDir) {
  return path.join(projectDir, '.codez', 'config.json');
}

const DEFAULTS = { agent: 'claude', template: null, legendMode: false };

export function readProjectConfig(projectDir) {
  const file = configPath(projectDir);
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeProjectConfig(user, projectDir, patch) {
  const dir = path.join(projectDir, '.codez');
  const isNew = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...readProjectConfig(projectDir), ...patch };
  fs.writeFileSync(configPath(projectDir), JSON.stringify(next, null, 2), 'utf8');
  if (isNew) chownToUser(dir, user.uid, user.gid);
  chownToUser(configPath(projectDir), user.uid, user.gid);
  return next;
}
