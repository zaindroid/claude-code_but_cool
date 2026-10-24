// One real PTY per terminal, running an ordinary login shell in the project's own directory, as
// that Codez account's own Linux user -- this is the actual isolation boundary between users,
// enforced by the kernel, not by this file remembering to check who is allowed to see what.
// Claude Code is not auto-launched; you type `claude` yourself (or press a button that types it
// for you -- see sessions.js's launchCommand), exactly like using it locally, which is the whole
// point: no flag-wiring here to keep in sync with the real CLI.
//
// Spawned via `su`, not node-pty's own uid/gid spawn options -- live-verified 2026-09-23 that
// those alone are not enough: Node's child_process (and node-pty underneath it) call setuid/
// setgid on the forked child but never initgroups(), so the child silently keeps the *parent*
// process's supplementary groups. Since the parent here is root, that meant every "isolated"
// user's shell was still a member of the root group. `su` is the real, standard tool for
// switching users properly (it calls initgroups() itself) -- used here without the login (`-`)
// flag, so it does not also reset cwd/environment, which stay under this file's own control.
import pty from 'node-pty';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { projectPath } from './projects.js';
import { listSessions, sessionDir } from './sessions.js';
import { providerEnv, deepcodeEnv } from './settings.js';

// A full path, not a bare command name: `su -s` doesn't do a $PATH lookup the way exec-by-name
// normally does, and $SHELL isn't set in this container to begin with -- live-caught 2026-09-23
// ("su: failed to execute bash: No such file or directory") the first time a terminal was opened
// through the real UI after the switch to su-based spawning.
const SHELL = process.env.SHELL || '/bin/bash';

// Two different lifetimes, because there are now two different kinds of terminal.
//
// An anonymous terminal is tied to a browser tab: its grace period exists only so a flaky
// connection or a phone locking doesn't kill a live `claude` run, so a minute is plenty.
//
// A *named session* (sessions.js) is the opposite -- it is meant to be a thing that keeps
// existing while you close the laptop, which is the whole premise of teleporting one and of
// another agent being able to message it by name while you aren't watching. It still has to end
// eventually or an idle container slowly fills with forgotten shells, so it gets a long idle
// grace rather than no grace at all. Overridable because the right number depends on how much
// memory this app has been given, which has already changed once (768MB declared, 4096MB
// actually enforced -- see AGENT_CONTEXT/DEPLOYMENT.md).
const RECONNECT_GRACE_MS = 60_000;
const SESSION_IDLE_GRACE_MS = Number(process.env.SESSION_IDLE_GRACE_MS) || 6 * 60 * 60 * 1000;

// How much recent output to keep per terminal so a second viewer -- or the same viewer after a
// reload -- doesn't attach to a blank screen. xterm.js holds its own scrollback client-side, but
// that dies with the tab; this is the server-side replay that makes reattaching feel like
// reconnecting to something still running rather than starting over. Bounded in bytes, not lines,
// because a single line of a progress spinner can be enormous.
const REPLAY_BYTES = 256 * 1024;

// key -> { term, viewers:Set<ws>, chunks:string[], bytes, onData, onExit, timeout, named }
const terminals = new Map();

