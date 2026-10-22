// Integration test for tokenUsage.js against a real temp filesystem with real transcript fixtures.
//
// Exists because of a wrong number, not a crash: the trackability gate read the *project's* agent,
// so once a project's crew could mix CLIs a project declared as `deepcode` holding real Claude
// sessions reported "not tracked" and its genuine token usage was discarded. That is exactly the
// class of bug a test is worth having -- nothing throws, the UI just quietly shows nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getUsageForProjects } = await import('file://' + path.resolve('backend/src/tokenUsage.js').split(path.sep).join('/'));
const { sanitizedClaudeSessionDir } = await import('file://' + path.resolve('backend/src/agents.js').split(path.sep).join('/'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-usage-'));
const user = { homeDir: root };

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (extra ? '  :: ' + extra : '')); }
};

// A transcript in the shape Claude Code really writes: usage lives on message.usage, and lines
// that carry none (user turns, meta) must be skipped rather than counted as zero-or-crash.
function writeTranscript(projectDir, uuid, turns) {
  const dir = sanitizedClaudeSessionDir(user.homeDir, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    'not json at all',
    '',
    ...turns.map((u) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: u } })),
  ];
  fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), lines.join('\n'), 'utf8');
  return dir;
}

const mixedDir = path.join(root, 'projects', 'mixed');
const claudeDir = path.join(root, 'projects', 'pure');
const noneDir = path.join(root, 'projects', 'none');
for (const d of [mixedDir, claudeDir, noneDir]) fs.mkdirSync(d, { recursive: true });

writeTranscript(mixedDir, 'aaaaaaaa-0000-0000-0000-000000000001', [
  { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 },
  { input_tokens: 200, output_tokens: 20 },
]);
writeTranscript(claudeDir, 'bbbbbbbb-0000-0000-0000-000000000002', [{ input_tokens: 7, output_tokens: 3 }]);

// The bug, pinned: project declared deepcode, crew is Claude. There IS a real number here.
const [mixed, pure, none, empty] = getUsageForProjects(user, [
  { name: 'mixed', dir: mixedDir, agent: 'deepcode', sessionAgents: ['claude', 'opencode'] },
  { name: 'pure', dir: claudeDir, agent: 'claude', sessionAgents: ['claude'] },
  { name: 'none', dir: noneDir, agent: 'opencode', sessionAgents: ['codex'] },
  { name: 'empty', dir: path.join(root, 'projects', 'gone'), agent: 'claude', sessionAgents: [] },
]);

check('a non-claude project with claude sessions IS tracked', mixed.tracked === true, JSON.stringify(mixed));
check('its tokens are really summed', mixed.totalTokens === 100 + 10 + 5 + 1000 + 200 + 20, String(mixed.totalTokens));
check('cache tokens counted separately', mixed.cacheReadTokens === 1000 && mixed.cacheCreationTokens === 5);
check('lines without usage are skipped, not counted', mixed.inputTokens === 300, String(mixed.inputTokens));
check('a partial total names what it leaves out', JSON.stringify(mixed.untracked) === JSON.stringify(['deepcode', 'opencode']), JSON.stringify(mixed.untracked));
check('estimates a cost', mixed.estimatedCostUsd > 0);

check('an all-claude project is tracked', pure.tracked === true);
check('and claims nothing untracked', JSON.stringify(pure.untracked) === '[]', JSON.stringify(pure.untracked));
check('its total is its own, not the other project\'s', pure.totalTokens === 10, String(pure.totalTokens));

check('a project with no claude anywhere is honestly untracked', none.tracked === false);
check('and names every agent it cannot count', JSON.stringify(none.untracked) === JSON.stringify(['codex', 'opencode']), JSON.stringify(none.untracked));
check('an untracked project reports no fake zero total', none.totalTokens === undefined);

check('a claude project with no transcripts yet is tracked at zero', empty.tracked === true && empty.totalTokens === 0);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
