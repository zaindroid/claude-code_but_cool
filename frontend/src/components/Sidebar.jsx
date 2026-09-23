import { useState } from 'react';

export default function Sidebar({ projects, activeProject, onSelect, onCreate, collapsed, onToggle }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await onCreate(name.trim());
      setName('');
      setCreating(false);
    } catch (err) {
      setError(err.message || 'Could not create the project');
    }
  }

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-head">
        <span className="sidebar-title">Projects</span>
        <button type="button" className="icon-btn" onClick={onToggle} aria-label="Toggle sidebar" title="Toggle sidebar">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
      </div>

      <div className="project-list">
        {projects.map((p) => (
          <button
            key={p.name}
            type="button"
            className={`project-item ${p.name === activeProject ? 'is-active' : ''}`}
            onClick={() => onSelect(p.name)}
          >
            <span className="project-dot" />
            <span className="project-name">{p.name}</span>
          </button>
        ))}
        {!projects.length && <div className="project-empty">No projects yet</div>}
      </div>

      {creating ? (
        <form className="project-create" onSubmit={submit}>
          <input
            autoFocus
            placeholder="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
          />
          {error && <div className="project-create-error">{error}</div>}
          <div className="project-create-actions">
            <button type="submit" disabled={!name.trim()}>Create</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className="project-add" onClick={() => setCreating(true)}>
          <span>+</span> New project
        </button>
      )}
    </aside>
  );
}
