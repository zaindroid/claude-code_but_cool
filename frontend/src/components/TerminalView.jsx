import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// One real PTY per project, kept alive across a tab switch (Terminal vs Preview) by the parent
// never unmounting this while the project is open -- only switching which panel is visible.
// `registerSender`, if given, hands the parent a function that writes a raw string into this
// project's live terminal -- how AgentBar's guided-mode buttons work: they call the exact same
// path a real keystroke would, just from a button instead of the keyboard.
export default function TerminalView({ project, active, registerSender }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);
  const sessionIdRef = useRef(`${project}-${Math.random().toString(36).slice(2)}`);

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
    const ws = new WebSocket(
      `${proto}://${window.location.host}/ws/terminal?project=${encodeURIComponent(project)}&sessionId=${sessionIdRef.current}&cols=${term.cols}&rows=${term.rows}`
    );
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'data') term.write(msg.data);
      else if (msg.type === 'exit') term.write(`\r\n\x1b[2m[process exited]\x1b[0m\r\n`);
    };
    ws.onclose = () => term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');

    if (registerSender) {
      registerSender(project, (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
    }

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const resize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      onData.dispose();
      ws.close();
      term.dispose();
      if (registerSender) registerSender(project, null);
    };
    // Intentionally runs once per mounted project -- a project's terminal is created when its tab
    // first opens and torn down only when the project itself is closed, not on every active toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    if (active && fitRef.current) {
      // A hidden xterm can't measure itself correctly; re-fit the moment it becomes visible again.
      requestAnimationFrame(() => fitRef.current.fit());
    }
  }, [active]);

  return <div className={`terminal-pane ${active ? '' : 'is-hidden'}`} ref={containerRef} />;
}
