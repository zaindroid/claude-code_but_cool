import { useEffect, useState } from 'react';
import { getSettings, saveSettings, clearSecret } from '../api.js';

// One settings screen, one section per agent Codez can run.
//
// It used to be organised by Codez's own history instead: a provider form for Claude Code, with
// DeepCode's settings bolted underneath. That put the word "DeepSeek" on the card twice meaning
// two different things -- once as a provider for *Claude Code* (its Anthropic-compatible
// endpoint) and once as a provider for *DeepCode* -- next to two fields both labelled with the
// word "key". Reported as confusing, correctly.
//
// So each agent is a block with its own name and its own status, and nothing from one agent's
// section can be mistaken for another's. Claude Code's provider form is folded away behind a
// disclosure, because its answer for almost everyone is "nothing, sign in in the terminal" -- and
// folding it is what actually removes the duplicate word from the screen rather than relabelling
// around it.
//
// Every agent is here, not only the ones with something to store. OpenCode and Codex keep their
// credentials themselves, inside their own CLIs, so their section is one sentence and a button
// that types their own login command into the open terminal. That is still worth a section: the
// question "how do I sign in to this thing" has one place to be asked now, and an agent whose
// answer is "not here" says so instead of being absent and leaving you looking.
export default function Settings({ onClose, agents = [], loginCmd = {}, onRun }) {
  const [settings, setSettings] = useState(null);
  const [presets, setPresets] = useState(null);
  const [dcProviders, setDcProviders] = useState([]);
  const [dcReady, setDcReady] = useState(false);
  const [form, setForm] = useState(null);
  const [showClaudeProvider, setShowClaudeProvider] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(({ settings: s, presets: p, deepcodeProviders, deepcodeConfigured }) => {
      setSettings(s);
      setPresets(p);
      setDcProviders(deepcodeProviders || []);
      setDcReady(Boolean(deepcodeConfigured));
      // Opened only if there is already something to see. Someone who has configured a provider
      // should not have to go looking for the setting they made.
      setShowClaudeProvider(s.provider !== 'anthropic' || s.hasAuthToken);
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

  // Picking a provider fills the model in with it. DeepCode has no per-provider default of its own
  // -- it falls back to one global `openai/gpt-4o-mini` whatever you chose -- so an empty model box
  // beside a non-OpenAI provider is a request that fails later, somewhere that does not mention
  // this screen. Only replaces a value this list put there, never something typed by hand.
  function pickDeepcodeProvider(id) {
    const next = dcProviders.find((p) => p.id === id);
    const prev = dcProviders.find((p) => p.id === form.deepcodeProvider);
    setForm((f) => ({
      ...f,
      deepcodeProvider: id,
      deepcodeModel: !f.deepcodeModel || f.deepcodeModel === prev?.defaultModel ? next?.defaultModel || '' : f.deepcodeModel,
    }));
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
  // What each tool would do if you ran it right now, said in the tool's own terms rather than as
  // a field-by-field report.
  const claudeState = settings?.hasAuthToken
    ? isAnthropic
      ? 'using an API key'
      : `using ${form.provider}`
    : 'using your Claude sign-in';
  const dcState = !dcSpec ? 'needs a provider' : settings?.hasDeepcodeKey || !dcSpec.needsKey ? 'ready' : 'needs an API key';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings-card fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <form onSubmit={submit} className="settings-form">
          {/* ---------------------------------------------------------------- Claude Code */}
          <section className="settings-tool">
            <div className="settings-tool-head">
              <h3>Claude Code</h3>
              <span className={settings?.hasAuthToken ? 'settings-notready' : 'settings-ready'}>{claudeState}</span>
            </div>
            <p className="settings-note">
              Nothing to set here. Open a terminal, run <code>claude</code>, and sign in with your Claude
              subscription.
            </p>
            <button
              type="button"
              className="settings-disclose"
              aria-expanded={showClaudeProvider}
              onClick={() => setShowClaudeProvider((v) => !v)}
            >
              {showClaudeProvider ? '▾' : '▸'} Use an API key or a different provider
            </button>

            {showClaudeProvider && (
              <div className="settings-disclosed">
                <div className="settings-presets">
                  {Object.entries(presets).map(([id, p]) => (
                    <button
                      key={id}
                      type="button"
                      className={`preset-tile ${form.provider === id ? 'is-active' : ''}`}
                      onClick={() => applyPreset(id)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {!isAnthropic && (
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
                  <span>Claude Code API key</span>
                  <input
                    type="password"
                    placeholder={settings?.hasAuthToken ? '•••••••••••• (saved — type to replace)' : 'sk-...'}
                    value={form.authToken}
                    onChange={(e) => setForm({ ...form, authToken: e.target.value })}
                    autoComplete="new-password"
                  />
                  {settings?.hasAuthToken && (
                    <button type="button" className="settings-clear" onClick={() => clear('authToken')}>
                      Clear it and go back to the subscription sign-in
                    </button>
                  )}
                </label>

                <div className="settings-row">
                  <label className="settings-field">
                    <span>Model</span>
                    <input
                      type="text"
                      placeholder="default"
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Fast model</span>
                    <input
                      type="text"
                      placeholder="default"
                      value={form.smallModel}
                      onChange={(e) => setForm({ ...form, smallModel: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* ---------------------------------------------------------------- DeepCode */}
          {dcProviders.length > 0 && (
            <section className="settings-tool">
              <div className="settings-tool-head">
                <h3>DeepCode</h3>
                <span className={dcState === 'ready' ? 'settings-ready' : 'settings-notready'}>{dcState}</span>
              </div>
              <p className="settings-note">
                DeepCode has no sign-in — it only reads an API key. This one is kept separate from Claude Code's
                above, so setting it cannot affect your Claude subscription.
              </p>

              <label className="settings-field">
                <span>Provider</span>
                <select value={form.deepcodeProvider} onChange={(e) => pickDeepcodeProvider(e.target.value)}>
                  <option value="">Choose one</option>
                  {dcProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

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

              {dcSpec?.needsBaseUrl && (
                <label className="settings-field">
                  <span>{dcSpec.needsKey ? 'Base URL' : 'Server address'}</span>
                  <input
                    type="text"
                    placeholder="http://127.0.0.1:11434/v1"
                    value={form.deepcodeBaseUrl}
                    onChange={(e) => setForm({ ...form, deepcodeBaseUrl: e.target.value })}
                  />
                </label>
              )}

              {dcSpec && (
                <label className="settings-field">
                  <span>Model</span>
                  <input
                    type="text"
                    placeholder="provider/model"
                    value={form.deepcodeModel}
                    onChange={(e) => setForm({ ...form, deepcodeModel: e.target.value })}
                  />
                  {/* Said plainly because the failure it prevents is invisible: DeepCode's own
                      fallback is an OpenAI model name whatever provider you picked, so a blank
                      box here fails on the first request, nowhere near this screen. */}
                  <span className="settings-subhint">
                    {dcSpec.defaultModel
                      ? `Filled in for ${dcSpec.label}. Change it if you want a different one.`
                      : `Required — DeepCode has no default for ${dcSpec.label}, and its fallback is an OpenAI model that this provider will reject.`}
                  </span>
                </label>
              )}
            </section>
          )}

          {/* The agents that hold their own credentials. Nothing to store here, so nothing is
              stored -- just the command each one documents, and a way to run it where it works. */}
          {['opencode', 'codex'].map((id) => {
            const a = agents.find((x) => x.id === id);
            if (!a?.available) return null;
            return (
              <section className="settings-tool" key={id}>
                <div className="settings-tool-head">
                  <h3>{a.label}</h3>
                  <span className="settings-notready">signs in in its own terminal</span>
                </div>
                <p className="settings-note">{a.loginHint}</p>
                {loginCmd[id] && (
                  <button type="button" className="settings-run" onClick={() => onRun?.(loginCmd[id])}>
                    Run <code>{loginCmd[id]}</code> in the open terminal
                  </button>
                )}
              </section>
            );
          })}

          <p className="settings-hint">
            Applies to terminals opened after saving — an agent already running keeps its current environment, so
            stop and resume it.
          </p>

          {error && <div className="settings-error">{error}</div>}
          <div className="settings-actions">
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
