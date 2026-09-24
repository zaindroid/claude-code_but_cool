import { useEffect, useState } from 'react';
import { listAgents, listTemplates } from '../api.js';

// The guided "new project" flow: where to store it (still just a name -- Codez always scopes
// projects to the account's own directory, see projects.js), which agent to set it up for, and
// an optional starting template. Configuring the agent itself (login, MCP servers, skills) is a
// deliberate second step -- ProjectTools opens right after creation for that, rather than
// cramming everything into one form.
export default function NewProjectModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [agents, setAgents] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [agent, setAgent] = useState('claude');
  const [templateId, setTemplateId] = useState('blank');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
    listTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      await onCreate(name.trim(), { agent, templateId });
    } catch (err) {
      setError(err.message || 'Could not create the project');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings-card fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>New project</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>

        <form onSubmit={submit} className="settings-form">
          <label className="settings-field">
            <span>Name (also where it’s stored, under your own account)</span>
            <input autoFocus placeholder="project-name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="settings-field">
            <span>Coding agent</span>
            <div className="tile-grid">
              {agents.map((a) => (
                <button key={a.id} type="button" className={`preset-tile ${agent === a.id ? 'is-active' : ''}`} onClick={() => setAgent(a.id)}>
                  {a.label}
                  {!a.available && <span className="tile-badge">not available on this server right now</span>}
                </button>
              ))}
            </div>
          </label>

          <label className="settings-field">
            <span>Start from</span>
            <div className="tile-grid">
              {templates.map((t) => (
                <button key={t.id} type="button" className={`preset-tile ${templateId === t.id ? 'is-active' : ''}`} onClick={() => setTemplateId(t.id)} title={t.description}>
                  {t.label}
                </button>
              ))}
            </div>
          </label>

          {error && <div className="settings-error">{error}</div>}
          <div className="settings-actions">
            <button type="submit" disabled={!name.trim() || creating}>{creating ? 'Creating…' : 'Create project'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
