import { useEffect, useState } from 'react';
import { listUsers, createUserAccount } from '../api.js';

// Admin-only: the one place new accounts get created. No self-signup anywhere in Forge -- every
// account here got a real Linux system user created for it the moment it was made (osUsers.js),
// which is the actual isolation between people, not just a login screen.
export default function Admin({ onClose }) {
  const [users, setUsers] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null);

  function refresh() {
    listUsers().then(({ users: list }) => setUsers(list));
  }

  useEffect(() => {
    refresh();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    setCreating(true);
    setError('');
    setJustCreated(null);
    try {
      await createUserAccount(username.trim(), password);
      setJustCreated({ username: username.trim(), password });
      setUsername('');
      setPassword('');
      refresh();
    } catch (err) {
      setError(err.message || 'Could not create the account');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings-card fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Accounts</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="admin-list">
          {users === null && <div className="settings-hint">Loading…</div>}
          {users?.map((u) => (
            <div key={u.id} className="admin-row">
              <span className="project-dot" />
              <span className="admin-username">{u.username}</span>
              {u.role === 'admin' && <span className="admin-badge">admin</span>}
            </div>
          ))}
        </div>

        <form onSubmit={submit} className="settings-form">
          <label className="settings-field">
            <span>New username</span>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="letters, numbers, - and _" autoComplete="off" />
          </label>
          <label className="settings-field">
            <span>Temporary password</span>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters" autoComplete="off" />
          </label>
          <p className="settings-hint">They'll get their own projects, own settings, and a real, separate system account -- nothing shared with anyone else.</p>
          {error && <div className="settings-error">{error}</div>}
          {justCreated && (
            <div className="admin-created">
              Created <strong>{justCreated.username}</strong>. Send them this password directly -- Forge never shows it again: <code>{justCreated.password}</code>
            </div>
          )}
          <div className="settings-actions">
            <button type="submit" disabled={creating || !username.trim() || password.length < 8}>{creating ? 'Creating…' : 'Create account'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
