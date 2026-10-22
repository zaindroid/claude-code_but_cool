// Tests for the one new signal behind the crew rail's Resume button: whether a session's terminal
// has a program in the foreground, read out of /proc.
//
// This gets a test file of its own because its failure mode is silent. Every field of
// /proc/<pid>/stat is a bare integer, so reading the wrong offset returns a perfectly plausible
// number and nothing throws -- you just get a Resume button that is wrong, either offering to
// start an agent that is already running or hiding when one is needed. The fixtures below are real
// shapes, including the two that break naive parsers.
import path from 'node:path';

const { parseProcStat, hasForegroundJob } = await import(
  'file://' + path.resolve('backend/src/pty.js').split(path.sep).join('/')
);

let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('PASS  ' + label);
  } else {
    fail++;
    console.log('FAIL  ' + label + (extra ? '  :: ' + extra : ''));
  }
};

// Copied verbatim from the live container (docker exec … cat /proc/self/stat), which is how the
// offsets were confirmed in the first place. ppid 0 because docker exec's parent is outside the
// namespace; tpgid -1 because it has no controlling terminal.
const REAL = '33512 (node) R 0 33512 33512 0 -1 4194560 3172 0 0 0 3 0 0 0 20 0 7 0 435767099 744583168';
const real = parseProcStat(REAL);
check('real sample: ppid', real.ppid === 0, JSON.stringify(real));
check('real sample: pgrp', real.pgrp === 33512, JSON.stringify(real));
check('real sample: tty', real.tty === 0, JSON.stringify(real));
check('real sample: tpgid', real.tpgid === -1, JSON.stringify(real));

// A bash sitting at a prompt on a pty: the foreground group IS the shell's own group.
const atPrompt = parseProcStat('2001 (bash) S 2000 2001 2001 34816 2001 4194304 900 0 0 0 1 0 0 0 20 0 1 0 999 0');
check('at a prompt: parsed', atPrompt.ppid === 2000 && atPrompt.pgrp === 2001 && atPrompt.tpgid === 2001);
check('at a prompt: NOT busy', hasForegroundJob(atPrompt) === false);

// The same bash with a job running: tpgid moves to the job's group.
const running = parseProcStat('2001 (bash) S 2000 2001 2001 34816 2044 4194304 900 0 0 0 1 0 0 0 20 0 1 0 999 0');
check('with a job: tpgid is the job', running.tpgid === 2044);
check('with a job: busy', hasForegroundJob(running) === true);

// No controlling terminal. -1 is not "a group numbered -1", and treating it as a foreground job
// would mark every session busy forever.
check('no tty: not busy', hasForegroundJob(parseProcStat('5 (sh) S 1 5 5 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 9 0')) === false);
check('tpgid 0: not busy', hasForegroundJob({ pgrp: 7, tpgid: 0 }) === false);

// The two shapes that break splitting on whitespace from the left. comm is arbitrary bytes chosen
// by the process itself, so neither of these is hypothetical.
const spaced = parseProcStat('77 (my weird proc) S 70 77 77 34816 88 0 0 0 0 0 0 0 0 0 20 0 1 0 9 0');
check('comm with spaces: ppid', spaced.ppid === 70, JSON.stringify(spaced));
check('comm with spaces: busy', hasForegroundJob(spaced) === true);

const parens = parseProcStat('78 (proc (with) parens) S 70 78 78 34816 78 0 0 0 0 0 0 0 0 0 20 0 1 0 9 0');
check('comm with parens: pgrp', parens.pgrp === 78, JSON.stringify(parens));
check('comm with parens: not busy', hasForegroundJob(parens) === false);

// Guards the specific mistake this file exists to catch: reading one field over, which for a shell
// at a prompt lands on `session` -- also equal to pgrp -- and so still looks right in that case,
// then silently disagrees everywhere else.
check(
  'offsets are not shifted (tty is read, not session)',
  parseProcStat('2001 (bash) S 2000 2001 2001 34816 2044 x').tty === 34816
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
