// Which model provider `claude` talks to -- stored once, applied to every project's terminal.
// Anthropic itself needs nothing here (an interactive `claude login` in the terminal is enough,
// see pty.js/README); an API key or a whole other Anthropic-API-compatible provider (DeepSeek,
// Kimi/Moonshot, anything documented the same way) goes through ANTHROPIC_BASE_URL/AUTH_TOKEN,
// exactly the env vars the real `claude` CLI itself reads -- Forge does not reimplement any of
// that, it just sets the same environment a person would export by hand before running `claude`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'settings.json.enc');

const FIELDS = ['provider', 'baseUrl', 'authToken', 'model', 'smallModel'];
const DEFAULTS = { provider: 'anthropic', baseUrl: '', authToken: '', model: '', smallModel: '' };

// authToken is a real credential (an Anthropic API key or another provider's), so it is kept
// encrypted at rest -- the same reason MailZ encrypts mail account credentials, not because this
// needs to defend against much more than "don't leave API keys sitting in a plain JSON file".
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

export function readSettings() {
  if (!fs.existsSync(FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(decrypt(fs.readFileSync(FILE, 'utf8'))) };
  } catch {
    return { ...DEFAULTS };
  }
}

// What the settings page itself gets back -- authToken is never sent to the browser once saved,
// only whether one is set, the same "already have a value, type a new one to replace it" pattern
// as any password field. Every other field is plain, non-secret configuration.
export function readSettingsForClient() {
  const s = readSettings();
  return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, smallModel: s.smallModel, hasAuthToken: !!s.authToken };
}

export function writeSettings(patch) {
  const current = readSettings();
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, encrypt(JSON.stringify(next)), 'utf8');
  return readSettingsForClient();
}

export function clearAuthToken() {
  const current = readSettings();
  current.authToken = '';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, encrypt(JSON.stringify(current)), 'utf8');
  return readSettingsForClient();
}

// Exactly the environment `claude` itself reads (see the DeepSeek/Kimi-style integration docs) --
// Forge sets these before spawning the shell so running `claude` in any project's terminal picks
// the configured provider up automatically, with nothing to export by hand each time.
export function providerEnv() {
  const s = readSettings();
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
