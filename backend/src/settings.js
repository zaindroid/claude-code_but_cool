// Which model provider `claude` talks to -- one config per Forge account, stored under that
// user's own home directory (so the same OS-level permissions that isolate their projects isolate
// their API key too) and applied to every one of their terminals. Anthropic itself needs nothing
// here (an interactive `claude login` in the terminal is enough, see pty.js/README); an API key or
// a whole other Anthropic-API-compatible provider (DeepSeek, Kimi/Moonshot, anything documented
// the same way) goes through ANTHROPIC_BASE_URL/AUTH_TOKEN, exactly the env vars the real `claude`
// CLI itself reads -- Forge does not reimplement any of that, it just sets the same environment a
// person would export by hand before running `claude`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';

const FIELDS = ['provider', 'baseUrl', 'authToken', 'model', 'smallModel'];
const DEFAULTS = { provider: 'anthropic', baseUrl: '', authToken: '', model: '', smallModel: '' };

function fileFor(user) {
  return path.join(user.homeDir, '.forge-settings.json.enc');
}

// authToken is a real credential (an Anthropic API key or another provider's), so it is kept
// encrypted at rest, on top of the OS-level file permission that already keeps other users out --
// two independent reasons a copy of the raw volume/backup still does not hand out the key in
// plain text.
function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return crypto.createHash('sha256').update(`forge-settings:${secret}`).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(blob) {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function readSettings(user) {
  const file = fileFor(user);
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(decrypt(fs.readFileSync(file, 'utf8'))) };
  } catch {
    return { ...DEFAULTS };
  }
}

// What the settings page itself gets back -- authToken is never sent to the browser once saved,
// only whether one is set, the same "already have a value, type a new one to replace it" pattern
// as any password field. Every other field is plain, non-secret configuration.
export function readSettingsForClient(user) {
  const s = readSettings(user);
  return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, smallModel: s.smallModel, hasAuthToken: !!s.authToken };
}

export function writeSettings(user, patch) {
  const current = readSettings(user);
  const next = { ...current };
  for (const field of FIELDS) {
    if (field === 'authToken') {
      // An empty string from the form means "leave the existing token alone", not "clear it" --
      // clearing is its own explicit action (clearAuthToken below), since a blank password field
      // rendering as blank is the normal, expected state, not a signal to delete the real value.
      if (typeof patch.authToken === 'string' && patch.authToken.length > 0) next.authToken = patch.authToken;
    } else if (typeof patch[field] === 'string') {
      next[field] = patch[field];
    }
  }
  const file = fileFor(user);
  fs.writeFileSync(file, encrypt(JSON.stringify(next)), 'utf8');
  chownToUser(file, user.uid, user.gid);
  return readSettingsForClient(user);
}

export function clearAuthToken(user) {
  const current = readSettings(user);
  current.authToken = '';
  const file = fileFor(user);
  fs.writeFileSync(file, encrypt(JSON.stringify(current)), 'utf8');
  chownToUser(file, user.uid, user.gid);
  return readSettingsForClient(user);
}

// Exactly the environment `claude` itself reads (see the DeepSeek/Kimi-style integration docs) --
// Forge sets these before spawning the shell so running `claude` in any project's terminal picks
// the configured provider up automatically, with nothing to export by hand each time.
export function providerEnv(user) {
  const s = readSettings(user);
  const env = {};
  if (s.provider === 'anthropic') {
    if (s.authToken) env.ANTHROPIC_API_KEY = s.authToken;
  } else {
    if (s.baseUrl) env.ANTHROPIC_BASE_URL = s.baseUrl;
    if (s.authToken) env.ANTHROPIC_AUTH_TOKEN = s.authToken;
  }
  if (s.model) env.ANTHROPIC_MODEL = s.model;
  if (s.smallModel) env.ANTHROPIC_SMALL_FAST_MODEL = s.smallModel;
  return env;
}

// A few real, documented Anthropic-API-compatible providers, to fill the form in one click --
// the same values their own Claude Code integration docs give, not guessed.
export const PRESETS = {
  anthropic: { label: 'Anthropic (official)', baseUrl: '', model: '', smallModel: '' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', smallModel: 'deepseek-chat' },
  kimi: { label: 'Kimi (Moonshot AI)', baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k2-turbo-preview', smallModel: 'kimi-k2-turbo-preview' },
  custom: { label: 'Custom', baseUrl: '', model: '', smallModel: '' },
};
