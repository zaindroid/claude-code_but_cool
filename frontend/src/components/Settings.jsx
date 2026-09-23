import { useEffect, useState } from 'react';
import { getSettings, saveSettings, clearAuthToken } from '../api.js';

// One provider config, applied to every project's terminal the next time it opens (see
// backend/src/pty.js) -- Anthropic itself needs nothing here at all if you'd rather just run
// `claude` in a terminal and sign in interactively; everything else is for an API key, or for
// pointing at another Anthropic-API-compatible provider the same way its own docs describe
// (https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/ is exactly this).
export default function Settings({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [presets, setPresets] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(({ settings: s, presets: p }) => {
      setSettings(s);
      setPresets(p);
      setForm({ provider: s.provider, baseUrl: s.baseUrl, model: s.model, smallModel: s.smallModel, authToken: '' });
    });
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function applyPreset(id) {
    const p = presets[id];
    setForm((f) => ({ ...f, provider: id, baseUrl: p.baseUrl, model: p.model, smallModel: p.smallModel }));
    setSaved(false);
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { settings: s } = await saveSettings(form);
      setSettings(s);
      setForm((f) => ({ ...f, authToken: '' }));
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function clearToken() {
    const { settings: s } = await clearAuthToken();
    setSettings(s);
    setSaved(false);
  }

  if (!form || !presets) return null;

  const isAnthropic = form.provider === 'anthropic';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings-card fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Provider</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="settings-presets">
          {Object.entries(presets).map(([id, p]) => (
            <button key={id} type="button" className={`preset-tile ${form.provider === id ? 'is-active' : ''}`} onClick={() => applyPreset(id)}>
              {p.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="settings-form">
          {isAnthropic ? (
            <p className="settings-note">
              No key needed to get started -- open a project's terminal, run <code>claude</code>, and sign in with your Claude
              subscription. Only set a key below if you'd rather use API billing instead.
            </p>
          ) : (
            <label className="settings-field">
              <span>Base URL</span>
              <input
                type="text"
                placeholder="https://api.example.com/anthropic"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
          )}

          <label className="settings-field">
            <span>{isAnthropic ? 'API key' : 'API key / auth token'}</span>
            <input
              type="password"
              placeholder={settings?.hasAuthToken ? '•••••••••••• (saved -- type to replace)' : 'sk-...'}
              value={form.authToken}
              onChange={(e) => setForm({ ...form, authToken: e.target.value })}
              autoComplete="new-password"
            />
            {settings?.hasAuthToken && (
              <button type="button" className="settings-clear" onClick={clearToken}>Clear saved key</button>
            )}
          </label>

          <div className="settings-row">
            <label className="settings-field">
              <span>Model</span>
              <input type="text" placeholder="default" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </label>
            <label className="settings-field">
              <span>Fast model</span>
              <input type="text" placeholder="default" value={form.smallModel} onChange={(e) => setForm({ ...form, smallModel: e.target.value })} />
            </label>
          </div>

          <p className="settings-hint">Applies to terminals opened after saving -- one already running keeps its current environment.</p>

          {error && <div className="settings-error">{error}</div>}
          <div className="settings-actions">
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : saved ? 'Saved' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
