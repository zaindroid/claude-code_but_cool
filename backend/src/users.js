// Invite-only accounts: only an admin creates a user (see server.js's /api/admin/users route),
// nobody self-registers -- each account is real shell access to the server, so that's a
// deliberate choice, not an oversight. Every account, admin included, gets its own real Linux
// system user the first time it's created (see osUsers.js) -- that is the actual isolation
// boundary, this file is just the login/identity layer on top of it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createOsUser, ensureOsUserExists } from './osUsers.js';
import { duBytes, DEFAULT_USER_QUOTA_BYTES } from './diskUsage.js';

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

// includeUsage does a real `du` per account -- fine for an admin panel opened occasionally, not
// something to call on every request.
export function listUsers({ includeUsage = false } = {}) {
  return fs
    .readdirSync(USERS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const user = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8'));
      const { id, username, role, createdAt, quotaBytes, homeDir } = user;
      const base = { id, username, role, createdAt, quotaBytes: quotaBytes ?? DEFAULT_USER_QUOTA_BYTES };
      return includeUsage ? { ...base, usedBytes: duBytes(homeDir) } : base;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Accounts created before quotaBytes existed don't have it in their saved JSON -- backfilled here
// on read, not migrated on disk, so every caller (the quota check included) always sees a real
// number without needing its own "or default" fallback scattered around.
function withDefaults(user) {
  if (!user) return user;
  return { ...user, quotaBytes: user.quotaBytes ?? DEFAULT_USER_QUOTA_BYTES };
}

export function findByUsername(username) {
  const target = String(username || '').toLowerCase();
  for (const f of fs.readdirSync(USERS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const user = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8'));
    if (user.username.toLowerCase() === target) return withDefaults(user);
  }
  return null;
}

export function findById(id) {
  const file = fileFor(id);
  if (!fs.existsSync(file)) return null;
  return withDefaults(JSON.parse(fs.readFileSync(file, 'utf8')));
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
    quotaBytes: DEFAULT_USER_QUOTA_BYTES,
  };
  return save(user);
}

// Admin-only (see server.js) -- "increased by admin on request", not self-service, since it's
// the one lever against the platform-wide total filling up.
export function setUserQuota(id, quotaBytes) {
  const user = findById(id);
  if (!user) throw Object.assign(new Error('No such account'), { status: 404 });
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) throw Object.assign(new Error('Invalid quota'), { status: 400 });
  user.quotaBytes = quotaBytes;
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

// Run once at startup, before the server accepts any request -- see osUsers.js's own comment on
// ensureOsUserExists for why this has to exist at all (the container's own filesystem, where
// Linux user accounts live, does not survive a redeploy the way DATA_DIR does).
export function reconcileOsUsers() {
  for (const f of fs.readdirSync(USERS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const user = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8'));
    ensureOsUserExists(user);
  }
}
