import { useEffect, useState } from 'react';
import { getSettings, saveSettings, clearSecret } from '../api.js';

// One provider config, applied to every project's terminal the next time it opens (see
// backend/src/pty.js) -- Anthropic itself needs nothing here at all if you'd rather just run
// `claude` in a terminal and sign in interactively; everything else is for an API key, or for
// pointing at another Anthropic-API-compatible provider the same way its own docs describe
// (https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/ is exactly this).
export default function Settings({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [presets, setPresets] = useState(null);
  const [dcProviders, setDcProviders] = useState([]);
  const [dcReady, setDcReady] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(({ settings: s, presets: p, deepcodeProviders, deepcodeConfigured }) => {
      setSettings(s);
      setPresets(p);
      setDcProviders(deepcodeProviders || []);
      setDcReady(Boolean(deepcodeConfigured));
      setForm({
        provider: s.provider,
        baseUrl: s.baseUrl,
        model: s.model,
        smallModel: s.smallModel,
        authToken: '',
        deepcodeProvider: s.deepcodeProvider || '',
        deepcodeBaseUrl: s.deepcodeBaseUrl || '',
        deepcodeModel: s.deepcodeModel || '',
        deepcodeKey: '',
      });
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
      const { settings: s, deepcodeConfigured } = await saveSettings(form);
      setSettings(s);
      setDcReady(Boolean(deepcodeConfigured));
      setForm((f) => ({ ...f, authToken: '', deepcodeKey: '' }));
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function clear(field) {
    const { settings: s } = await clearSecret(field);
    setSettings(s);
    setSaved(false);
  }

  if (!form || !presets) return null;

  const isAnthropic = form.provider === 'anthropic';
  const dcSpec = dcProviders.find((p) => p.id === form.deepcodeProvider) || null;

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
              <button type="button" className="settings-clear" onClick={() => clear('authToken')}>Clear saved key</button>
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

          {/* DeepCode's own credential, kept well away from the field above. That one becomes
              ANTHROPIC_AUTH_TOKEN, and setting it takes Claude Code off a subscription login it is
              already using -- which is how an account with an active Max plan came to be told it
              was out of credit. Two tools, two keys, no shared slot. */}
          {dcProviders.length > 0 && (
            <div className="settings-section">
              <div className="settings-section-head">
                <h3>DeepCode</h3>
                <span className={dcReady ? 'settings-ready' : 'settings-notready'}>
                  {dcReady ? 'configured' : 'not configured'}
                </span>
              </div>
              <p className="settings-note">
                DeepCode has no account login — it reads an API key, and every provider it supports needs one.
                Its key is kept apart from the one above, so setting it here cannot take Claude Code off your
                subscription. Codez writes DeepCode's own config file; the key itself stays out of that file and
                is handed to the shell as <code>DEEPCODE_API_KEY</code>.
              </p>

              <div className="settings-row">
                <label className="settings-field">
                  <span>Provider</span>
                  <select
                    value={form.deepcodeProvider}
                    onChange={(e) => setForm({ ...form, deepcodeProvider: e.target.value })}
                  >
                    <option value="">Not set</option>
                    {dcProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>Model</span>
                  <input
                    type="text"
                    placeholder="DeepCode's default"
                    value={form.deepcodeModel}
                    onChange={(e) => setForm({ ...form, deepcodeModel: e.target.value })}
                  />
                </label>
              </div>

              {dcSpec?.needsBaseUrl && (
                <label className="settings-field">
                  <span>{dcSpec.needsKey ? 'Base URL' : 'Server address'}</span>
                  <input
                    type="text"
                    placeholder="http://127.0.0.1:11434"
                    value={form.deepcodeBaseUrl}
                    onChange={(e) => setForm({ ...form, deepcodeBaseUrl: e.target.value })}
                  />
                </label>
              )}

              {dcSpec?.needsKey && (
                <label className="settings-field">
                  <span>{dcSpec.label} API key</span>
                  <input
                    type="password"
                    placeholder={settings?.hasDeepcodeKey ? '•••••••••••• (saved — type to replace)' : 'paste the key'}
                    value={form.deepcodeKey}
                    onChange={(e) => setForm({ ...form, deepcodeKey: e.target.value })}
                    autoComplete="new-password"
                  />
                  {settings?.hasDeepcodeKey && (
                    <button type="button" className="settings-clear" onClick={() => clear('deepcodeKey')}>
                      Clear saved key
                    </button>
                  )}
                </label>
              )}
            </div>
          )}

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
