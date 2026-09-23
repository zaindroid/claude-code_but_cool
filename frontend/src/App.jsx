import { useCallback, useEffect, useState } from 'react';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import TerminalView from './components/TerminalView.jsx';
import FileBrowser from './components/FileBrowser.jsx';
import Preview from './components/Preview.jsx';
import { authStatus, logout, listProjects, createProject } from './api.js';

const TABS = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'preview', label: 'Preview' },
];

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  // Every project whose terminal has been opened at least once stays mounted (in the background,
  // hidden) so switching projects doesn't kill a running `claude` session -- the same reason a
  // real terminal multiplexer keeps other panes alive while you're looking at one of them.
  const [openTerminals, setOpenTerminals] = useState([]);
  const [tab, setTab] = useState('terminal');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('forge-theme') || 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('forge-theme', theme);
    } catch {
      /* not critical */
    }
  }, [theme]);

  const refreshProjects = useCallback(async () => {
    const { projects: list } = await listProjects();
    setProjects(list);
    return list;
  }, []);

  useEffect(() => {
    authStatus()
      .then(async (s) => {
        setAuthed(s.authenticated);
        if (s.authenticated) {
          const list = await refreshProjects();
          if (list.length) selectProject(list[0].name);
        }
      })
      .catch(() => setAuthed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectProject(name) {
    setActiveProject(name);
    setTab('terminal');
    setOpenTerminals((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }

  async function handleCreate(name) {
    await createProject(name);
    await refreshProjects();
    selectProject(name);
  }

  async function handleLogout() {
    await logout();
    setAuthed(false);
    setOpenTerminals([]);
    setActiveProject(null);
  }

  if (authed === null) return <div className="boot-screen" />;
  if (!authed)
    return (
      <Login
        onSignedIn={async () => {
          setAuthed(true);
          const list = await refreshProjects();
          if (list.length) selectProject(list[0].name);
        }}
      />
    );

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        activeProject={activeProject}
        onSelect={selectProject}
        onCreate={handleCreate}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />

      <main className="main-area">
        {activeProject ? (
          <>
            <header className="main-head">
              <div className="main-head-left">
                <span className="main-project-name">{activeProject}</span>
                <nav className="tab-bar">
                  {TABS.map((t) => (
                    <button key={t.id} type="button" className={`tab-btn ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
                      {t.label}
                    </button>
                  ))}
                </nav>
              </div>
              <div className="main-head-right">
                <button type="button" className="icon-btn" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} title="Toggle theme" aria-label="Toggle theme">
                  {theme === 'dark' ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" /></svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  )}
                </button>
                <button type="button" className="icon-btn" onClick={handleLogout} title="Sign out" aria-label="Sign out">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </header>

            <div className="panel-area">
              {openTerminals.map((name) => (
                <TerminalView key={name} project={name} active={tab === 'terminal' && name === activeProject} />
              ))}
              <div className={`panel ${tab === 'files' ? '' : 'is-hidden'}`}>
                <FileBrowser project={activeProject} />
              </div>
              <div className={`panel ${tab === 'preview' ? '' : 'is-hidden'}`}>
                <Preview project={activeProject} />
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state fade-in">
            <p>Create a project to get a real terminal, running on your own server.</p>
          </div>
        )}
      </main>
    </div>
  );
}
