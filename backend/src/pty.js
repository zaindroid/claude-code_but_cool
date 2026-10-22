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
import { projectPath } from './projects.js';
import { providerEnv } from './settings.js';

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

export function attachTerminal(ws, user, { project, session, sessionId, cols, rows }) {
  const cwd = projectPath(user, project);
  if (!cwd) {
    ws.close(4004, 'Unknown project');
    return;
  }

  const key = terminalKey(user, { project, session, sessionId });
  let entry = terminals.get(key);

  if (entry) {
    // Reattaching: cancel any pending teardown and replay what the shell has said recently, so
    // the new viewer sees the live state instead of an empty pane.
    clearTimeout(entry.timeout);
    entry.timeout = null;
    if (entry.chunks.length) send(ws, { type: 'data', data: entry.chunks.join('') });
  } else {
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
      },
    });

    entry = { term, viewers: new Set(), chunks: [], bytes: 0, onData: null, onExit: null, timeout: null, named: Boolean(session) };

    // Registered once per terminal, not once per viewer. The previous version attached a fresh
    // onData listener inside each attach, which was fine while exactly one socket could ever be
    // attached, but double-delivers the moment two viewers share a terminal -- which is now the
    // supported case, not an edge case.
    entry.onData = term.onData((data) => {
      remember(entry, data);
      for (const viewer of entry.viewers) send(viewer, { type: 'data', data });
    });
    entry.onExit = term.onExit(({ exitCode }) => {
      for (const viewer of entry.viewers) send(viewer, { type: 'exit', exitCode });
      destroy(key, entry);
    });

    terminals.set(key, entry);
  }

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
    else if (msg.type === 'resize' && msg.cols && msg.rows) {
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
export function liveSessionNames(user) {
  const prefix = `${user.id}:`;
  const names = new Set();
  for (const [key, entry] of terminals) {
    if (!entry.named || !key.startsWith(prefix)) continue;
    names.add(key.slice(key.indexOf(':s:') + 3));
  }
  return names;
}
