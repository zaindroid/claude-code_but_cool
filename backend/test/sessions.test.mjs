// Integration test for sessions.js against a real temp filesystem.
// chownToUser is fs.chownSync, which can't work on Windows -- stub it via a module mock by
// pointing at a copy of osUsers that no-ops. Simplest portable approach: patch fs.chownSync.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

fs.chownSync = () => {}; // no-op: this test is about session records, not ownership

const { createSession, listSessions, listAllSessions, updateSession, deleteSession, findSessionByName, readSessions, launchCommand } =
  await import('file://' + path.resolve('backend/src/sessions.js').replace(/\\/g, '/'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-sess-'));
const user = { id: 'u1', uid: 1000, gid: 1000, homeDir: root, projectsDir: path.join(root, 'projects') };
fs.mkdirSync(path.join(user.projectsDir, 'alpha'), { recursive: true });
fs.mkdirSync(path.join(user.projectsDir, 'beta'), { recursive: true });

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (extra ? '  :: ' + extra : '')); }
};
const throws = (label, fn, wantStatus) => {
  try { fn(); check(label + ' (should have thrown)', false); }
  catch (e) { check(label, e.status === wantStatus, `got status ${e.status}: ${e.message}`); }
};

// create
const a = createSession(user, 'alpha', { name: 'scout' });
check('creates session', a.name === 'scout' && a.project === 'alpha');
check('generates a real uuid for --session-id', /^[0-9a-f-]{36}$/.test(a.claudeSessionId), a.claudeSessionId);
check('starts resident', a.teleport.state === 'resident');
check('persists to .codez/sessions.json', fs.existsSync(path.join(user.projectsDir, 'alpha', '.codez', 'sessions.json')));

// the core constraint: same name, DIFFERENT project, must still clash
throws('rejects duplicate name in another project', () => createSession(user, 'beta', { name: 'scout' }), 409);

// different name in another project is fine
const b = createSession(user, 'beta', { name: 'builder' });
check('allows distinct name in another project', b.name === 'builder');

// cross-project listing
check('listAllSessions spans projects', listAllSessions(user).length === 2);
check('listSessions scopes to one project', listSessions(user, 'alpha').length === 1);
check('findSessionByName crosses projects', findSessionByName(user, 'builder')?.project === 'beta');

// validation
throws('rejects bad name', () => createSession(user, 'alpha', { name: 'Bad_Name' }), 400);
throws('rejects reserved name', () => createSession(user, 'alpha', { name: 'claude' }), 400);
throws('rejects unknown project', () => createSession(user, 'nope', { name: 'ghost' }), 404);
throws('rejects unknown agent', () => createSession(user, 'alpha', { name: 'ghost' , agent: 'bogus' }), 400);

// rename
const renamed = updateSession(user, 'alpha', a.id, { name: 'recon' });
check('renames', renamed.name === 'recon');
throws('rename onto a taken name clashes', () => updateSession(user, 'alpha', a.id, { name: 'builder' }), 409);
const noop = updateSession(user, 'alpha', a.id, { name: 'recon' });
check('renaming to its own current name is a no-op, not a self-clash', noop.name === 'recon');

// immutable fields
const tampered = updateSession(user, 'alpha', a.id, { claudeSessionId: 'hacked', id: 'hacked' });
check('claudeSessionId is not patchable', tampered.claudeSessionId === a.claudeSessionId, tampered.claudeSessionId);
check('id is not patchable', tampered.id === a.id);

// teleport state round-trip
updateSession(user, 'alpha', a.id, { teleport: { state: 'teleported-in', lastSyncAt: 'now', transcriptLines: 12 } });
check('teleport state persists', readSessions(path.join(user.projectsDir, 'alpha')).sessions[0].teleport.transcriptLines === 12);

// corrupt file degrades to empty rather than throwing
fs.writeFileSync(path.join(user.projectsDir, 'beta', '.codez', 'sessions.json'), '{not json', 'utf8');
check('corrupt sessions.json reads as empty', readSessions(path.join(user.projectsDir, 'beta')).sessions.length === 0);

// Per-session agent choice. A project's crew can mix CLIs, so the launch command has to come
// from the session's own agent and not from a project-wide assumption -- and only Claude Code
// gets the named-session flags, because it is the only one of the four that has them.
const oc = createSession(user, 'beta', { name: 'opencoder', agent: 'opencode' });
check('records the chosen agent', oc.agent === 'opencode');
throws('rejects an unknown agent', () => createSession(user, 'beta', { name: 'ghost', agent: 'nope' }), 400);
check('defaults to claude', createSession(user, 'beta', { name: 'plainclaude' }).agent === 'claude');

const claudeFresh = launchCommand({ ...a, agent: 'claude' }, { resume: false });
check('claude fresh uses --session-id and --name', claudeFresh === `claude --session-id ${a.claudeSessionId} --name scout`, claudeFresh);
const claudeResume = launchCommand({ ...a, agent: 'claude' }, { resume: true });
check('claude resume uses --resume', claudeResume === `claude --resume ${a.claudeSessionId} --name scout`, claudeResume);
const claudeFork = launchCommand({ ...a, agent: 'claude' }, { resume: true, fork: true });
check('claude fork suffixes the name', claudeFork.endsWith('--fork-session --name scout-fork'), claudeFork);

// The other three: their own real launch commands, with none of Claude Code's session flags
// smuggled in -- passing --session-id to opencode would simply be an error.
check('opencode launches plainly', launchCommand(oc, { resume: false }) === 'opencode', launchCommand(oc, { resume: false }));
check('opencode resume is --continue', launchCommand(oc, { resume: true }) === 'opencode --continue', launchCommand(oc, { resume: true }));
check(
  'no claude flags leak into another agent',
  !launchCommand(oc, { resume: true, fork: true }).includes('--session-id') &&
    !launchCommand(oc, { resume: true, fork: true }).includes('--name'),
  launchCommand(oc, { resume: true, fork: true })
);
check('codex launches plainly', launchCommand({ ...oc, agent: 'codex' }, { resume: true }) === 'codex');
check('deepcode launches plainly', launchCommand({ ...oc, agent: 'deepcode' }, { resume: true }) === 'deepcode');

// delete
deleteSession(user, 'alpha', a.id);
check('deletes', listSessions(user, 'alpha').length === 0);
throws('deleting twice 404s', () => deleteSession(user, 'alpha', a.id), 404);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
