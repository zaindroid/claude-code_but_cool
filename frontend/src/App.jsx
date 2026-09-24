import { useCallback, useEffect, useRef, useState } from 'react';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import TerminalView from './components/TerminalView.jsx';
import FileBrowser from './components/FileBrowser.jsx';
import Preview from './components/Preview.jsx';
import Settings from './components/Settings.jsx';
import Admin from './components/Admin.jsx';
import NewProjectModal from './components/NewProjectModal.jsx';
import AgentBar from './components/AgentBar.jsx';
import ProjectTools from './components/ProjectTools.jsx';
import TokenHud from './components/TokenHud.jsx';
import { authStatus, logout, listProjects, createProject } from './api.js';

const TABS = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'preview', label: 'Preview' },
];

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [role, setRole] = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  // Every project whose terminal has been opened at least once stays mounted (in the background,
  // hidden) so switching projects doesn't kill a running `claude` session -- the same reason a
  // real terminal multiplexer keeps other panes alive while you're looking at one of them.
  const [openTerminals, setOpenTerminals] = useState([]);
  const [tab, setTab] = useState('terminal');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('codez-theme') || 'dark');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // One send-function per open project's live terminal, registered by TerminalView itself (see
  // its own comment) -- how AgentBar's guided-mode buttons type a real command into the right
  // terminal without App needing to know anything about WebSockets.
  const sendersRef = useRef({});

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('codez-theme', theme);
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
        setRole(s.role || null);
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

  async function handleCreate(name, opts) {
    await createProject(name, opts);
    await refreshProjects();
    selectProject(name);
    setNewProjectOpen(false);
  }

  function registerSender(project, sendFn) {
    if (sendFn) sendersRef.current[project] = sendFn;
    else delete sendersRef.current[project];
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
          const s = await authStatus();
          setAuthed(true);
          setRole(s.role || null);
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
        onNewProject={() => setNewProjectOpen(true)}
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
                <button type="button" className="icon-btn" onClick={() => setToolsOpen(true)} title="MCP, skills, lessons, templates" aria-label="Project tools">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                {role === 'admin' && (
                  <button type="button" className="icon-btn" onClick={() => setAdminOpen(true)} title="Accounts" aria-label="Accounts">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)} title="Provider settings" aria-label="Provider settings">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
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

            {tab === 'terminal' && (
              <AgentBar
                project={activeProject}
                sendCommand={(data) => sendersRef.current[activeProject]?.(data)}
                hasSession={projects.find((p) => p.name === activeProject)?.hasSession}
              />
            )}
            <div className="panel-area">
              {openTerminals.map((name) => (
                <TerminalView key={name} project={name} active={tab === 'terminal' && name === activeProject} registerSender={registerSender} />
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
            <button type="button" className="empty-settings-link" onClick={() => setSettingsOpen(true)}>Set up a provider first</button>
            {role === 'admin' && (
              <button type="button" className="empty-settings-link" onClick={() => setAdminOpen(true)}>Invite someone</button>
            )}
          </div>
        )}
      </main>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {adminOpen && <Admin onClose={() => setAdminOpen(false)} />}
      {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} onCreate={handleCreate} />}
      {toolsOpen && activeProject && <ProjectTools project={activeProject} onClose={() => setToolsOpen(false)} />}
      <TokenHud openProjects={openTerminals} />
    </div>
  );
}
