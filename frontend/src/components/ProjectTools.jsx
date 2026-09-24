import { useEffect, useState } from 'react';
import {
  listMcpServers, addMcpServer, removeMcpServer,
  listSkills, createSkill, deleteSkill,
  listLessons, createLesson, deleteLesson, promoteLesson, injectLessons,
  listTemplates, saveAsTemplate,
} from '../api.js';

const TABS = ['MCP', 'Skills', 'Lessons', 'Templates'];

// One panel for everything a project's agent can be extended with -- MCP servers, skills, and the
// account-wide lesson library it can pull from or feed into. Each tab writes to the same real
// files Claude Code itself reads (.mcp.json, .claude/skills/*, CLAUDE.md -- see the backend
// modules this calls into), so nothing here is Codez-only state the agent can't see.
export default function ProjectTools({ project, onClose }) {
  const [tab, setTab] = useState('MCP');
  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings-card fade-in tools-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Project tools — {project}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>
        <nav className="tab-bar tools-tabs">
          {TABS.map((t) => (
            <button key={t} type="button" className={`tab-btn ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <div className="tools-body">
          {tab === 'MCP' && <McpTab project={project} />}
          {tab === 'Skills' && <SkillsTab project={project} />}
          {tab === 'Lessons' && <LessonsTab project={project} />}
          {tab === 'Templates' && <TemplatesTab project={project} />}
        </div>
      </div>
    </div>
  );
}

function McpTab({ project }) {
  const [servers, setServers] = useState({});
  const [form, setForm] = useState({ name: '', command: '', args: '' });
  const [error, setError] = useState('');

  const load = () => listMcpServers(project).then((r) => setServers(r.servers)).catch(() => {});
  useEffect(load, [project]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const args = form.args.split(' ').map((s) => s.trim()).filter(Boolean);
      await addMcpServer(project, { name: form.name.trim(), command: form.command.trim(), args });
      setForm({ name: '', command: '', args: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="tools-tab">
      <p className="settings-note">Writes to this project’s real <code>.mcp.json</code> — Claude Code (and OpenCode) picks these up automatically.</p>
      <ul className="tools-list">
        {Object.entries(servers).map(([name, spec]) => (
          <li key={name}>
            <span><strong>{name}</strong> <code>{spec.command} {(spec.args || []).join(' ')}</code></span>
            <button type="button" onClick={() => removeMcpServer(project, name).then(load)}>Remove</button>
          </li>
        ))}
        {!Object.keys(servers).length && <li className="tools-empty">No MCP servers attached yet.</li>}
      </ul>
      <form className="tools-form" onSubmit={submit}>
        <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="command (e.g. npx)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
        <input placeholder="args (space separated)" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
        {error && <div className="settings-error">{error}</div>}
        <button type="submit" disabled={!form.name.trim() || !form.command.trim()}>Add server</button>
      </form>
    </div>
  );
}

function SkillsTab({ project }) {
  const [scope, setScope] = useState('project');
  const [skills, setSkills] = useState([]);
  const [form, setForm] = useState({ name: '', description: '', body: '' });
  const [error, setError] = useState('');

  const load = () => listSkills(scope === 'project' ? project : undefined).then((r) => setSkills(r.skills)).catch(() => {});
  useEffect(load, [project, scope]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await createSkill({ name: form.name.trim(), description: form.description.trim(), body: form.body }, scope === 'project' ? project : undefined);
      setForm({ name: '', description: '', body: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="tools-tab">
      <p className="settings-note">Real <code>SKILL.md</code> files — project skills live with this project, personal skills apply to every project you open.</p>
      <div className="tools-scope-toggle">
        <button type="button" className={scope === 'project' ? 'is-active' : ''} onClick={() => setScope('project')}>This project</button>
        <button type="button" className={scope === 'personal' ? 'is-active' : ''} onClick={() => setScope('personal')}>Personal (all projects)</button>
      </div>
      <ul className="tools-list">
        {skills.map((s) => (
          <li key={s.name}>
            <span><strong>{s.name}</strong> — {s.description}</span>
            <button type="button" onClick={() => deleteSkill(s.name, scope === 'project' ? project : undefined).then(load)}>Remove</button>
          </li>
        ))}
        {!skills.length && <li className="tools-empty">No skills here yet.</li>}
      </ul>
      <form className="tools-form" onSubmit={submit}>
        <input placeholder="skill-name (lowercase-dashes)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="one-line description (when Claude Code should use it)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <textarea placeholder="instructions" rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        {error && <div className="settings-error">{error}</div>}
        <button type="submit" disabled={!form.name.trim() || !form.body.trim()}>Add skill</button>
      </form>
    </div>
  );
}

function LessonsTab({ project }) {
  const [lessons, setLessons] = useState([]);
  const [form, setForm] = useState({ title: '', body: '' });
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = () => listLessons().then((r) => setLessons(r.lessons)).catch(() => {});
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await createLesson({ title: form.title.trim(), body: form.body, sourceProject: project });
      setForm({ title: '', body: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggle(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function inject() {
    setStatus('');
    try {
      await injectLessons(project, selected);
      setStatus(`Added to this project’s CLAUDE.md — ${agentReadsIt}`);
    } catch (err) {
      setStatus(err.message);
    }
  }

  const agentReadsIt = 'Claude Code reads it automatically next time it starts here.';

  return (
    <div className="tools-tab">
      <p className="settings-note">Your own library of things worth remembering across projects — write one here, then inject it into any project’s <code>CLAUDE.md</code>, or promote it into a real skill.</p>
      <ul className="tools-list">
        {lessons.map((l) => (
          <li key={l.id}>
            <label className="lesson-item">
              <input type="checkbox" checked={selected.includes(l.id)} onChange={() => toggle(l.id)} />
              <span><strong>{l.title}</strong>{l.sourceProject ? <em> ({l.sourceProject})</em> : null}</span>
            </label>
            <div className="lesson-actions">
              <button type="button" onClick={() => promoteLesson(l.id).then(load)}>Make skill</button>
              <button type="button" onClick={() => deleteLesson(l.id).then(load)}>Remove</button>
            </div>
          </li>
        ))}
        {!lessons.length && <li className="tools-empty">No lessons saved yet.</li>}
      </ul>
      {!!lessons.length && (
        <div className="tools-form-row">
          <button type="button" disabled={!selected.length} onClick={inject}>Inject selected into {project}</button>
          {status && <span className="settings-note">{status}</span>}
        </div>
      )}
      <form className="tools-form" onSubmit={submit}>
        <input placeholder="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea placeholder="what did you learn?" rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        {error && <div className="settings-error">{error}</div>}
        <button type="submit" disabled={!form.title.trim() || !form.body.trim()}>Save lesson</button>
      </form>
    </div>
  );
}

function TemplatesTab({ project }) {
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState({ name: '', description: '' });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = () => listTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setStatus('');
    try {
      await saveAsTemplate(project, form.name.trim(), form.description.trim());
      setForm({ name: '', description: '' });
      setStatus('Saved — pick it from "Start from" the next time you create a project.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="tools-tab">
      <p className="settings-note">Save this project’s current files as a template you can start future projects from.</p>
      <ul className="tools-list">
        {templates.map((t) => (
          <li key={t.id}><span><strong>{t.label}</strong> {t.kind === 'builtin' ? '(built-in)' : ''} — {t.description}</span></li>
        ))}
      </ul>
      <form className="tools-form" onSubmit={submit}>
        <input placeholder="template name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        {error && <div className="settings-error">{error}</div>}
        {status && <div className="settings-note">{status}</div>}
        <button type="submit" disabled={!form.name.trim()}>Save {project} as a template</button>
      </form>
    </div>
  );
}
