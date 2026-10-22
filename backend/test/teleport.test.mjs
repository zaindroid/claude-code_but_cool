// Tests the transcript half of teleport -- the part that must never lose anyone's conversation.
// chownSync is stubbed because this runs on Windows and the question here is sync semantics, not
// file ownership.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

fs.chownSync = () => {};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-tp-'));
process.env.DATA_DIR = path.join(root, 'data');

const url = (f) => 'file://' + path.resolve('backend/src/' + f).replace(/\\/g, '/');
const { transcriptMeta, appendTranscript, readTranscriptFrom } = await import(url('teleport.js'));
const { sanitizedClaudeSessionDir } = await import(url('agents.js'));

const user = { id: 'u1', uid: 1000, gid: 1000, homeDir: path.join(root, 'home'), linuxUsername: 'u1', username: 'u1' };
const projectDir = path.join(root, 'home', 'projects', 'demo');
fs.mkdirSync(projectDir, { recursive: true });
const session = { claudeSessionId: crypto.randomUUID() };

let p = 0, f = 0;
const ck = (l, c, extra = '') => (c ? (p++, console.log('PASS  ' + l)) : (f++, console.log('FAIL  ' + l + (extra ? '  :: ' + extra : ''))));
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const line = (i) => JSON.stringify({ type: 'msg', i });

// --- empty state
let meta = transcriptMeta(user, projectDir, session);
ck('empty transcript reports 0 lines', meta.lines === 0);
ck('empty transcript has no sha', meta.sha === null);

// --- first append creates the slug dir in the right place
const L = [line(0), line(1), line(2)];
let r = appendTranscript(user, projectDir, session, 0, L);
ck('appended 3', r.appended === 3 && r.lines === 3, JSON.stringify(r));
const expectedDir = sanitizedClaudeSessionDir(user.homeDir, projectDir);
const expectedFile = path.join(expectedDir, `${session.claudeSessionId}.jsonl`);
ck('wrote to the exact path claude --resume reads', fs.existsSync(expectedFile), expectedFile);

// --- no phantom line from the trailing newline. An off-by-one here would make every sync look
// like a divergence, which is the single most damaging bug this module could have.
meta = transcriptMeta(user, projectDir, session);
ck('line count ignores the trailing newline', meta.lines === 3, `got ${meta.lines}`);
ck('sha covers the real content', meta.sha === sha(L.join('\n')));

// --- the compare-and-append guard
try {
  appendTranscript(user, projectDir, session, 0, [line(99)]);
  ck('stale fromLine is refused', false);
} catch (e) {
  ck('stale fromLine is refused with 409', e.status === 409, `status ${e.status}`);
  ck('409 reports the real current count so the caller can re-decide', e.lines === 3, `lines ${e.lines}`);
}
ck('refused append did not alter the file', transcriptMeta(user, projectDir, session).lines === 3);

try {
  appendTranscript(user, projectDir, session, 9, [line(99)]);
  ck('fromLine past the end is refused', false);
} catch (e) {
  ck('fromLine past the end is refused', e.status === 409);
}

// --- correct append continues
r = appendTranscript(user, projectDir, session, 3, [line(3), line(4)]);
ck('append at the right offset works', r.lines === 5 && r.appended === 2);
ck('content is exactly the 5 lines in order', fs.readFileSync(expectedFile, 'utf8') === [...L, line(3), line(4)].join('\n') + '\n');

// --- prefix hashing is what distinguishes "behind" from "diverged"
meta = transcriptMeta(user, projectDir, session, 3);
ck('prefixSha(3) equals the hash of the first 3 lines', meta.prefixSha === sha(L.join('\n')));
ck('prefix is clamped to the request', meta.prefix === 3);
const over = transcriptMeta(user, projectDir, session, 500);
ck('prefix larger than the file clamps to the file', over.prefix === 5);

// The real scenario: a side that is strictly behind shares a prefix; a diverged side does not.
const behind = [...L, line(3)];
ck('a strictly-behind copy matches the prefix at its own length',
   sha(behind.join('\n')) === transcriptMeta(user, projectDir, session, 4).prefixSha);
const diverged = [...L, JSON.stringify({ type: 'msg', i: 'different' })];
ck('a diverged copy does NOT match the prefix at the same length',
   sha(diverged.join('\n')) !== transcriptMeta(user, projectDir, session, 4).prefixSha);

// --- reads
const from2 = readTranscriptFrom(user, projectDir, session, 2);
ck('read from offset returns the tail', from2.lines.length === 3 && from2.total === 5);
ck('read from 0 returns everything', readTranscriptFrom(user, projectDir, session, 0).lines.length === 5);
ck('negative offset is treated as 0', readTranscriptFrom(user, projectDir, session, -5).lines.length === 5);
ck('read past the end returns nothing, not an error', readTranscriptFrom(user, projectDir, session, 99).lines.length === 0);

// --- empty batch is a no-op rather than an error
r = appendTranscript(user, projectDir, session, 5, []);
ck('empty batch is a no-op', r.appended === 0 && r.lines === 5);
r = appendTranscript(user, projectDir, session, 5, [line(5), '', null, line(6)]);
ck('blank and non-string entries are dropped', r.appended === 2 && r.lines === 7);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
