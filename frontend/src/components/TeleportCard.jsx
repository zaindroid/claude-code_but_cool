import { useEffect, useState } from 'react';
import { listMachineTokens, createMachineToken, revokeMachineToken } from '../api.js';

// Everything needed to teleport a session, in one place: the token a machine needs, and the three
// commands that actually do it.
//
// The copy here is written for someone who has not read the architecture. It says what will
// happen to their files and their conversation, because "teleport" is a cheerful word for
// "upload my work to a server" and the honest version of that is short enough to just say.
export default function TeleportCard({ onClose, origin }) {
  const [tokens, setTokens] = useState([]);
  const [fresh, setFresh] = useState(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    listMachineTokens()
      .then((r) => setTokens(r.tokens || []))
      .catch((e) => setError(e.message));
  }, []);

  async function mint(e) {
    e.preventDefault();
    setError(null);
    try {
      const r = await createMachineToken(label.trim() || 'my machine');
      setFresh(r.token);
      setLabel('');
      setTokens((await listMachineTokens()).tokens || []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function revoke(id) {
    if (!window.confirm('Revoke this token? That machine will not be able to teleport until you give it a new one.')) return;
    try {
      await revokeMachineToken(id);
      setTokens((await listMachineTokens()).tokens || []);
    } catch (err) {
      setError(err.message);
    }
  }

  function copy(text, what) {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied(null), 1600);
      },
      () => setError('Could not copy — select it and copy manually.')
    );
  }

  const base = origin || window.location.origin;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-card teleport-card">
        <div className="settings-head">
          <h2>Teleport a session</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="settings-note">
          Moves a session you are running on another machine onto this server, so it keeps going with that machine switched
          off. Your conversation and your files both travel. Your API keys do not — a teleported session uses this
          account&rsquo;s provider settings instead.
        </p>

        <ol className="tp-steps">
          <li>
            <h3>Give that machine a token</h3>
            {fresh ? (
              <div className="tp-fresh">
                <code>{fresh}</code>
                <button type="button" onClick={() => copy(fresh, 'token')}>{copied === 'token' ? 'Copied' : 'Copy'}</button>
                {/* Said plainly because it is genuinely the only chance: the server stores a hash,
                    so there is no "show again" to offer later. */}
                <p>Copy it now — it is stored hashed and cannot be shown again.</p>
              </div>
            ) : (
              <form className="tp-mint" onSubmit={mint}>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="which machine? e.g. laptop" maxLength={64} />
                <button type="submit">Create token</button>
              </form>
            )}
            {tokens.length > 0 && (
              <ul className="tp-tokens">
                {tokens.map((t) => (
                  <li key={t.id}>
                    <span>{t.label}</span>
                    <span className="tp-token-when">{t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'never used'}</span>
                    <button type="button" onClick={() => revoke(t.id)}>Revoke</button>
                  </li>
                ))}
              </ul>
            )}
          </li>

          <li>
            <h3>On that machine, in your project folder</h3>
            <div className="tp-cmds">
              {[
                [`codez login ${base}`, 'Once per machine. Paste the token when it asks.'],
                ['codez detect', 'Shows which session it found, without sending anything.'],
                ['codez up', 'Sends it here. Creates the project if it does not exist.'],
                ['codez down <name>', 'Brings it back to that machine later.'],
              ].map(([cmd, why]) => (
                <div className="tp-cmd" key={cmd}>
                  <code>{cmd}</code>
                  <button type="button" onClick={() => copy(cmd, cmd)}>{copied === cmd ? 'Copied' : 'Copy'}</button>
                  <p>{why}</p>
                </div>
              ))}
            </div>
            <p className="settings-hint">
              The CLI lives in the Codez repo at <code>cli/codez.mjs</code> — run it with <code>node</code>, or add the
              bundled plugin and use <code>/teleport</code> from inside a session.
            </p>
          </li>

          <li>
            <h3>What happens if both sides changed</h3>
            <p className="settings-hint">
              Nothing gets overwritten. A transcript only ever grows, so whichever side is behind receives the lines it is
              missing. If both moved on independently, teleport stops and says so, and you can continue one of them as a
              fork — both histories survive. Files move as real git commits and land on a <code>refs/teleport/*</code> ref,
              so your branch is never moved for you unless a fast-forward is safe.
            </p>
          </li>
        </ol>

        {error && <p className="settings-error">{error}</p>}
      </div>
    </div>
  );
}