// Protocol-level keepalive, separate from the client's own JSON heartbeat and doing a job that
// one cannot: proving to *this* side that a viewer still exists. A browser that is closed by
// pulling the network, sleeping, or being force-quit leaves a socket that is dead but never
// reports it, and a dead viewer that stays in `viewers` is worse than a leak -- `viewers.size`
// stays above zero, so the teardown clock below never arms and that shell lives until the process
// does. One missed ping is forgiven (a tick can land mid-reconnect); two is taken as gone.
const PING_MS = 25_000;
setInterval(() => {
  for (const entry of terminals.values()) {
    for (const ws of entry.viewers) {
      if (ws.codezAlive === false) {
        // Fires 'close', which removes it from `viewers` and arms the grace period properly --
        // the same path a clean disconnect takes, so there is only one teardown route to reason
        // about.
        ws.terminate();
        continue;
      }
      ws.codezAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }
}, PING_MS).unref(); // never the reason this process stays alive

function terminalKey(user, { project, session, sessionId }) {
  // A named session's key is its *name*, scoped to the project and account -- stable across
  // reloads, which is what makes reattaching possible at all. An anonymous terminal keys on the
  // random per-tab id the frontend mints, which is per-mount and therefore deliberately not
  // stable: closing that tab is meant to end that terminal.
  return session ? `${user.id}:${project}:s:${session}` : `${user.id}:t:${sessionId}`;
}

function remember(entry, data) {
  entry.chunks.push(data);
  entry.bytes += data.length;
  while (entry.bytes > REPLAY_BYTES && entry.chunks.length > 1) {
    entry.bytes -= entry.chunks.shift().length;
  }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function destroy(key, entry) {
  entry.onData?.dispose();
  entry.onExit?.dispose();
  try {
    entry.term.kill();
  } catch {
    // Already gone -- the shell exiting on its own is the normal case here, not an error.
  }
  if (terminals.get(key) === entry) terminals.delete(key);
}

// Ends a named session's shell now, instead of waiting out SESSION_IDLE_GRACE_MS.
//
// That grace is six hours, which is right for "I closed the tab and want to come back to it" and
// wrong for everything else: until this existed, stopping an agent was a thing you could want and
// had no way to say. Closing the window armed a timer; it did not end anything.
//
// Viewers are told before the shell goes, so a tab that is still open shows an exit rather than
// quietly going dead. destroy() disposes the onExit handler first, so this message is the only one
// they get, not a duplicate.
export function killTerminal(user, project, session) {
  const key = terminalKey(user, { project, session });
  const entry = terminals.get(key);
  if (!entry) return { wasRunning: false };
  if (entry.timeout) clearTimeout(entry.timeout);
  for (const viewer of entry.viewers) send(viewer, { type: 'exit', exitCode: 0, reason: 'quit' });
  destroy(key, entry);
  return { wasRunning: true };
}

// Gets the terminal for this session, starting one if there isn't one.
//
// Split out of attachTerminal because a shell is no longer something only a WebSocket can bring
// into being: waking a session does it too, from an HTTP request, possibly with no browser
// attached at all. Everything here is deliberately independent of who asked.
//
// `fresh` is the one fact a caller cannot work out for itself and most needs: is this the shell it
// was talking to a moment ago, or a brand new one? Both look identical from outside -- a terminal
// that exists -- but they mean opposite things. A reattach means the agent is still running and
// mid-thought. A fresh shell means it is gone and the conversation above the prompt is history.
// Leaving the client to guess is what made a redeploy feel like the session had died: the
// scrollback still showed Claude, so you typed at it.
function ensureTerminal(user, { project, session, sessionId, cols, rows }) {
  const projectDir = projectPath(user, project);
  if (!projectDir) return null;

  // A named session opens in its own folder; a plain terminal, and any session made before
  // folders existed, opens in the project root. The existence check is not paranoia: the folder
  // is on the same disk a user can delete things from through the file browser or the shell
  // itself, and a cwd that has been removed makes the spawn fail with an errno rather than
  // anything that reads as "your folder is gone". Falling back to the project keeps the terminal
  // usable, which is the state someone can actually fix the problem from.
  const record = session ? (listSessions(user, project) || []).find((s) => s.name === session) : null;
  const wanted = sessionDir(projectDir, record);
  const cwd = existsSync(wanted) ? wanted : projectDir;

  const key = terminalKey(user, { project, session, sessionId });
  let entry = terminals.get(key);
  const fresh = !entry;

  if (entry) {
    // Cancel any pending teardown so a live shell isn't torn down underneath whoever just arrived.
    clearTimeout(entry.timeout);
    entry.timeout = null;
    return { key, entry, fresh };
  }

  // Read fresh on every new terminal, not cached at startup, so a settings change applies to
  // the next terminal opened without needing to restart the whole app -- an already-running
  // shell keeps whatever env it started with, same as exporting a variable in any real shell.
  const term = pty.spawn('su', [user.linuxUsername, '-s', SHELL], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: {
      HOME: user.homeDir,
      USER: user.linuxUsername,
      PATH: process.env.PATH,
      TERM: 'xterm-256color',
      // Lets anything running inside the shell know which named session it is -- including the
      // session itself, so a skill or hook can identify its own crew name without being told.
      ...(session ? { CODEZ_SESSION: session, CODEZ_PROJECT: project } : {}),
      ...providerEnv(user),
      // DeepCode's key, which its config refers to as ${DEEPCODE_API_KEY} rather than holding
      // (deepcode.js). Separate from the block above on purpose: nothing here may end up in an
      // ANTHROPIC_* variable, because that is what takes Claude Code off its subscription login.
      ...deepcodeEnv(user),
    },
  });

  entry = { term, viewers: new Set(), chunks: [], bytes: 0, onData: null, onExit: null, timeout: null, named: Boolean(session), spoke: false };

  // Registered once per terminal, not once per viewer. The previous version attached a fresh
  // onData listener inside each attach, which was fine while exactly one socket could ever be
  // attached, but double-delivers the moment two viewers share a terminal -- which is now the
  // supported case, not an edge case.
  entry.onData = term.onData((data) => {
    entry.spoke = true;
    remember(entry, data);
    for (const viewer of entry.viewers) send(viewer, { type: 'data', data });
  });
  entry.onExit = term.onExit(({ exitCode }) => {
    for (const viewer of entry.viewers) send(viewer, { type: 'exit', exitCode });
    destroy(key, entry);
  });

  terminals.set(key, entry);
  // A shell with no viewer would otherwise sit forever: the reaper only arms when the last viewer
  // leaves, and one that never had a viewer never leaves. Named sessions are exempt because they
  // are meant to outlive the tab -- that is the whole point of waking one without a browser.
  if (!session) {
    entry.timeout = setTimeout(() => {
      if (terminals.get(key) === entry && entry.viewers.size === 0) destroy(key, entry);
    }, RECONNECT_GRACE_MS);
  }
  return { key, entry, fresh };
}

// Types a command into a session's shell, starting the shell first if it is not running.
//
// This exists because the browser could not be trusted to do it. Resuming used to mean the page
// typing the command itself, which depended on a chain of things that are all true most of the
// time: the terminal pane mounted, its send function registered, and -- for a shell that had just
// started -- an output event arriving within eight seconds, or the command was discarded without a
// word. Worst of all was the case someone actually hits: quit Claude, and the shell sits at a bare
// prompt emitting nothing ever again, so a wake armed on "first output" waited for a byte that was
// never coming.
//
// The server has none of those problems. It holds the pty, it sees the prompt itself, and it does
// not need a tab to be open to do any of this.
export async function wakeSession(user, { project, session, command, cols, rows }) {
  const found = ensureTerminal(user, { project, session, cols, rows });
  if (!found) return null;
  const { entry, fresh } = found;

  // A shell that has just been spawned is not reading yet, and a command written into it before
  // then is simply lost. Its first byte is the prompt, which is the real "ready" signal -- better
  // than a fixed delay, which would either fire too early or wait longer than it needs to. The
  // timeout is a floor, not the plan: if the shell has somehow said nothing by then, writing
  // anyway beats silently doing nothing, which is the behaviour being fixed here.
  if (fresh && !entry.spoke) {
    await new Promise((resolve) => {
      const done = () => {
        clearInterval(poll);
        clearTimeout(cap);
        resolve();
      };
      const poll = setInterval(() => entry.spoke && done(), 40);
      const cap = setTimeout(done, 3000);
    });
  }

  entry.term.write(`${command}\r`);
  return { startedShell: fresh, command };
}

export function attachTerminal(ws, user, { project, session, sessionId, cols, rows }) {
  const found = ensureTerminal(user, { project, session, sessionId, cols, rows });
  if (!found) {
    ws.close(4004, 'Unknown project');
    return;
  }
  // `fresh` now means "this very call started the shell", which is slightly narrower than before
  // and is the correct reading. A session woken from an HTTP request runs for a moment with no
  // viewer, so the tab that arrives afterwards is a reattach, not a fresh shell -- and gets the
  // replay, which is exactly right: the wake's own output is what it needs to see.
  const { key, entry, fresh } = found;

  ws.codezAlive = true;
  ws.on('pong', () => {
    ws.codezAlive = true;
  });

  send(ws, { type: 'attached', fresh });
  // Sent as its own message type, not as plain `data`, so the client can tell a repaint of
  // history from live output. It needs to: on a *re*connect it clears the pane first so the
  // replay is authoritative instead of stacking on the copy already there -- and it must only do
  // that when a replay is genuinely coming. A fresh shell gets no replay, and clearing there
  // would throw away the scrollback the person still wants to read.
  if (!fresh && entry.chunks.length) send(ws, { type: 'replay', data: entry.chunks.join('') });

  entry.viewers.add(ws);
  const current = entry;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'input') current.term.write(msg.data);
    else if (msg.type === 'ping') {
      // The other half of the client's heartbeat (TerminalView). Answered rather than ignored
      // because the answer is the whole point: it is the only thing that proves to the browser
      // that this socket still reaches a live server. A terminal nobody is typing in sends no
      // bytes in either direction, and a silent socket is indistinguishable from a dead one --
      // which is what left terminals looking connected and stuck. This also keeps the connection
      // non-idle, so nothing between here and the browser recycles it for being quiet.
      send(ws, { type: 'pong' });
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      // Last resize wins when several viewers watch one terminal at different window sizes.
      // Honest about the tradeoff: tmux instead clamps to the smallest attached client, which
      // avoids one viewer seeing wrapped output, but a PTY has exactly one size and picking the
      // smallest would shrink the person actively typing to fit someone's idle phone. The common
      // case here is one active viewer, so the active one wins.
      current.term.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    current.viewers.delete(ws);
    // Only start the teardown clock once nobody is watching -- the previous version armed it on
    // any socket closing, which would have killed a shell another viewer was still using.
    if (current.viewers.size > 0) return;
    current.timeout = setTimeout(
      () => {
        if (terminals.get(key) === current && current.viewers.size === 0) destroy(key, current);
      },
      current.named ? SESSION_IDLE_GRACE_MS : RECONNECT_GRACE_MS
    );
  });
}

