// Invite-only accounts: only an admin creates a user (see server.js's /api/admin/users route),
// nobody self-registers -- each account is real shell access to the server, so that's a
// deliberate choice, not an oversight. Every account, admin included, gets its own real Linux
// system user the first time it's created (see osUsers.js) -- that is the actual isolation
// boundary, this file is just the login/identity layer on top of it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createOsUser } from './osUsers.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const USERS_DIR = path.join(DATA_DIR, 'users-meta');
fs.mkdirSync(USERS_DIR, { recursive: true });

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function fileFor(id) {
  return path.join(USERS_DIR, `${id}.json`);
}

function save(user) {
  fs.writeFileSync(fileFor(user.id), JSON.stringify(user, null, 2), 'utf8');
  return user;
}

export function listUsers() {
  return fs
    .readdirSync(USERS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const { id, username, role, createdAt } = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8'));
      return { id, username, role, createdAt };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findByUsername(username) {
  const target = String(username || '').toLowerCase();
  for (const f of fs.readdirSync(USERS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const user = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8'));
    if (user.username.toLowerCase() === target) return user;
  }
  return null;
}

export function findById(id) {
  const file = fileFor(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Creates the Forge account AND its backing Linux system user in one step -- there is never a
// Forge account without a real OS user behind it, so nothing downstream has to handle "what if
// this user has no home directory yet".
export function createUser({ username, password, role = 'user' }) {
  if (!USERNAME_RE.test(username || '')) {
    throw Object.assign(new Error('Usernames: letters, numbers, underscores and dashes only, starting with a letter, 2-32 characters'), { status: 400 });
  }
  if (!password || password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
  if (findByUsername(username)) throw Object.assign(new Error('That username is already taken'), { status: 409 });

  const os = createOsUser(username);
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    role,
    createdAt: new Date().toISOString(),
    linuxUsername: os.linuxUsername,
    uid: os.uid,
    gid: os.gid,
    homeDir: os.homeDir,
    projectsDir: os.projectsDir,
  };
  return save(user);
}

export function verifyLogin(username, password) {
  const user = findByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return user;
}

export function isFirstBoot() {
  return listUsers().length === 0;
}
