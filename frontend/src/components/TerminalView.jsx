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
      // The same stack as the rest of the app (styles.css's --font). JetBrains Mono used to lead
      // this list and never once loaded: it was linked from Google Fonts while the CSP blocked
      // both the stylesheet and the files, so every terminal has always rendered in the fallback.
      // Naming the fallback is what the terminal actually uses.
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Menlo, Consolas, monospace',
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

    // One socket, re-established on its own when it drops.
    //
    // Without this, a terminal that lost its connection -- a laptop sleeping, a network blip, or a
    // redeploy replacing the container -- printed "[disconnected]" and then sat there dead until
    // someone thought to reload the page, with nothing on screen suggesting that was the fix. Two
    // deploys in one afternoon left every open terminal in exactly that state, which is how this
    // got noticed.
    //
    // Two kinds of close are deliberately told apart. The server going away is not the person's
    // decision, so it heals itself. Their own shell exiting *is* their decision, so it waits to be
    // asked rather than quietly spawning another shell underneath them.
    let socket = null;
    let disposed = false; // the component unmounted -- stop everything, reconnect nothing
    let exited = false; // the shell itself ended, so a close here was expected
    let attempt = 0;
    let retryTimer = null;

    const send = (payload) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    const dim = (text) => `\r\n\x1b[2m${text}\x1b[0m\r\n`;

    function connect({ replacing = false } = {}) {
      // Rebuilt per attempt rather than once: the pane may have been resized while the socket was
      // down, and the server sizes the PTY from these.
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams({ project, cols: String(term.cols), rows: String(term.rows) });
      if (session) params.set('session', session);
      else params.set('sessionId', sessionIdRef.current);
      socket = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`);
      wsRef.current = socket;

      socket.onopen = () => {
        attempt = 0;
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data') {
          term.write(msg.data);
          // The crew rail's "working" face is driven from here -- real output from the real PTY, so
          // a face only looks busy when its agent genuinely just said something. Nothing polls and
          // nothing guesses; a session with no output is honestly shown as resting.
          if (session && onActivity) onActivity(session);
        } else if (msg.type === 'replay') {
          // The shell's recent output, repainted because we just attached (pty.js). On a
          // reconnect it would otherwise land underneath the copy already on screen and double
          // the scrollback, so the pane is cleared first -- but only here, where a replay is
          // actually in hand. Clearing in onopen instead would wipe the scrollback on every
          // reconnect to a terminal that no longer exists, which is exactly what a replaced
          // container gives you: nothing to repaint and an empty screen where your history was.
          if (replacing) term.reset();
          term.write(msg.data);
          if (session && onActivity) onActivity(session);
        } else if (msg.type === 'exit') {
          exited = true;
          term.write(dim('[process exited — press any key for a new shell]'));
        }
      };

      socket.onclose = () => {
        if (disposed || exited) return;
        attempt += 1;
        // Capped, so a long outage settles into a steady retry instead of drifting out to minutes.
        // A redeploy is back well inside a minute, which this rides out untouched.
        const delay = Math.min(500 * 2 ** (attempt - 1), 8000);
        term.write(dim(attempt === 1 ? '[disconnected — reconnecting…]' : `[still reconnecting… attempt ${attempt}]`));
        retryTimer = setTimeout(() => connect({ replacing: true }), delay);
      };
    }

    connect();

    if (registerSender) {
      // Goes through send(), which reads whichever socket is current, rather than capturing this
      // one -- otherwise every palette button would go silent after the first reconnect.
      registerSender(termKey, (data) => send({ type: 'input', data }));
    }

    const onData = term.onData((data) => {
      // The keypress that revives a shell you ended yourself. Swallowed rather than forwarded,
      // because there is nothing on the other end to receive it yet.
      if (exited) {
        exited = false;
        connect({ replacing: true });
        return;
      }
      send({ type: 'input', data });
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
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => requestAnimationFrame(resize), 80);
    });
    observer.observe(containerRef.current);

    return () => {
      // Set first: closing the socket below fires onclose, which would otherwise schedule a
      // reconnect for a terminal that no longer exists.
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      onData.dispose();
      socket?.close();
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
