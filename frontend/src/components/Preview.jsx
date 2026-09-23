import { useState } from 'react';

// Points at whatever dev server is running inside the project's own terminal (npm run dev, etc).
// Forge does not try to auto-detect the port -- guessing wrong silently is worse than asking once.
export default function Preview({ project }) {
  const [port, setPort] = useState('');
  const [active, setActive] = useState('');

  function open(e) {
    e.preventDefault();
    if (port) setActive(port);
  }

  if (!active) {
    return (
      <div className="preview-empty">
        <form onSubmit={open} className="preview-form">
          <p>Start a dev server in this project's terminal, then preview it here.</p>
          <div className="preview-form-row">
            <input
              type="number"
              min="1"
              max="65535"
              placeholder="Port, e.g. 3000"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={!port}>Open</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="preview-frame-wrap">
      <div className="preview-bar">
        <span>localhost:{active}</span>
        <button type="button" className="mail-link-btn" onClick={() => setActive('')}>Change port</button>
      </div>
      <iframe className="preview-frame" title="Preview" src={`/preview/${encodeURIComponent(project)}/?port=${active}`} />
    </div>
  );
}
