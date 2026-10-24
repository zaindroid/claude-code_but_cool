// The admin password reset hatch (auth.js's applyPasswordReset).
//
// Covered because it is the one path nobody exercises until the day it is the only way back into
// a deployment -- by which point there is no opportunity to find out it broke three releases ago.
//
// createUser is sidestepped throughout: it calls a real Linux useradd, which cannot run here. A
// hand-written account record is faithful enough, since the reset only ever reads an account and
// rewrites its stored hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-reset-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_USERNAME = 'admin';

const src = (f) => pathToFileURL(path.resolve("backend/src/" + f)).href;
const users = await import(src('users.js'));
const { bootstrapAdmin, recoveryState } = await import(src('auth.js'));

let p = 0, f = 0;
const ck = (l, c) => (c ? (p++, console.log('PASS  ' + l)) : (f++, console.log('FAIL  ' + l)));

const id = crypto.randomUUID();
fs.writeFileSync(path.join(dir, 'users-meta', id + '.json'), JSON.stringify({
  id,
  username: 'admin',
  passwordHash: '',
  role: 'admin',
  createdAt: new Date().toISOString(),
  linuxUsername: 'codez-admin',
  uid: 2001,
  gid: 2001,
  homeDir: '/home/codez-admin',
  projectsDir: '/home/codez-admin/projects',
  quotaBytes: 1024,
}));

users.setPassword(id, 'theoldone123');
ck('the old password signs in before any reset', !!users.verifyLogin('admin', 'theoldone123'));
ck('an existing account means this is not first boot', users.isFirstBoot() === false);

// The hash form: a new credential handed to a running deployment without the password itself ever
// travelling through an env var or a deploy API.
process.env.ADMIN_PASSWORD_RESET_HASH = users.hashPassword('viahash7890');
bootstrapAdmin();
ck('hash-form reset admits the new password', !!users.verifyLogin('admin', 'viahash7890'));
ck('hash-form reset locks out the old password', users.verifyLogin('admin', 'theoldone123') === null);

const after = users.findByUsername('admin');
ck('the account keeps its id', after.id === id);
ck('the account stays an admin', after.role === 'admin');
ck('the backing Linux user is untouched', after.linuxUsername === 'codez-admin' && after.uid === 2001);
ck('the quota is untouched', after.quotaBytes === 1024);
ck('a reset never stores the password in the clear', !fs.readFileSync(path.join(dir, 'users-meta', id + '.json'), 'utf8').includes('viahash7890'));

// A typo in a recovery variable must not take the deployment down -- refusing to boot over it
// would turn a cosmetic mistake into the outage this hatch exists to prevent.
process.env.ADMIN_PASSWORD_RESET_HASH = 'not-a-hash';
let threw = false;
try { bootstrapAdmin(); } catch { threw = true; }
ck('a malformed hash does not throw at boot', threw === false);
ck('a malformed hash leaves the working password alone', !!users.verifyLogin('admin', 'viahash7890'));

// The plaintext form, for an operator who has a shell and just wants to type a new password.
delete process.env.ADMIN_PASSWORD_RESET_HASH;
process.env.ADMIN_PASSWORD_RESET = 'plaintext1234';
bootstrapAdmin();
ck('the plaintext form works too', !!users.verifyLogin('admin', 'plaintext1234'));

process.env.ADMIN_PASSWORD_RESET = 'short';
bootstrapAdmin();
ck('a too-short plaintext reset is refused, not applied', !!users.verifyLogin('admin', 'plaintext1234'));

// Both set: the hash wins, because whoever used it went out of their way not to let the password
// travel, and honouring the weaker one would quietly undo that.
process.env.ADMIN_PASSWORD_RESET_HASH = users.hashPassword('hashwins5555');
process.env.ADMIN_PASSWORD_RESET = 'plaintextloses';
bootstrapAdmin();
ck('the hash form wins when both are set', !!users.verifyLogin('admin', 'hashwins5555'));

// Idempotent while set, inert once cleared -- the property that makes it safe to leave a reset in
// place across a crash loop and safe to forget about afterwards.
bootstrapAdmin();
ck('re-applying the same reset changes nothing', !!users.verifyLogin('admin', 'hashwins5555'));

delete process.env.ADMIN_PASSWORD_RESET_HASH;
delete process.env.ADMIN_PASSWORD_RESET;
bootstrapAdmin();
ck('a boot with neither variable set is a no-op', !!users.verifyLogin('admin', 'hashwins5555'));

// A name no account holds: the hatch creates that admin rather than giving up, so the way back in
// does not depend on ADMIN_USERNAME still matching whatever first boot used.
//
// Creation goes through useradd, which this machine does not have, so here it fails -- and the
// point of asserting it anyway is that it must fail without taking the boot down and without
// disturbing the account that already works. The successful-creation half only exists on Linux,
// where this suite could not make a real system user either.
process.env.ADMIN_RESET_USERNAME = 'nobody';
process.env.ADMIN_PASSWORD_RESET_HASH = users.hashPassword('shouldnotapply');
let boom = false;
try { bootstrapAdmin(); } catch { boom = true; }
ck('a reset for a missing account does not throw at boot', boom === false);
ck('the account that already worked still works either way', !!users.verifyLogin('admin', 'hashwins5555'));

// Validation happens before creation, so a typo cannot leave behind a half-made admin whose
// password nobody knows.
process.env.ADMIN_RESET_USERNAME = 'typocase';
process.env.ADMIN_PASSWORD_RESET_HASH = 'not-a-hash';
bootstrapAdmin();
ck('a malformed hash creates no account at all', users.findByUsername('typocase') === null);

// The regression this suite exists for. The reset used to take its target from ADMIN_USERNAME,
// which on a real deployment was set once at first boot and written down nowhere -- so it reset the
// right password under a name nobody could guess, logged success, and let no one in. It must use
// its own variable, and default to a name chosen in advance when that is unset.
delete process.env.ADMIN_RESET_USERNAME;
process.env.ADMIN_USERNAME = 'anamenobodyremembers';
process.env.ADMIN_PASSWORD_RESET_HASH = users.hashPassword('fixeddefault999');
bootstrapAdmin();
ck('the reset ignores ADMIN_USERNAME', !!users.verifyLogin('admin', 'fixeddefault999'));
ck('and did not touch any account under that name', users.findByUsername('anamenobodyremembers') === null);

// And it has to say where it went, because a log line is not retrievable on the host this runs on.
const state = recoveryState();
ck('reports the account it targeted', state.target === 'admin');
ck('reports that it was armed', state.armed === true);
ck('reports what it did', state.outcome === 'reset an existing account');

delete process.env.ADMIN_PASSWORD_RESET_HASH;
ck('reports not-armed once the variable is gone', recoveryState().armed === false);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`
${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
