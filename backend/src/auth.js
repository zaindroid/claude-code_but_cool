// Real accounts now, not one shared password -- each session is tied to one Codez user (and, one
// level down, one real Linux system user -- see users.js/osUsers.js). Invite-only: the very first
// account (an "admin") is created automatically at first boot from ADMIN_PASSWORD, and only an
// admin can create further accounts afterward (server.js's /api/admin/users) -- nobody
// self-registers.
import crypto from 'node:crypto';
import { verifyLogin, findById, findByUsername, createUser, setPassword, isFirstBoot } from './users.js';
import { userFromToken, bearerFromRequest } from './tokens.js';

const COOKIE_NAME = 'codez_session';
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

// Runs once, the first time Codez ever starts with no accounts at all -- turns ADMIN_PASSWORD
// into the first real account so there is always exactly one way in on a fresh deploy, with
// nothing left in an ambiguous "nobody can sign in yet" state.
export function bootstrapAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  if (isFirstBoot()) {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) throw new Error('ADMIN_PASSWORD is not set, and there is no admin account yet -- cannot start with nobody able to sign in');
    createUser({ username, password, role: 'admin' });
    console.log(`Created the first account: ${username}`);
    return;
  }
  applyPasswordReset(username);
}

// The way back in when the admin password is lost.
//
// There is no "forgot password" link and there is not going to be one: no mail server to send to,
// and an unauthenticated route that rewrites the admin's password is a worse hole than the problem
// it solves. Nor is there reliably a shell on the box -- this runs as a container on a host the
// operator may only reach through a deploy API. What is left is the one channel that platform does
// expose: set an env var, restart.
//
// Re-applied on every boot while the variable is set, rather than once behind a marker file. That
// is deliberate: it makes the operation idempotent, so a crash loop or a half-finished deploy
// cannot strand the account in a state nobody holds the password for -- which is the exact
// situation this exists to end. Unset it once you are back in; it is plaintext in the environment
// for as long as it stays.
function applyPasswordReset(username) {
  const password = process.env.ADMIN_PASSWORD_RESET;
  if (!password) return;
  const admin = findByUsername(username);
  if (!admin) {
    console.warn(`ADMIN_PASSWORD_RESET is set, but no account is named "${username}" -- nothing was reset`);
    return;
  }
  setPassword(admin.id, password);
  console.log(`Reset the password for ${username} from ADMIN_PASSWORD_RESET -- unset that variable now`);
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

// Accepts either a browser session cookie or a machine API token (tokens.js).
//
// Used ONLY on the teleport routes, not on /api generally, and that narrowness is the point: a
// token sits in a file on a laptop with no human watching it, so what it can reach is kept to the
// surface that actually needs it -- moving sessions and workspaces. It cannot read or rewrite
// provider settings, create accounts, or change quotas, because those routes stay behind the
// cookie-only gate. A stolen token costs you the sessions it could already reach; it does not
// hand over the account.
export function requireAuthOrToken(req, res, next) {
  const bearer = bearerFromRequest(req);
  const user = bearer ? userFromToken(bearer) : userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Sign in, or send a Codez API token as `Authorization: Bearer czt_...`' });
  req.user = user;
  req.viaToken = Boolean(bearer);
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
