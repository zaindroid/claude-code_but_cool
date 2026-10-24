import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// blobatar's idle motion and expression morphs are a CSS layer: registered custom properties plus
// transitions on them. Imported once, here, because without it every face renders correctly but
// completely still. It animates transform and fill only -- never anything affecting layout, which
// matters on this page (see AGENT_CONTEXT/KNOWN_ISSUES.md).
import 'blobatar/motion.css';
import Login from './components/Login.jsx';
import TerminalView from './components/TerminalView.jsx';
import FileBrowser from './components/FileBrowser.jsx';
import Preview from './components/Preview.jsx';
import Settings from './components/Settings.jsx';
import Admin from './components/Admin.jsx';
import NewProjectModal from './components/NewProjectModal.jsx';
import CrewRail from './components/CrewRail.jsx';
import AgentPages from './components/AgentPages.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import TeleportCard from './components/TeleportCard.jsx';
import ProjectTools from './components/ProjectTools.jsx';
import {
  authStatus,
  logout,
  listProjects,
  createProject,
  listCrew,
  listAgents,
  listPorts,
  wakeSession,
  deleteSession,
  quitSession,
  getTokenUsage,
} from './api.js';

// The agents' own real login commands, same values as backend/src/agents.js. Codez implements auth
// for none of them -- this types the tool's own command into the tool's own terminal.
const LOGIN_CMD = { claude: 'claude', opencode: 'opencode auth login', codex: 'codex', deepcode: 'deepcode provider set' };

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// One terminal's identity. A project keeps its own plain terminal (session null) and each named
// crew member gets one alongside it, so a project can have several live at once -- which is what
// "parallel" means here.
const termKey = (project, session) => (session ? `${project}::${session}` : project);

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [role, setRole] = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [openTerms, setOpenTerms] = useState([]); // [{ key, project, session }]
  const [activeKey, setActiveKey] = useState(null);
  const [activeSessionByProject, setActiveSessionByProject] = useState({});
  const [view, setView] = useState('terminal'); // what the screen is showing
  const [theme, setTheme] = useState(() => localStorage.getItem('codez-theme') || 'dark');
  const [focus, setFocus] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [teleportOpen, setTeleportOpen] = useState(false);
  // The whole crew, every project, as the server sees it. Account-wide rather than per project
  // because that is the scope a session name actually lives in -- two Claude sessions in different
  // projects are peers that can address each other by name, so splitting them by project was the
  // view lying about the model. The agent pages below are slices of this one list.
  const [crew, setCrew] = useState([]);
  // Which agent's page the rail is showing. One page per CLI, each listing that CLI's agents from
  // every project.
  const [agentPage, setAgentPage] = useState(null);
  // sessionName -> timestamp of the last real output from its PTY. Drives the working face.
  // Held in a ref and mirrored into state on a slow tick rather than set per chunk: a chatty agent
  // emits output many times a second, and re-rendering the rail that often is both wasteful and,
  // on this page specifically, a flicker risk.
  const activityRef = useRef({});
  const [activity, setActivity] = useState({});
  const [awake, setAwake] = useState(() => new Set());
  // Who has an agent actually in the foreground, which is a different question from who has a
  // shell (see pty.js's busySessionNames). The Resume button keys off this one.
  const [running, setRunning] = useState(() => new Set());
  const [crewVersion, setCrewVersion] = useState(0);
  // Real token usage, parsed from Claude Code's own transcripts server-side (tokenUsage.js) --
  // the same accounting `/cost` uses, not an estimate from watching output. It lives in the status
  // line now rather than in a floating HUD: the old HUD was one of the elements the layout-shift
  // probe named repeatedly, and a number this quiet does not need to float over the screen.
  const [usage, setUsage] = useState([]);
  // The agent CLIs this container can actually run, with live availability (`command -v` on the
  // server, not the Dockerfile's intent). Fetched once: the answer changes only when the image
  // does, and the crew rail needs it to grey out an agent you cannot start.
  const [agents, setAgents] = useState([]);
  // What this account has listening, straight from the kernel (backend/src/ports.js). Polled here
  // rather than inside the preview panel so the status line can say an agent has produced
  // something while you are still looking at the terminal -- which is the only moment the news is
  // worth anything.
  const [ports, setPorts] = useState([]);
  const sendersRef = useRef({});
  // Sessions waiting for their terminal to say its first word so the agent can be launched into
  // it. Held in a ref because the signal arrives from a websocket callback registered once, which
  // would close over stale state. Keyed per terminal rather than being a single slot: a server
  // restart brings every open terminal back at the same moment, and one slot meant one of them
  // got its agent and the rest silently did not.
  // Mirrors of state that the stable websocket callbacks below need to read. Same reason as
  // above -- they are registered once per terminal and would otherwise see the first render's
  // values forever.
  const crewRef = useRef([]);
  const activeProjectRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('codez-theme', theme);
    } catch {
      /* not critical */
    }
  }, [theme]);

  useEffect(() => {
    if (!authed) return;
    listAgents().then((r) => setAgents(r.agents || [])).catch(() => {});
  }, [authed]);

  const refreshProjects = useCallback(async () => {
    const { projects: list } = await listProjects();
    setProjects(list);
    return list;
  }, []);

  // What signing in lands you on. Signing in is meant to *be* access to a terminal, so this ends
  // with a live terminal on screen -- and a terminal needs a folder to stand in. A brand new
  // account used to be met by an empty state and a form asking it to name a project before it
  // could type anything, which put a decision in front of the one thing it came for. The first
  // folder is made here instead; the name is a starting point, not a commitment, and projects can
  // be added and removed freely afterwards.
  //
  // If making it fails -- over quota, or another tab got there first -- the empty state is still
  // behind this and still explains itself, so this never blocks the way in.
  const landAfterSignIn = useCallback(async () => {
    let list = await refreshProjects();
    if (!list.length) {
      try {
        await createProject('home', { agent: 'claude' });
        list = await refreshProjects();
      } catch {
        /* the empty state takes it from here */
      }
    }
    if (list.length) selectProject(list[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshProjects]);

  useEffect(() => {
    authStatus()
      .then(async (s) => {
        setAuthed(s.authenticated);
        setRole(s.role || null);
        if (s.authenticated) await landAfterSignIn();
      })
      .catch(() => setAuthed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Who has a live shell right now, asked of the server rather than inferred locally: a session can
  // be awake because of something that happened in another browser, on another device, or because
  // it was teleported in while this tab sat open.
  const refreshCrew = useCallback(
    () =>
      listCrew()
        .then((r) => {
          const list = r.sessions || [];
          setCrew(list);
          setAwake(new Set(list.filter((s) => s.awake).map((s) => s.name)));
          setRunning(new Set(list.filter((s) => s.running).map((s) => s.name)));
          return list;
        })
        .catch(() => []),
    []
  );

  // The slice of the crew that belongs to the project on screen. Derived rather than fetched, so
  // there is one source of truth and no window where the two disagree.
  const crewOfProject = useMemo(() => crew.filter((s) => s.project === activeProject), [crew, activeProject]);

  useEffect(() => {
    if (!authed) return undefined;
    let cancelled = false;
    const poll = () => !cancelled && refreshCrew();
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authed, crewVersion]);

  // The slow mirror of activityRef. 400ms is fast enough that a face lights up while its agent is
  // talking and settles shortly after it stops, and slow enough that the rail re-renders a couple
  // of times a second instead of dozens.
  useEffect(() => {
    const id = setInterval(() => {
      const snap = activityRef.current;
      if (Object.keys(snap).some((k) => Date.now() - snap[k] < 2000)) setActivity({ ...snap });
    }, 400);
    return () => clearInterval(id);
  }, []);

  // Waiting for the shell to speak used to live here: a wake was armed, and the first byte of
  // output fired it. That is gone, and the arming with it. The server now waits for its own pty's
  // prompt, which it can actually see -- and which works for the case this never could, a shell
  // already sitting at a prompt with no further output coming.
  const noteActivity = useCallback((session) => {
    activityRef.current = { ...activityRef.current, [session]: Date.now() };
  }, []);

  // A named session that came back to a *new* shell -- the server restarted, or a deploy replaced
  // the container (TerminalView). The conversation itself is safe on disk, so the only thing
  // missing is the agent process, and the session exists precisely to be running one. Started
  // back up through the same visible typed-command path as everything else, which for Claude Code
  // means `--resume` into the transcript that is already there: the server decides start-vs-resume
  // by looking at whether that file really exists, so this picks the conversation up where it
  // stopped instead of opening a blank one.
  const reviveSession = useCallback(
    (session, project) => {
      if (project !== activeProjectRef.current) return; // its crew isn't loaded; leave it to Wake
      const record = crewRef.current.find((s) => s.name === session);
      if (record) runWake(project, record);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    crewRef.current = crewOfProject;
  }, [crewOfProject]);
  useEffect(() => {
    activeProjectRef.current = activeProject;
  }, [activeProject]);

  // A dev server appearing is the one thing on this page that happens without anyone clicking,
  // so it is worth asking about on a human cadence. Six seconds is fast enough that `npm run dev`
  // feels like it announced itself and slow enough to be free.
  useEffect(() => {
    if (!authed) return undefined;
    let cancelled = false;
    const poll = () => listPorts().then((r) => !cancelled && setPorts(r.ports || [])).catch(() => {});
    poll();
    const id = setInterval(poll, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authed]);

  // Polled slowly and only while signed in: this reads transcript files on the server, so asking
  // more often than a person could notice would be pure cost for no information.
  useEffect(() => {
    if (!authed) return undefined;
    let cancelled = false;
    const poll = () => getTokenUsage().then((r) => !cancelled && setUsage(r.usage || [])).catch(() => {});
    poll();
    const id = setInterval(poll, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authed, crewVersion]);

  // ⌘K / Ctrl+K from anywhere. Registered on the window rather than on an element because the
  // whole point is that it works without first clicking the right part of the page -- including
  // while the terminal has focus, which is most of the time.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function openTerm(project, session) {
    const key = termKey(project, session);
    setOpenTerms((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, project, session }]));
    setActiveKey(key);
    setView('terminal');
    return key;
  }

  function selectProject(name) {
    setActiveProject(name);
    openTerm(name, activeSessionByProject[name] || null);
  }

  function selectSession(session) {
    if (!activeProject) return;
    setActiveSessionByProject((prev) => ({ ...prev, [activeProject]: session }));
    openTerm(activeProject, session);
  }

  // Opening a face from an agent page, which may belong to a project other than the one on screen.
  // Switching the project as a side effect of clicking the agent is the point: on a Claude page
  // you are picking the agent you want to talk to, and which folder it happens to live in is its
  // business, not a step you should have to take first.
  function openSession(record) {
    if (!record) return;
    if (record.project !== activeProject) setActiveProject(record.project);
    setActiveSessionByProject((prev) => ({ ...prev, [record.project]: record.name }));
    openTerm(record.project, record.name);
  }

  // The crew rail's Resume button. Switches to that session and starts its agent -- the two things
  // you wanted when you clicked it, in one press, with no command to remember.
  //
  // Which of the two paths runs matters: a session with a live shell is sitting at a prompt and
  // will never emit another byte on its own, so waiting for output would wait forever -- it gets
  // the command typed in now. A session with no shell is about to get one, and that shell's prompt
  // is the only reliable "ready" signal there is, so that one is armed and fires on it.
  function resumeSession(name) {
    // Looked up across the whole crew, not just this project's: the Resume button sits on an agent
    // page that spans projects, so the session it names may not be the one on screen yet.
    const record = crew.find((s) => s.name === name);
    if (!record) return;
    openSession(record);
    runWake(record.project, record);
  }

  async function handleCreate(name, opts) {
    await createProject(name, opts);
    await refreshProjects();
    selectProject(name);
    setNewProjectOpen(false);
  }

  function registerSender(key, sendFn) {
    if (sendFn) sendersRef.current[key] = sendFn;
    else delete sendersRef.current[key];
  }

  const activeSession = activeProject ? activeSessionByProject[activeProject] || null : null;
  const activeRecord = crewOfProject.find((s) => s.name === activeSession) || null;
  // The project's own agent choice, made when it was created. It is the default a new crew member
  // inherits, and the fallback for anything not tied to a particular session.
  const projectAgent = projects.find((p) => p.name === activeProject)?.agent || 'claude';

  // One page per CLI, standing: Claude's agents on one, DeepCode's on another, OpenCode's on a
  // third, whether or not any of them have members yet.
  //
  // These were built from the crew at first, so a page appeared with its first agent and vanished
  // with its last. That is tidier and wrong -- it made the pages a *consequence* of what you had
  // rather than a place you could decide to go, and an empty CLI was unreachable precisely when
  // you wanted it, since the page you are on is also what the `+` creates. You could not get to
  // the OpenCode page to make your first OpenCode agent.
  //
  // Every CLI this build knows about gets one, installed or not. An uninstalled one is listed and
  // not clickable with the reason said out loud (AgentPages.jsx) rather than left out: a missing
  // page answers "where is Codex?" with silence, while an open one would offer a face that could
  // never start.
  const pageOrder = agents.length ? agents.map((a) => a.id) : ['claude'];
  const inCrew = new Set(crew.map((s) => s.agent || 'claude'));
  const rank = (id) => (pageOrder.indexOf(id) === -1 ? 99 : pageOrder.indexOf(id));
  const pageIds = [...new Set([...pageOrder, ...inCrew])].sort((x, y) => rank(x) - rank(y));
  const agentPages = pageIds.map((id) => ({
    id,
    label: agents.find((a) => a.id === id)?.label || id,
    // Unknown to /api/agents but present in the crew: a real session of a kind this build no
    // longer lists. Treated as available because it plainly was once, and its faces must open.
    available: agents.find((a) => a.id === id)?.available ?? true,
    count: crew.filter((s) => (s.agent || 'claude') === id).length,
  }));
  // Follows the agent you are actually talking to unless you have picked a page yourself, so
  // clicking into a DeepCode session does not leave you looking at the Claude page.
  const fallbackPage =
    activeRecord?.agent ||
    // The page this folder's crew actually lives on, which is not always the agent the folder was
    // declared with. `zmain` is a declared DeepCode project whose entire crew is Claude, so
    // selecting it on the folder's declaration landed you on an empty DeepCode page -- the view
    // saying the folder was empty while its agents sat one tab away.
    crewOfProject[0]?.agent ||
    (pageIds.includes(projectAgent) ? projectAgent : pageIds[0]) ||
    'claude';
  const activePage = agentPage && pageIds.includes(agentPage) ? agentPage : fallbackPage;
  const pageCrew = crew.filter((s) => (s.agent || 'claude') === activePage);
  // Only worth naming each face's project when the page actually spans more than one.
  const pageSpansProjects = new Set(pageCrew.map((s) => s.project)).size > 1;

  // Types a real command into the live terminal, which is the same path a keystroke takes. Kept
  // this way on purpose: what runs is always something the person could have typed and can see.
  function typeInto(session, command) {
    sendersRef.current[termKey(activeProject, session)]?.(`${command}\r`);
  }

  // Asks the server to type it, rather than typing it from here.
  //
  // This used to write through `sendersRef.current[key]?.(...)`, and that optional call was the
  // bug: with no terminal mounted under that exact key it did nothing at all, silently, and the
  // only sign was a Resume button that appeared to be broken. It also could not help the case that
  // matters most -- a live shell sitting at a bare prompt after you quit Claude -- because the
  // fallback path armed the command to fire on the shell's next output, and a shell at a prompt has
  // no next output.
  //
  // The server holds the pty, so it has neither problem: it types into the session's own shell
  // whether or not this page is looking at it, starts that shell if it is not running, and waits
  // for a new shell's prompt itself. It still picks start-vs-resume from the transcript on disk,
  // and for a non-Claude agent still sends that tool's own plain launch command.
  async function runWake(project, record, { fork = false } = {}) {
    if (!record) return;
    await wakeSession(project, record.id, { fork });
    setCrewVersion((v) => v + 1);
  }

  function wake(opts) {
    return runWake(activeProject, activeRecord, opts);
  }

  // Pressing + used to leave you at a bash prompt with an asleep face and nothing saying the
  // agent had not started. Now the agent you picked is launched for you, through the same visible
  // typed-command path, as soon as its shell is ready.
  function autoWake(session) {
    runWake(session.project || activeProject, session);
  }

  // Ends the shell without touching the session. The rail asks for this on the selected agent; it
  // is the counterpart to waking one, and until it existed a closed tab left a shell alive for the
  // six hours of pty.js's idle grace with nothing able to end it sooner.
  async function quitActive(session) {
    await quitSession(session.project || activeProject, session.id);
    setCrewVersion((v) => v + 1);
  }

  // Removal, with the choice made explicit by the caller rather than assumed here. `purge` deletes
  // the session's own folder and its conversation; without it the history stays and the name can be
  // added back to resume, which is what this always did under a label that implied otherwise.
  async function removeSession(session, { purge = false } = {}) {
    const project = session.project || activeProject;
    await deleteSession(project, session.id, { purge });
    if (session.name === activeSession) {
      setActiveSessionByProject((prev) => ({ ...prev, [project]: null }));
      openTerm(project, null);
    }
    setCrewVersion((v) => v + 1);
  }

  async function removeActive() {
    if (!activeRecord) return;
    if (
      !window.confirm(
        `Remove "${activeRecord.name}" from the crew?\n\nIts conversation history stays on disk — adding a session with this name again resumes it.\n\nTo delete the history too, use Remove on the crew rail.`
      )
    )
      return;
    await removeSession(activeRecord, { purge: false });
  }

  async function handleLogout() {
    await logout();
    setAuthed(false);
    setOpenTerms([]);
    setActiveKey(null);
    setActiveProject(null);
  }

  // Every action in the app, in one list. Declaration order is the ranking the palette shows, so
  // the things you reach for most often are first and the destructive one is last.
  const commands = useMemo(() => {
    const list = [];
    if (activeRecord) {
      list.push({
        id: 'wake',
        label: `Wake ${activeRecord.name}`,
        // Naming the CLI matters once a project's crew can mix them: "resume" means something
        // different per tool, and for Codex and DeepCode it means nothing at a launch flag at all.
        hint: (activeRecord.agent || 'claude') === 'claude' ? 'start or resume' : `start ${activeRecord.agent}`,
        keywords: 'run start resume claude agent',
        run: () => wake(),
      });
      if (activeRecord.hasHistory)
        list.push({
          id: 'fork',
          label: `Fork ${activeRecord.name}`,
          hint: 'new id, same history',
          keywords: 'branch copy diverge',
          run: () => wake({ fork: true }),
        });
      // Offered only while something is actually running in it, so the palette never lists a stop
      // for a session that is already stopped.
      if (running?.has(activeRecord.name))
        list.push({
          id: 'quit',
          label: `Stop ${activeRecord.name}`,
          hint: 'ends the shell, keeps the history',
          keywords: 'kill quit stop end terminate shut',
          run: () => quitActive(activeRecord),
        });
    }
    list.push({ id: 'teleport', label: 'Teleport a session here', hint: 'from another machine', keywords: 'move sync import cli token', run: () => setTeleportOpen(true) });
    list.push({
      id: 'new-agent',
      label: 'Add an agent',
      hint: 'names it, gives it a face',
      keywords: 'crew session new create',
      // Focus mode hides the rail, so leave it first -- otherwise this command would appear to do
      // nothing at all. The timeout is for the rail to mount before the click lands on it.
      run: () => {
        setFocus(false);
        setTimeout(() => document.querySelector('.crew-add')?.click(), 30);
      },
    });

    for (const s of crewOfProject) {
      if (s.name === activeSession) continue;
      list.push({ id: `go-${s.id}`, label: `Go to ${s.name}`, hint: awake.has(s.name) ? 'awake' : 'asleep', keywords: 'switch agent crew', run: () => selectSession(s.name) });
    }
    if (activeSession) list.push({ id: 'go-plain', label: 'Go to the plain terminal', hint: activeProject, keywords: 'shell bash switch', run: () => selectSession(null) });

    for (const p of projects) {
      if (p.name === activeProject) continue;
      list.push({ id: `proj-${p.name}`, label: `Open ${p.name}`, hint: 'project', keywords: 'switch project folder', run: () => selectProject(p.name) });
    }
    list.push({ id: 'new-project', label: 'New project', hint: 'folder + agent', keywords: 'create add', run: () => setNewProjectOpen(true) });

    list.push({ id: 'files', label: 'Browse files', keywords: 'tree directory open', run: () => setView('files') });
    list.push({ id: 'preview', label: 'Preview a port', keywords: 'web server localhost', run: () => setView('preview') });
    list.push({ id: 'terminal', label: 'Back to the terminal', keywords: 'shell screen', run: () => setView('terminal') });

    // The agent's own login command, typed into the live terminal. This is what the old guided
    // AgentBar existed for; it survives as one palette entry instead of a permanent bar.
    //
    // Keyed on the *session's* agent, not the project's: a project's crew can mix agents now, so
    // the account you need to be signed in to is whichever CLI is about to run in this window.
    const signInTo = activeRecord?.agent || projectAgent;
    if (activeProject && LOGIN_CMD[signInTo])
      list.push({
        id: 'agent-login',
        label: `Sign in to ${signInTo}`,
        hint: LOGIN_CMD[signInTo],
        keywords: 'auth login api key account',
        run: () => typeInto(activeSession, LOGIN_CMD[signInTo]),
      });

    if (activeProject) list.push({ id: 'tools', label: 'MCP, skills, lessons, templates', keywords: 'config extend', run: () => setToolsOpen(true) });
    list.push({ id: 'settings', label: 'Provider settings', hint: 'Anthropic, DeepSeek, custom', keywords: 'api key login model', run: () => setSettingsOpen(true) });
    if (role === 'admin') list.push({ id: 'admin', label: 'Accounts', hint: 'invite, quotas', keywords: 'users admin people', run: () => setAdminOpen(true) });

    list.push({ id: 'focus', label: focus ? 'Show the crew' : 'Focus mode', hint: 'hide everything but the screen', keywords: 'zen full distraction', run: () => setFocus((v) => !v) });
    list.push({ id: 'theme', label: theme === 'dark' ? 'Switch to light' : 'Switch to dark', keywords: 'appearance colour', run: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) });

    if (activeRecord) list.push({ id: 'remove', label: `Remove ${activeRecord.name}`, hint: 'forgets the face, keeps the history', keywords: 'delete crew', run: removeActive });
    list.push({ id: 'signout', label: 'Sign out', keywords: 'logout leave', run: handleLogout });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRecord, crewOfProject, activeSession, projects, activeProject, projectAgent, role, theme, focus, awake, running]);

  if (authed === null) return <div className="boot-screen" />;
  if (!authed)
    return (
      <Login
        onSignedIn={async () => {
          const s = await authStatus();
          setAuthed(true);
          setRole(s.role || null);
          await landAfterSignIn();
        }}
      />
    );

  const projectUsage = usage.find((u) => u.project === activeProject) || null;
  const who = activeSession || 'plain terminal';
  const state = activeSession
    ? activity[activeSession] && Date.now() - activity[activeSession] < 1500
      ? 'working'
      : awake.has(activeSession)
        ? 'awake'
        : 'asleep'
    : '';

  return (
    <div className="app-shell">
      {/* Two bands, one job each, instead of one strip carrying all of them. Everything used to
          sit on a single row: the name, the folder, the CLI tabs, every face, the start button,
          the remove button and ⌘K, competing for the same horizontal space and scrolling when
          they ran out of it. Split by question instead -- the deck answers "where am I and which
          tool", the band answers "who, and what can I do with them" -- and each row becomes
          scannable without re-reading the other.

          Both are fixed-height on purpose. They sit directly above the terminal, so a row that
          grows or shrinks resizes the terminal under it, which is the exact path this page's
          long-standing flicker ran down (AGENT_CONTEXT/KNOWN_ISSUES.md). */}
      {!focus && (
        <div className="deck">
          <div className="deck-brand">
            <b>codez</b>
            {/* The folder, as a real control rather than a word that opens the palette. It is
                where the `+` below makes its agent and where every terminal on this page stands,
                so it is worth being able to see and change it without knowing a shortcut first.
                A native select: nothing to load, nothing to lay out, and already familiar to
                someone who has never used a command palette in their life. */}
            {activeProject && (
              <>
                <span>/</span>
                <select
                  className="deck-project"
                  aria-label="Project"
                  value={activeProject}
                  onChange={(e) => selectProject(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="deck-newproject"
                  onClick={() => setNewProjectOpen(true)}
                  title="New project — another folder, with its own crew"
                  aria-label="New project"
                >
                  +
                </button>
              </>
            )}
          </div>

          <AgentPages pages={agentPages} active={activePage} onPick={setAgentPage} />

          <div className="deck-spacer" />

          <button type="button" className="deck-k" onClick={() => setPaletteOpen(true)}>
            {/* The label is in a span so the narrow-screen rule can drop it and leave the key
                cap, which is the part that still makes sense with no room for words. */}
            <span>Do anything</span>
            <kbd>⌘K</kbd>
          </button>
        </div>
      )}

      {!focus && activeProject && (
        <div className="band">
          <CrewRail
            project={activeProject}
            activeSession={activeSession}
            sessions={pageCrew}
            showProjects={pageSpansProjects}
            onSelect={openSession}
            activity={activity}
            awake={awake}
            running={running}
            onResume={resumeSession}
            onQuit={quitActive}
            onRemove={removeSession}
            onChanged={refreshCrew}
            agents={agents}
            defaultAgent={activePage}
            onCreated={autoWake}
          />
        </div>
      )}

      <div className="stage">
        <div className="screen">
          {activeProject ? (
            <>
              {openTerms.map((t) => (
                <TerminalView
                  key={t.key}
                  project={t.project}
                  session={t.session}
                  active={view === 'terminal' && t.key === activeKey}
                  registerSender={registerSender}
                  onActivity={noteActivity}
                  onFreshShell={reviveSession}
                />
              ))}
              <div className={`panel ${view === 'files' ? '' : 'is-hidden'}`}>
                <FileBrowser project={activeProject} />
              </div>
              <div className={`panel ${view === 'preview' ? '' : 'is-hidden'}`}>
                <Preview project={activeProject} ports={ports} />
              </div>
            </>
          ) : (
            <div className="empty-state">
              <p>No projects yet. A project is a folder on your server with a real terminal in it.</p>
              <button type="button" className="empty-settings-link" onClick={() => setNewProjectOpen(true)}>
                Make your first one
              </button>
            </div>
          )}
        </div>

        {activeProject && (
          <div className="status">
            <span className="status-who">
              {focus ? '' : who}
              {/* Which CLI is actually running here. Shown for every named session rather than
                  only the unusual ones: with mixed crews the answer is not guessable from the
                  project, and this is the one line you look at while working inside it. */}
              {!focus && activeRecord && <span className="status-agent">{activeRecord.agent || 'claude'}</span>}
            </span>
            <span className={`status-state ${state === 'working' ? 'status-live' : ''}`}>
              {focus ? '' : state}
              {/* A real count, and honest about its edges. Claude Code is the only one of the four
                  whose transcripts Codez parses, so in a project with a mixed crew the number is
                  true but partial -- it says which agents it leaves out rather than letting the
                  figure read as the whole bill. */}
              {!focus && projectUsage?.tracked && (
                <span className="status-tokens">
                  {formatTokens(projectUsage.totalTokens)} tokens
                  {projectUsage.untracked?.length ? ` · ${projectUsage.untracked.join(', ')} not counted` : ''}
                </span>
              )}
              {!focus && projectUsage && !projectUsage.tracked && (
                <span className="status-tokens">usage not tracked for {(projectUsage.untracked || [projectUsage.agent]).join(', ')}</span>
              )}
            </span>
            {/* Which of the three things the screen is showing. These were palette-only, which
                is why the preview may as well not have existed: a feature you can only reach by
                knowing its name is a feature for people who already know it is there. Three words
                in the line that was already here costs no new region of chrome, and `preview`
                carries a live count of what your agents have listening -- so the screen tells you
                an agent produced something while you are still looking at the terminal. */}
            {!focus && (
              <span className="status-views" role="group" aria-label="Screen">
                {[
                  ['terminal', 'terminal', 0],
                  ['files', 'files', 0],
                  ['preview', 'preview', ports.length],
                ].map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    className={`status-view ${view === id ? 'is-on' : ''}`}
                    aria-pressed={view === id}
                    onClick={() => setView(id)}
                    title={
                      id === 'preview'
                        ? count
                          ? `${count} ${count === 1 ? 'server' : 'servers'} running — open the preview`
                          : 'Nothing running yet — a dev server appears here on its own'
                        : undefined
                    }
                  >
                    {label}
                    {count > 0 && <span className="status-view-count">{count}</span>}
                  </button>
                ))}
              </span>
            )}
            <button
              type="button"
              className="status-hint"
              onClick={() => setFocus((v) => !v)}
              title={focus ? 'Bring the crew back' : 'Hide everything but the screen'}
            >
              {focus ? 'show the crew' : 'focus'}
            </button>
          </div>
        )}
      </div>

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {adminOpen && <Admin onClose={() => setAdminOpen(false)} />}
      {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} onCreate={handleCreate} />}
      {toolsOpen && activeProject && <ProjectTools project={activeProject} onClose={() => setToolsOpen(false)} />}
      {teleportOpen && <TeleportCard onClose={() => setTeleportOpen(false)} />}
    </div>
  );
}
