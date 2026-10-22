import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// One real PTY per terminal, kept alive across a tab switch (Terminal vs Preview) by the parent
// never unmounting this while the project is open -- only switching which panel is visible.
// `registerSender`, if given, hands the parent a function that writes a raw string into this
// terminal -- how AgentBar's and CrewRail's buttons work: they call the exact same path a real
// keystroke would, just from a button instead of the keyboard.
//
// `session`, when given, is a named agent session (sessions.js). It changes the lifetime of what
// is on the other end: the backend keys a named session's PTY by name rather than by a random
// per-tab id, so the shell survives a reload, can take a second viewer, and keeps running while
// nobody is watching. Without it this is the old anonymous terminal, tied to this tab.
export default function TerminalView({ project, session = null, active, registerSender, onActivity }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);
  // Only used for anonymous terminals. Random per mount on purpose -- an anonymous terminal is
  // meant to end with its tab, which is exactly what an unstable key gives you. A named session
  // keys on its name instead, server-side, which is what makes it outlive the tab.
  const sessionIdRef = useRef(`${project}-${Math.random().toString(36).slice(2)}`);
  // Stable identity for this terminal in the parent's sender registry: a project can now have
  // several terminals open at once (one per crew member), so keying senders by project alone
  // would have them overwrite each other.
  const termKey = session ? `${project}::${session}` : project;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13.5,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: 'transparent',
        foreground: '#e8e4d9',
        cursor: '#c96442',
        cursorAccent: '#1a1815',
        selectionBackground: 'rgba(201,100,66,0.35)',
        black: '#1a1815',
        red: '#e0685a',
        green: '#8fbc7e',
        yellow: '#d9b45c',
        blue: '#7ca8c9',
        magenta: '#c48fc9',
        cyan: '#7ec9c0',
        white: '#e8e4d9',
        brightBlack: '#6b6558',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ project, cols: String(term.cols), rows: String(term.rows) });
    if (session) params.set('session', session);
    else params.set('sessionId', sessionIdRef.current);
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'data') {
        term.write(msg.data);
        // The crew rail's "working" face is driven from here -- real output from the real PTY, so
        // a face only looks busy when its agent genuinely just said something. Nothing polls and
        // nothing guesses; a session with no output is honestly shown as resting.
        if (session && onActivity) onActivity(session);
      } else if (msg.type === 'exit') term.write(`\r\n\x1b[2m[process exited]\x1b[0m\r\n`);
    };
    ws.onclose = () => term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');

    if (registerSender) {
      registerSender(termKey, (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
    }

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    // Debounced, and a no-op when the fit didn't actually change the character grid -- both
    // deliberate. This callback observes the same element `fit()` resizes, so calling fit()
    // straight out of the observer lets a sub-pixel font-metric rounding change re-trigger the
    // very observer that caused it: the classic ResizeObserver/auto-fit feedback loop, and the
    // leading suspect for the long-standing live-only flicker in AGENT_CONTEXT/KNOWN_ISSUES.md
    // (25 layout-shift events in 6s, naming unrelated elements from all over the page together at
    // roughly 4Hz -- the signature of repeated whole-page reflow, not one broken component).
    // The timeout coalesces a burst into one fit; the grid guard stops a fit that changed nothing
    // from still sending a resize message and dirtying layout anyway.
    let resizeTimer = null;
    let lastGrid = `${term.cols}x${term.rows}`;
    const resize = () => {
      fit.fit();
      const grid = `${term.cols}x${term.rows}`;
      if (grid === lastGrid) return;
      lastGrid = grid;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => requestAnimationFrame(resize), 80);
    });
    observer.observe(containerRef.current);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      onData.dispose();
      ws.close();
      term.dispose();
      if (registerSender) registerSender(termKey, null);
    };
    // Intentionally runs once per mounted terminal -- a terminal is created when its crew member
    // or project tab first opens and torn down only when that closes, not on every active toggle.
    // Closing this socket does not end a *named* session: the shell behind it stays alive
    // server-side (pty.js), which is the whole point of naming one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, session]);

  useEffect(() => {
    if (active && fitRef.current) {
      // A hidden xterm can't measure itself correctly; re-fit the moment it becomes visible again.
      requestAnimationFrame(() => fitRef.current.fit());
    }
  }, [active]);

  return <div className={`terminal-pane ${active ? '' : 'is-hidden'}`} ref={containerRef} />;
}
