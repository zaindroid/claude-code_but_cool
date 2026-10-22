import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-tok-'));
process.env.DATA_DIR = dir;

const { createToken, listTokens, revokeToken, userFromToken, bearerFromRequest } = await import(
  'file://' + path.resolve('backend/src/tokens.js').replace(/\\/g, '/')
);

let p = 0, f = 0;
const ck = (l, c) => (c ? (p++, console.log('PASS  ' + l)) : (f++, console.log('FAIL  ' + l)));

const u = { id: 'u1' };
const { token, record } = createToken(u, 'zains-laptop');
const storeFile = path.join(dir, 'tokens.json');
const raw = fs.readFileSync(storeFile, 'utf8');

ck('token has czt_ prefix', token.startsWith('czt_'));
ck('token is long enough to be a real secret', token.length > 40);
ck('returned record omits the hash', record.hash === undefined);
ck('listed once', listTokens(u).length === 1);
ck('label kept', listTokens(u)[0].label === 'zains-laptop');
ck('listTokens never exposes a hash', listTokens(u).every((t) => t.hash === undefined));
// The one that actually matters: the real token must not be recoverable from storage.
ck('plaintext token is NOT in the store file', !raw.includes(token));
ck('store does contain a sha256 hash instead', /"hash": "[0-9a-f]{64}"/.test(raw));
ck('store written 0600', (fs.statSync(storeFile).mode & 0o777) === 0o600 || process.platform === 'win32');

ck('garbage token rejected', userFromToken('czt_nope') === null);
ck('non-prefixed token rejected', userFromToken('hunter2') === null);
ck('null rejected', userFromToken(null) === null);
ck('wrong-length token rejected', userFromToken('czt_' + 'a'.repeat(43)) === null);
ck('bearer parsed', bearerFromRequest({ headers: { authorization: 'Bearer abc' } }) === 'abc');
ck('non-bearer scheme ignored', bearerFromRequest({ headers: { authorization: 'Basic abc' } }) === null);
ck('missing header ignored', bearerFromRequest({ headers: {} }) === null);

const second = createToken(u, 'other-box').record;
ck('two tokens listed', listTokens(u).length === 2);
ck('other account sees none', listTokens({ id: 'u2' }).length === 0);
revokeToken(u, second.id);
ck('revoked one, other remains', listTokens(u).length === 1);
try {
  revokeToken(u, 'nope');
  ck('revoking unknown 404s', false);
} catch (e) {
  ck('revoking unknown 404s', e.status === 404);
}
try {
  revokeToken({ id: 'u2' }, listTokens(u)[0].id);
  ck("cannot revoke another account's token", false);
} catch (e) {
  ck("cannot revoke another account's token", e.status === 404);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
