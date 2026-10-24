// Integration test for sessions.js against a real temp filesystem.
// chownToUser is fs.chownSync, which can't work on Windows -- stub it via a module mock by
// pointing at a copy of osUsers that no-ops. Simplest portable approach: patch fs.chownSync.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

fs.chownSync = () => {}; // no-op: this test is about session records, not ownership

const { createSession, listSessions, listAllSessions, updateSession, deleteSession, findSessionByName, readSessions, launchCommand, sessionDir, transcriptPath } =
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
// DeepCode is the one agent Codez prepares before launching, because it refuses to start at all
// until its own config file exists and says so in twelve lines of debug output. The guard matters
// as much as the init: running `deepcode init` unconditionally would reset a config the account
// has already put a provider key into.
const dcLaunch = launchCommand({ ...oc, agent: 'deepcode' }, { resume: true });
check('deepcode still ends by launching deepcode', dcLaunch.endsWith('; deepcode'), dcLaunch);
check('deepcode inits when its config is missing', dcLaunch.includes('deepcode init'), dcLaunch);
check('deepcode does not init over an existing config', dcLaunch.includes('[ -f ~/.deepcode/deepcode_config.json ] ||'), dcLaunch);

// --- per-agent folders -----------------------------------------------------------------------
// Each agent works in its own directory inside the project, so a crew does not share one tree.
const projAlpha = path.join(user.projectsDir, 'alpha');
check('creates the agent its own folder', fs.statSync(path.join(projAlpha, 'scout')).isDirectory());
check('records the folder on the session', a.dir === 'scout', String(a.dir));
check('sessionDir resolves inside the project', sessionDir(projAlpha, a) === path.join(projAlpha, 'scout'));
check('creates shared/ alongside it', fs.statSync(path.join(projAlpha, 'shared')).isDirectory());
check('shared/ explains itself', fs.readFileSync(path.join(projAlpha, 'shared', 'README.md'), 'utf8').includes('../shared'));

// The reason `shared` is reserved: it would otherwise be handed the common folder as its workspace.
throws('rejects a session named shared', () => createSession(user, 'alpha', { name: 'shared' }), 400);

// Load-bearing: a session with no `dir` predates folders and must keep working in the project
// root, because its transcript slug was derived from that path and moving it would orphan it.
check('legacy session falls back to the project root', sessionDir(projAlpha, { name: 'old' }) === projAlpha);
check('no session at all falls back too', sessionDir(projAlpha, null) === projAlpha);

// The transcript slug has to follow the folder, not the project -- that is the whole reason
// sessionDir exists rather than pty.js just joining a path.
const slugOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
check(
  'transcript path follows the agent folder',
  transcriptPath(user, projAlpha, a) === path.join(root, '.claude', 'projects', slugOf(path.join(projAlpha, 'scout')), a.claudeSessionId + '.jsonl'),
  transcriptPath(user, projAlpha, a)
);
check(
  'a legacy session still resolves to the project slug',
  transcriptPath(user, projAlpha, { claudeSessionId: 'x' }) === path.join(root, '.claude', 'projects', slugOf(projAlpha), 'x.jsonl')
);

// Renaming must not move anything on disk: the folder is stored, not derived from the name.
updateSession(user, 'alpha', a.id, { name: 'scouty' });
const movedName = findSessionByName(user, 'scouty');
check('rename leaves the folder where it was', movedName.dir === 'scout', String(movedName.dir));
check('renamed session still has its folder on disk', fs.existsSync(path.join(projAlpha, 'scout')));
updateSession(user, 'alpha', a.id, { name: 'scout' });

// delete
deleteSession(user, 'alpha', a.id);
check('deleting a session leaves its files alone', fs.existsSync(path.join(projAlpha, 'scout')));
check('deletes', listSessions(user, 'alpha').length === 0);
throws('deleting twice 404s', () => deleteSession(user, 'alpha', a.id), 404);

// --- purge ---------------------------------------------------------------------------------
// `deleteSession` with purge deletes what the session owned. These are the tests that matter most
// in this file, because this is the only place in the app that removes a directory recursively.

const p1 = createSession(user, 'alpha', { name: 'purgeme' });
const p1dir = path.join(projAlpha, p1.dir);
const p1transcript = transcriptPath(user, projAlpha, p1);
fs.mkdirSync(path.dirname(p1transcript), { recursive: true });
fs.writeFileSync(p1transcript, '{"ok":true}');
fs.writeFileSync(path.join(p1dir, 'work.txt'), 'some work');

const purged = deleteSession(user, 'alpha', p1.id, { purge: true });
check('purge reports the folder it deleted', purged.folder === p1.dir, String(purged.folder));
check('purge reports the transcript it deleted', purged.transcript === true);
check('purge deleted the folder', !fs.existsSync(p1dir));
check('purge deleted the transcript', !fs.existsSync(p1transcript));
check('purge left the project itself alone', fs.existsSync(projAlpha));

// The one that would be catastrophic. A session predating folder-per-agent has no `dir` and works
// in the project root, so purging it must delete the transcript and nothing else -- deleting the
// "session's folder" there would take the project and every other session in it.
// Written straight into sessions.json, because `dir` is deliberately not in updateSession's
// whitelist -- a session's folder is not something a request may re-point. These records have to
// be forged to exist at all, which is itself a small reassurance.
const sfile = path.join(projAlpha, '.codez', 'sessions.json');
const forceDir = (name, dir) => {
  const data = JSON.parse(fs.readFileSync(sfile, 'utf8'));
  data.sessions = data.sessions.map((s) => (s.name === name ? { ...s, dir } : s));
  fs.writeFileSync(sfile, JSON.stringify(data, null, 2));
};

createSession(user, 'alpha', { name: 'oldtimer' });
forceDir('oldtimer', null);
const legacyRecord = findSessionByName(user, 'oldtimer');
fs.writeFileSync(path.join(projAlpha, 'precious.txt'), 'do not delete me');
const legacyPurge = deleteSession(user, 'alpha', legacyRecord.id, { purge: true });
check('purging a root-dir session reports no folder', legacyPurge.folder === null, String(legacyPurge.folder));
check('purging a root-dir session does NOT delete the project', fs.existsSync(projAlpha));
check('purging a root-dir session leaves the project files', fs.existsSync(path.join(projAlpha, 'precious.txt')));

// A traversal in `dir` must not escape the project, however it got there.
createSession(user, 'alpha', { name: 'escapee' });
forceDir('escapee', path.join('..', 'beta'));
const evilRecord = findSessionByName(user, 'escapee');
const evilPurge = deleteSession(user, 'alpha', evilRecord.id, { purge: true });
check('a traversal in dir is refused', evilPurge.folder === null, String(evilPurge.folder));
check('the sibling project survives', fs.existsSync(path.join(user.projectsDir, 'beta')));

// Without purge, nothing on disk moves -- the long-standing default.
const keep = createSession(user, 'alpha', { name: 'keeper' });
const keepDir = path.join(projAlpha, keep.dir);
const keepTranscript = transcriptPath(user, projAlpha, keep);
fs.mkdirSync(path.dirname(keepTranscript), { recursive: true });
fs.writeFileSync(keepTranscript, '{"ok":true}');
const kept = deleteSession(user, 'alpha', keep.id);
check('a plain delete reports nothing purged', kept.folder === null && kept.transcript === false);
check('a plain delete keeps the folder', fs.existsSync(keepDir));
check('a plain delete keeps the transcript', fs.existsSync(keepTranscript));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
