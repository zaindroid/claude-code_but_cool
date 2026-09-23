// One real PTY per open terminal tab, running an ordinary login shell in the project's own
// directory -- Claude Code is not auto-launched; you type `claude` yourself, exactly like using
// it locally, which is the whole point (no flag-wiring to keep in sync with the real CLI).
import pty from 'node-pty';
import { projectPath } from './projects.js';

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');

// Kept only so a reconnect (a flaky connection, a phone locking) can be told apart from someone
// deliberately closing the tab -- not currently used to resume a session across reconnects (a
// real improvement worth making once this is in daily use), just to avoid killing a live `claude`
// run on a transient WebSocket drop before the grace period below elapses.
const sessions = new Map(); // sessionId -> { term, timeout }
const RECONNECT_GRACE_MS = 60_000;

export function attachTerminal(ws, { project, sessionId, cols, rows }) {
  const cwd = projectPath(project);
  if (!cwd) {
    ws.close(4004, 'Unknown project');
    return;
  }

  let entry = sessionId && sessions.get(sessionId);
  if (entry) {
    clearTimeout(entry.timeout);
  } else {
    const term = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    entry = { term, timeout: null };
    if (sessionId) sessions.set(sessionId, entry);
  }

  const { term } = entry;
  const onData = term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  const onExit = term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    if (sessionId) sessions.delete(sessionId);
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
    if (sessionId && sessions.has(sessionId)) {
      // Give a dropped connection a minute to reconnect (see attachTerminal's own reconnect
      // path above) before actually killing the shell underneath it.
      entry.timeout = setTimeout(() => {
        if (sessions.get(sessionId) === entry) {
          term.kill();
          sessions.delete(sessionId);
        }
      }, RECONNECT_GRACE_MS);
    } else {
      term.kill();
    }
  });
}
