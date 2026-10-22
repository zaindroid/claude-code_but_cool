// API tokens, for the one thing a browser cookie cannot do: let a machine you own authenticate to
// Codez without a human in front of it. Teleport needs exactly that -- the `codez` CLI on your
// laptop pushing a session up, and a hook pushing it back later, with nobody clicking anything.
//
// Deliberately a separate credential from the login password rather than an extension of the
// session cookie:
//   - A session cookie is short-lived-ish, browser-scoped and HttpOnly on purpose. Teaching the
//     CLI to hold one would mean either shipping the password to every machine or persisting a
//     cookie far outside the context it was designed for.
//   - A token can be revoked on its own, per machine, without signing anything else out. If a
//     laptop goes missing, that one token dies and the sessions it teleported stay put.
//
// Stored hashed, never in plaintext: the file is readable by root inside the container and the
// token is a bearer credential with full account access, so the only copy of the real string is
// the one shown once at creation. A token that can be read back out of storage is a token that
// leaks to anyone who can read storage, and there is no feature here worth that.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findById } from './users.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

// `czt_` so a leaked string is identifiable at a glance -- in a log, a shell history, a pasted
// snippet -- as a Codez token rather than an anonymous blob of base64. 32 bytes of real CSPRNG
// entropy, which is the part that actually matters.
const PREFIX = 'czt_';

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    return Array.isArray(parsed.tokens) ? parsed.tokens : [];
  } catch {
    return [];
  }
}

function writeAll(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 0600: this file holds token *hashes*, which are not directly usable, but it also maps them to
  // account ids and machine labels -- an inventory of which machines can reach which account.
  // Nothing outside the app process has any business reading it.
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ version: 1, tokens }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function hash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createToken(user, label) {
  const raw = PREFIX + crypto.randomBytes(32).toString('base64url');
  const record = {
    id: crypto.randomUUID().slice(0, 8),
    userId: user.id,
    label: String(label || 'unnamed machine').slice(0, 64),
    hash: hash(raw),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  writeAll([...readAll(), record]);
  // The only time the real token exists outside the caller's own memory. Returned, not logged.
  return { token: raw, record: { ...record, hash: undefined } };
}

export function listTokens(user) {
  return readAll()
    .filter((t) => t.userId === user.id)
    .map(({ hash: _h, ...rest }) => rest);
}

export function revokeToken(user, id) {
  const all = readAll();
  const next = all.filter((t) => !(t.id === id && t.userId === user.id));
  if (next.length === all.length) throw Object.assign(new Error('No such token'), { status: 404 });
  writeAll(next);
  return { ok: true };
}

// Resolves a bearer token to a real account, or null.
//
// The comparison is against a stored hash, so it is already not a timing-sensitive secret
// comparison in the usual sense -- an attacker who can measure it learns about a hash they cannot
// invert. Using timingSafeEqual anyway because the cost is nil and the alternative is a reader of
// this file having to work that argument out themselves.
export function userFromToken(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return null;
  const want = Buffer.from(hash(raw), 'utf8');
  const all = readAll();
  let found = null;
  for (const t of all) {
    const got = Buffer.from(t.hash, 'utf8');
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) {
      found = t;
      break;
    }
  }
  if (!found) return null;
  const user = findById(found.userId);
  if (!user) return null;

  // Best-effort: a failed write here must not fail the request. This timestamp exists so a person
  // can look at their token list and recognise which machine is still using which token -- it is
  // an aid to revoking the right one, not an audit record anything depends on.
  try {
    writeAll(all.map((t) => (t.id === found.id ? { ...t, lastUsedAt: new Date().toISOString() } : t)));
  } catch {
    /* not critical */
  }
  return user;
}

export function bearerFromRequest(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}