// Which named sessions have a shell alive right now, as a real fact rather than something the
// session records claim. Used by /api/sessions so the crew rail can show "awake" vs "asleep"
// without guessing from the transcript, the same way /api/agents checks `command -v` instead of
// trusting that the Dockerfile worked.
// Which named sessions have a program running in the foreground right now, as opposed to sitting
// at a bare shell prompt. A live shell is NOT the same thing as a live agent: exit Claude Code and
// the session is still "awake" by the measure above, with nothing running in it. The crew rail
// used to show those two states identically, which is why resuming meant knowing to type a
// command -- the one piece of information that would have told you otherwise was never read.
//
// Taken from the kernel rather than by pattern-matching process names, which is both simpler and
// not fooled by `vim claude.md`: a terminal's `tpgid` is the process group it is currently giving
// the keyboard to. When the shell is at a prompt, that is the shell's own group. When the shell
// has started a job, it is the job's. So "foreground job running" is exactly `tpgid != pgrp`, and
// it costs one small read per session.
// Exported for its own test. Split out because the failure mode here is not a crash: every field
// of /proc/stat is a bare number, so an off-by-one offset reads a plausible value and the only
// symptom is a Resume button that is wrong. Offsets verified against the real /proc inside the
// live container -- `1234 (node) R 0 1234 1234 0 -1 ...` -- not from memory.
export function parseProcStat(raw) {
  // comm (field 2) is wrapped in parens and may itself contain spaces or parens, so everything is
  // indexed from the LAST ')' rather than by splitting the whole line -- the classic /proc/stat
  // parsing bug. Field 3 (state) lands at f[0], so each later field is its man-page number minus
  // three.
  const f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(f[1]), pgrp: Number(f[2]), tty: Number(f[4]), tpgid: Number(f[5]) };
}

