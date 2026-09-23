// One real PTY per open terminal tab, running an ordinary login shell in the project's own
// directory, as that Forge account's own Linux user -- this is the actual isolation boundary
// between users, enforced by the kernel, not by this file remembering to check who is allowed to
// see what. Claude Code is not auto-launched; you type `claude` yourself, exactly like using it
// locally, which is the whole point (no flag-wiring to keep in sync with the real CLI).
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

const SHELL = process.env.SHELL || 'bash';

// Kept only so a reconnect (a flaky connection, a phone locking) can be told apart from someone
// deliberately closing the tab -- not currently used to resume a session across reconnects (a
// real improvement worth making once this is in daily use), just to avoid killing a live `claude`
// run on a transient WebSocket drop before the grace period below elapses.
const sessions = new Map(); // sessionId -> { term, timeout }
const RECONNECT_GRACE_MS = 60_000;

export function attachTerminal(ws, user, { project, sessionId, cols, rows }) {
  const cwd = projectPath(user, project);
  if (!cwd) {
    ws.close(4004, 'Unknown project');
    return;
  }

  let entry = sessionId && sessions.get(`${user.id}:${sessionId}`);
  if (entry) {
    clearTimeout(entry.timeout);
  } else {
    // Read fresh on every new terminal, not cached at startup, so a settings change applies to
    // the next terminal opened without needing to restart the whole app -- an already-running
    // shell keeps whatever env it started with, same as exporting a variable in any real shell.
    const term = pty.spawn('su', [user.linuxUsername, '-s', SHELL], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: { HOME: user.homeDir, USER: user.linuxUsername, PATH: process.env.PATH, TERM: 'xterm-256color', ...providerEnv(user) },
    });
    entry = { term, timeout: null };
    if (sessionId) sessions.set(`${user.id}:${sessionId}`, entry);
  }

  const { term } = entry;
  const onData = term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  const onExit = term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    if (sessionId) sessions.delete(`${user.id}:${sessionId}`);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'input') term.write(msg.data);
    else if (msg.type === 'resize' && msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
  });

  ws.on('close', () => {
    onData.dispose();
    onExit.dispose();
    const key = `${user.id}:${sessionId}`;
    if (sessionId && sessions.has(key)) {
      // Give a dropped connection a minute to reconnect (see attachTerminal's own reconnect
      // path above) before actually killing the shell underneath it.
      entry.timeout = setTimeout(() => {
        if (sessions.get(key) === entry) {
          term.kill();
          sessions.delete(key);
        }
      }, RECONNECT_GRACE_MS);
    } else {
      term.kill();
    }
  });
}
