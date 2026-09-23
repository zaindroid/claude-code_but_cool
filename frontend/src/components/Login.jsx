import { useState } from 'react';
import { login } from '../api.js';

export default function Login({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
      onSignedIn();
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card fade-in">
        <div className="login-mark">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <path d="M4 17L10 3l6 14M6.2 12h7.6M18 21l3-9 3 9" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>Codez</h1>
        <p className="login-sub">A terminal for Claude Code, on your own server.</p>
        <form onSubmit={submit}>
          <input
            type="text"
            autoFocus
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="current-password"
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="login-foot">Invite-only -- ask whoever administers this server for an account.</p>
      </div>
    </div>
  );
}
