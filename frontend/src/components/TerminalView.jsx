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
export default function TerminalView({ project, session = null, active, registerSender, onActivity, onFreshShell }) {
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
    //
    // Reconnecting on `onclose` alone is not enough, and this is the part that actually left
    // terminals stuck: a WebSocket that dies without a TCP FIN -- wifi dropping, a laptop
    // suspending, a proxy recycling an idle connection, a container being replaced mid-flight --
    // never fires `onclose` in the browser at all. `readyState` sits at OPEN indefinitely while
    // nothing arrives, so every event-driven recovery path is waiting for an event that will
    // never come. The only way out is to stop trusting `readyState` and measure silence instead:
    // ping on a slow tick, treat a long gap with no reply as death, and close the socket
    // ourselves so the existing reconnect path can run.
    let socket = null;
    let disposed = false; // the component unmounted -- stop everything, reconnect nothing
    let exited = false; // the shell itself ended, so a close here was expected
    let attempt = 0;
    let retryTimer = null;
    let lastSeen = Date.now(); // any byte from the server, live output or a pong
    // Comfortably under the ~60-100s idle timeout common to proxies and CDNs, so a quiet terminal
    // keeps its connection by being politely noisy rather than discovering it was dropped.
    const HEARTBEAT_MS = 20_000;
    // Two and a half missed beats. Long enough that a slow tab or a stalled network blip doesn't
    // tear down a healthy connection; short enough that you don't sit staring at a dead one.
    const SILENCE_MS = 50_000;

    const send = (payload) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    const dim = (text) => `\r\n\x1b[2m${text}\x1b[0m\r\n`;

    function connect({ replacing = false, revive = true } = {}) {
      // Any previous socket is cut loose here, handlers first. Without this, connecting while an
      // old socket is still CLOSING leaves that socket to fire its own `onclose` afterwards and
      // schedule a *second* reconnect -- two live sockets on one terminal, which means two
      // viewers server-side and every byte of output arriving twice. Reachable from `revive()`,
      // which deliberately does not wait for a close to complete.
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      }
      // Rebuilt per attempt rather than once: the pane may have been resized while the socket was
      // down, and the server sizes the PTY from these.
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams({ project, cols: String(term.cols), rows: String(term.rows) });
      if (session) params.set('session', session);
      else params.set('sessionId', sessionIdRef.current);
      socket = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`);
      wsRef.current = socket;
      // Counts as a sign of life so the watchdog can also time out a connection that never
      // finishes opening, not just one that goes quiet after opening.
      lastSeen = Date.now();

      socket.onopen = () => {
        attempt = 0;
        lastSeen = Date.now();
      };

      socket.onmessage = (event) => {
        lastSeen = Date.now();
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong') return; // proof of life, nothing to show
        if (msg.type === 'attached') {
          // Which of the two things just happened on the other end (pty.js). Only interesting on
          // a reconnect: `fresh` there means the shell we were talking to is gone and this is a
          // new one, which is exactly the state that used to be invisible -- your agent's
          // conversation still filling the screen above a bash prompt that knows nothing about
          // it. Said plainly instead, and the parent gets the chance to start the agent back up.
          if (msg.fresh) {
            // The notice is only true on a reconnect -- on a first attach there is nothing above
            // the prompt to be history. The revival below is not conditional on that, though:
            // opening a session whose shell died while nobody was watching lands you at a bare
            // prompt with no agent, which is the same dead end arrived at from the other side.
            if (replacing) term.write(dim('[reconnected — new shell, everything above is history]'));
            if (session && revive && onFreshShell) onFreshShell(session, project);
          }
          return;
        }
        if (msg.type === 'data') {
          term.write(msg.data);
          // The crew rail's "working" face is driven from here -- real output from the real PTY, so
          // a face only looks busy when its agent genuinely just said something. Nothing polls and
          // nothing guesses; a session with no output is honestly shown as resting.
          if (session && onActivity) onActivity(session, project);
        } else if (msg.type === 'replay') {
          // The shell's recent output, repainted because we just attached (pty.js). On a
          // reconnect it would otherwise land underneath the copy already on screen and double
          // the scrollback, so the pane is cleared first -- but only here, where a replay is
          // actually in hand. Clearing in onopen instead would wipe the scrollback on every
          // reconnect to a terminal that no longer exists, which is exactly what a replaced
          // container gives you: nothing to repaint and an empty screen where your history was.
          if (replacing) term.reset();
          term.write(msg.data);
          if (session && onActivity) onActivity(session, project);
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

    // The watchdog. Runs for the life of the component rather than per socket, so there is exactly
    // one of it no matter how many reconnects happen.
    const beat = setInterval(() => {
      if (disposed || exited) return;
      if (!socket) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        // A socket can hang here indefinitely -- the TCP connect succeeds but the HTTP upgrade
        // never completes, which is what a server mid-restart or a proxy accepting without
        // forwarding looks like. It is not OPEN, so the silence check below never sees it, and no
        // close arrives to trigger a retry: another way to sit stuck forever. Given up on at the
        // same deadline as a silent open socket.
        if (Date.now() - lastSeen > SILENCE_MS) socket.close();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return; // closing/closed: onclose owns the retry
      if (Date.now() - lastSeen > SILENCE_MS) {
        // Silent long enough to call it: close it ourselves, which fires onclose and hands this
        // to the same backoff that handles an honest disconnect. Deliberately not reconnecting
        // directly from here -- one reconnect path, not two.
        socket.close();
        return;
      }
      send({ type: 'ping' });
    }, HEARTBEAT_MS);

    // A suspended laptop or a closed lid freezes the timer above, so waking up can land with a
    // socket that has been dead for hours and a watchdog that has not ticked once. These two
    // events are the moment a person is most likely to be looking at the terminal, so they get an
    // immediate check rather than waiting up to a full beat for one.
    const revive = () => {
      if (disposed || exited) return;
      if (socket && socket.readyState === WebSocket.OPEN) {
        // Looks fine, but "looks fine" is exactly the failure mode. Anything older than a beat
        // has not been confirmed since before the machine slept.
        if (Date.now() - lastSeen > HEARTBEAT_MS) socket.close();
        else send({ type: 'ping' });
        return;
      }
      if (socket && socket.readyState === WebSocket.CONNECTING) return;
      // Dead and waiting on a backoff that may have grown to seconds. Skip the wait: somebody is
      // watching now.
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      attempt = 0;
      connect({ replacing: true });
    };
    const onVisible = () => {
      if (!document.hidden) revive();
    };
    window.addEventListener('online', revive);
    window.addEventListener('focus', revive);
    document.addEventListener('visibilitychange', onVisible);

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
        // revive:false -- you ended this shell on purpose, so the new one is yours to use.
        // Everywhere else a fresh shell means something broke; here it means you asked.
        connect({ replacing: true, revive: false });
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
      clearInterval(beat);
      window.removeEventListener('online', revive);
      window.removeEventListener('focus', revive);
      document.removeEventListener('visibilitychange', onVisible);
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
