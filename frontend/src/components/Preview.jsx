import { useEffect, useRef, useState } from 'react';

// Where an agent's work becomes something you can look at.
//
// This panel used to open on an empty box asking which port your dev server was on. That is a
// question the server can answer exactly -- every Codez account runs as its own Linux uid, and the
// kernel will say which ports that uid is listening on (ports.js) -- so it asks the server instead
// and shows you the answer. An agent runs `npm run dev`; a few seconds later its address is in
// this list, named after the process holding it. Nobody had to read the port out of the scrollback.
//
// The manual entry is still here, below, because detection has one real blind spot: a server
// bound inside something the uid check cannot see through. It is a fallback now rather than the
// front door.
// `ports` is polled once in App rather than here, so the status line can light up the moment a
// server appears -- which is the point. You find out your agent produced something without
// already being on the page that shows it.
export default function Preview({ project, ports = [] }) {
  const [chosen, setChosen] = useState(null);
  const [manual, setManual] = useState('');
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef(null);

  // A port that goes away takes its preview with it, rather than leaving a frame pointed at
  // nothing and an address bar that lies about what is running.
  useEffect(() => {
    if (chosen && ports.length && !ports.some((p) => p.port === chosen)) setChosen(null);
  }, [ports, chosen]);

  if (chosen) {
    const src = `/preview/${encodeURIComponent(project)}/${chosen}/`;
    return (
      <div className="preview-frame-wrap">
        <div className="preview-bar">
          <button type="button" className="preview-back" onClick={() => setChosen(null)} title="Back to the list">
            ←
          </button>
          <span className="preview-url">localhost:{chosen}</span>
          <div className="preview-bar-actions">
            {/* Remounts the iframe rather than reaching into its document: a cross-origin-ish
                frame will not always let you touch contentWindow, and a new key always works. */}
            <button type="button" onClick={() => setNonce((n) => n + 1)} title="Reload the preview">
              reload
            </button>
            <a href={src} target="_blank" rel="noreferrer" title="Open in a new tab">
              open
            </a>
          </div>
        </div>
        <iframe key={nonce} ref={frameRef} className="preview-frame" title={`Preview of port ${chosen}`} src={src} />
      </div>
    );
  }

  return (
    <div className="preview-pick">
      <div className="preview-pick-inner">
        <h2>What your agents are running</h2>
        {ports.length > 0 ? (
          <ul className="preview-ports">
            {ports.map((p) => (
              <li key={p.port}>
                <button type="button" onClick={() => setChosen(p.port)}>
                  <span className="preview-port-num">:{p.port}</span>
                  {/* The process holding the port. Three node servers are indistinguishable by
                      number alone, and this is the line that tells them apart. */}
                  {p.command && <span className="preview-port-cmd">{p.command}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="preview-none">
            Nothing is listening yet. Ask an agent to start a dev server — <code>npm run dev</code>,{' '}
            <code>python3 -m http.server</code> — and it will appear here on its own.
          </p>
        )}

        <form
          className="preview-manual"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(manual);
            if (n > 0 && n < 65536) setChosen(n);
          }}
        >
          <input
            type="number"
            min="1"
            max="65535"
            placeholder="or a port by hand"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button type="submit" disabled={!manual}>
            Open
          </button>
        </form>
      </div>
    </div>
  );
}
