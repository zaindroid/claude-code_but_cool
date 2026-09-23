// Real accounts now, not one shared password -- each session is tied to one Forge user (and, one
// level down, one real Linux system user -- see users.js/osUsers.js). Invite-only: the very first
// account (an "admin") is created automatically at first boot from ADMIN_PASSWORD, and only an
// admin can create further accounts afterward (server.js's /api/admin/users) -- nobody
// self-registers.
import crypto from 'node:crypto';
import { verifyLogin, findById, createUser, isFirstBoot } from './users.js';

const COOKIE_NAME = 'forge_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- a personal tool, not re-logging in weekly

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

function setSessionCookie(req, res, userId) {
  const token = sign({ userId, exp: Date.now() + SESSION_TTL_MS });
  const secureFlag = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureFlag}`);
}

// Runs once, the first time Forge ever starts with no accounts at all -- turns ADMIN_PASSWORD
// into the first real account so there is always exactly one way in on a fresh deploy, with
// nothing left in an ambiguous "nobody can sign in yet" state.
export function bootstrapAdmin() {
  if (!isFirstBoot()) return;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD is not set, and there is no admin account yet -- cannot start with nobody able to sign in');
  createUser({ username: 'admin', password, role: 'admin' });
  console.log('Created the first account: admin');
}

export function login(req, res) {
  const { username, password } = req.body || {};
  const user = verifyLogin(String(username || ''), String(password || ''));
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  setSessionCookie(req, res, user.id);
  res.json({ ok: true, username: user.username, role: user.role });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

// Exported (not just used internally) because the WebSocket upgrade handler in server.js needs
// this exact same check outside Express's own request/response cycle, where requireAuth's
// middleware form doesn't apply.
export function userFromCookieHeader(cookieHeader) {
  const session = verify(parseCookies(cookieHeader)[COOKIE_NAME]);
  if (!session) return null;
  return findById(session.userId);
}

export function requireAuth(req, res, next) {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Sign in first' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

export function authStatus(req, res) {
  const user = userFromCookieHeader(req.headers.cookie);
  res.json(user ? { authenticated: true, username: user.username, role: user.role } : { authenticated: false });
}