// A terminal's tpgid is the process group it is currently handing the keyboard to. At a prompt
// that is the shell's own group; with a job running it is the job's. -1 means no controlling
// terminal at all, which is not a foreground job either.
export function hasForegroundJob(st) {
  return st.tpgid > 0 && st.tpgid !== st.pgrp;
}

function statOf(pid) {
  return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
}

function shellBusyUnder(rootPid) {
  // rootPid is the `su` we spawned; the shell is its child, and the shell is what owns the
  // terminal's foreground group.
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let st;
    try {
      st = statOf(name);
    } catch {
      continue; // the process ended between readdir and read -- normal, not an error
    }
    if (st.ppid !== rootPid) continue;
    return hasForegroundJob(st);
  }
  return false;
}

export function busySessionNames(user) {
  const prefix = `${user.id}:`;
  const names = new Set();
  for (const [key, entry] of terminals) {
    if (!entry.named || !key.startsWith(prefix)) continue;
    try {
      if (shellBusyUnder(entry.term.pid)) names.add(key.slice(key.indexOf(':s:') + 3));
    } catch {
      // No /proc (a non-Linux dev machine) means this signal is simply unavailable. Reported as
      // "not running" rather than guessed, which costs a visible Resume button on a session that
      // may already have an agent -- a harmless wrong offer, where the opposite mistake would
      // hide the button on a session that genuinely needs it.
    }
  }
  return names;
}

export function liveSessionNames(user) {
  const prefix = `${user.id}:`;
  const names = new Set();
  for (const [key, entry] of terminals) {
    if (!entry.named || !key.startsWith(prefix)) continue;
    names.add(key.slice(key.indexOf(':s:') + 3));
  }
  return names;
}
