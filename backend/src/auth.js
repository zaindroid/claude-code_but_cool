// Single-user, password-gated access. Forge gives whoever is signed in a real terminal that can
// run `claude` -- that is shell access, so there is no "guest" mode and no account system: one
// password, one signed session cookie, checked on every request and every WebSocket upgrade.
import crypto from 'node:crypto';

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

export function login(req, res) {
  const password = process.env.ACCESS_PASSWORD;
  if (!password) return res.status(500).json({ error: 'ACCESS_PASSWORD is not set on the server' });
  const given = String(req.body?.password || '');
  const a = Buffer.from(given.padEnd(password.length, '\0'));
  const b = Buffer.from(password);
  const match = given.length === password.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ error: 'Wrong password' });

  const token = sign({ exp: Date.now() + SESSION_TTL_MS });
  const secureFlag = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureFlag}`);
  res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

export function sessionFromCookieHeader(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  return verify(cookies[COOKIE_NAME]);
}

export function requireAuth(req, res, next) {
  const session = sessionFromCookieHeader(req.headers.cookie);
  if (!session) return res.status(401).json({ error: 'Sign in first' });
  req.session = session;
  next();
}

export function authStatus(req, res) {
  const session = sessionFromCookieHeader(req.headers.cookie);
  res.json({ authenticated: !!session });
}
