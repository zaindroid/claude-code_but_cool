import { useState } from 'react';
import { login } from '../api.js';

export default function Login({ onSignedIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(password);
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
        <h1>Forge</h1>
        <p className="login-sub">A terminal for Claude Code, on your own server.</p>
        <form onSubmit={submit}>
          <input
            type="password"
            autoFocus
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={busy || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
