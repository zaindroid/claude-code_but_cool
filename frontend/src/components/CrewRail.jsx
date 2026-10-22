import { useEffect, useRef, useState } from 'react';
import CrewAvatar from './CrewAvatar.jsx';
import { listSessions, createSession, updateSession } from '../api.js';

// Two letters is enough to tell faces apart at a glance, and short enough to sit in a corner
// badge without pushing anything. Only ever shown when a project's crew actually mixes agents --
// see `mixed` below.
const AGENT_MARK = { claude: 'cl', opencode: 'oc', codex: 'cx', deepcode: 'dc' };

// The crew, inline in the top strip. These faces are the app's only persistent navigation: click
// one to put that agent on the screen.
//
// Everything you can *do* to a session -- wake, fork, remove, teleport -- lives in the command
// palette instead of as buttons here. That is the point of the redesign rather than a shortcut:
// six visible buttons that change meaning depending on which face is selected is exactly the kind
// of chrome that makes a person re-read the interface every time they look at it. Faces show
// state; one key does actions.
//
// A session is a real Claude Code session with a real name -- the same name another agent types
// into SendMessage to reach it, and the same name that seeds its face. The shell behind it keeps
// running whether or not anyone is looking (pty.js gives named sessions a long idle life so that
// is actually true, not just implied).
export default function CrewRail({
  project,
  activeSession,
  onSelect,
  activity,
  awake,
  refreshKey,
  onSessionsChange,
  agents = [],
  defaultAgent = 'claude',
  onCreated,
}) {
  const [sessions, setSessions] = useState([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftAgent, setDraftAgent] = useState(defaultAgent);
  const [renaming, setRenaming] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const addRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    listSessions(project)
      .then((r) => {
        if (cancelled) return;
        setSessions(r.sessions || []);
        onSessionsChange?.(r.sessions || []);
      })
      .catch(() => !cancelled && setSessions([]));
    return () => {
      cancelled = true;
    };
  }, [project, refreshKey]);

  // What a new face runs unless you say otherwise: whatever the last one you added to this project
  // runs. "Same as last time" is the most learnable default and self-corrects after one deliberate
  // choice, so a crew stays coherent without anyone maintaining a setting.
  //
  // The project's own declared agent is only the fallback for an empty crew -- live-checked
  // against a real account, where a project created as `deepcode` had three Claude sessions in it,
  // so inheriting the project would have quietly offered DeepCode and lost name-addressing with
  // it. The sessions file is append-ordered, so the last entry is the most recent.
  const inheritedAgent = sessions.length ? sessions[sessions.length - 1].agent || defaultAgent : defaultAgent;

  useEffect(() => {
    if (adding) {
      setDraftAgent(inheritedAgent);
      addRef.current?.focus();
    }
  }, [adding, inheritedAgent]);

  // Which pose each face wears. `activity` is the real signal -- a timestamp set whenever that
  // session's PTY actually emits output -- so "working" means the agent genuinely just said
  // something rather than that a spinner is running on a timer.
  function stateOf(s) {
    const last = activity?.[s.name];
    if (last && Date.now() - last < 1500) return 'working';
    if (awake?.has(s.name)) return 'resting';
    return 'asleep';
  }

  // Agent badges appear only when this project's crew actually runs more than one CLI. With an
  // all-Claude crew there is nothing to tell apart, so the badge would be decoration; the moment
  // you mix, the distinction is real and every face gets marked.
  const mixed = new Set(sessions.map((s) => s.agent || 'claude')).size > 1;

  function agentLabel(id) {
    return agents.find((a) => a.id === (id || 'claude'))?.label || id || 'claude';
  }

  async function reload() {
    const r = await listSessions(project).catch(() => ({ sessions: [] }));
    setSessions(r.sessions || []);
    onSessionsChange?.(r.sessions || []);
    return r.sessions || [];
  }

  async function submitNew(e) {
    e.preventDefault();
    const name = draft.trim().toLowerCase();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await createSession(project, name, draftAgent);
      setDraft('');
      setAdding(false);
      await reload();
      onSelect(session.name);
      // Adding an agent should leave you with a *running* agent, not a bash prompt. The parent
      // owns this because waking means typing into the session's live terminal, which only exists
      // once the terminal component has mounted and its socket has spoken -- see App.jsx.
      onCreated?.(session);
    } catch (err) {
      // Shown verbatim: the server's 409 explains *why* names are unique across the account
      // (agents address each other by name), which is the one rule here that would otherwise
      // look arbitrary.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitRename(e, s) {
    e.preventDefault();
    const name = renameDraft.trim().toLowerCase();
    setRenaming(null);
    if (!name || name === s.name) return;
    setError(null);
    try {
      await updateSession(project, s.id, { name });
      await reload();
      if (activeSession === s.name) onSelect(name);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="crew-rail">
      <div className="crew-faces">
        {sessions.map((s) => {
          const state = stateOf(s);
          if (renaming === s.id) {
            return (
              <form key={s.id} onSubmit={(e) => submitRename(e, s)} className="crew-rename">
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={(e) => submitRename(e, s)}
                  maxLength={32}
                  aria-label={`Rename ${s.name}`}
                />
              </form>
            );
          }
          return (
            <button
              key={s.id}
              type="button"
              className={`crew-member-btn ${activeSession === s.name ? 'is-active' : ''}`}
              onClick={() => onSelect(s.name)}
              onDoubleClick={() => {
                setRenameDraft(s.name);
                setRenaming(s.id);
              }}
              title={`${s.name} — ${state} · ${agentLabel(s.agent)}${s.origin?.kind === 'local' ? ` · teleported from ${s.origin.machine || 'another machine'}` : ''}\nDouble-click to rename`}
            >
              <CrewAvatar name={s.name} state={state} size={34} />
              <span className="crew-member-name">{s.name}</span>
              <span className={`crew-dot crew-dot-${state}`} aria-hidden="true" />
              {mixed && <span className="crew-agent-mark" aria-hidden="true">{AGENT_MARK[s.agent] || '??'}</span>}
            </button>
          );
        })}

        {adding ? (
          <form
            className="crew-add-form"
            onSubmit={submitNew}
            // Click-away still closes an empty form, but only when focus genuinely leaves it --
            // a plain onBlur on the input would have closed the form the moment you reached for
            // the agent chips sitting right underneath it.
            onBlur={(e) => {
              if (!draft && !e.currentTarget.contains(e.relatedTarget)) setAdding(false);
            }}
          >
            {/* The face appears as you type, so you pick a name and meet the agent in the same
                motion. Deterministic and local, so it costs nothing to render on every keystroke. */}
            <CrewAvatar name={draft.trim().toLowerCase() || 'new'} state={draft.trim() ? 'idle' : 'asleep'} size={28} />
            <input
              ref={addRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (setDraft(''), setAdding(false))}
              placeholder="name it"
              maxLength={32}
              disabled={busy}
              aria-label="New agent name"
            />
            {/* Which CLI this face runs. Absolutely positioned under the input rather than inline
                in the strip: the strip must not change height or width when this appears, because
                a reflow of the strip resizes the terminal below it, and that path is exactly the
                one the layout-shift work closed (AGENT_CONTEXT/KNOWN_ISSUES.md). */}
            <div className="crew-agent-pick" role="radiogroup" aria-label="Which agent to run">
              <div className="crew-agent-chips">
                {(agents.length ? agents : [{ id: 'claude', label: 'Claude Code', available: true }]).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={draftAgent === a.id}
                    className={`crew-agent-chip ${draftAgent === a.id ? 'is-on' : ''}`}
                    disabled={!a.available}
                    // Checked live by the server with `command -v`, so this is "not installed in
                    // your container", not "not supported". Saying which is the difference
                    // between a fixable thing and a dead end.
                    title={a.available ? a.label : `${a.label} isn’t installed in your container`}
                    onMouseDown={(e) => e.preventDefault()} // keeps focus in the name field
                    onClick={() => setDraftAgent(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <p className="crew-agent-note">
                {draftAgent === 'claude'
                  ? 'Other agents can reach this one by name.'
                  : 'Runs here with its own history. Only Claude Code sessions are addressable by name or teleportable.'}
              </p>
            </div>
          </form>
        ) : (
          <button type="button" className="crew-add" onClick={() => setAdding(true)} title="Add an agent">
            +
          </button>
        )}
      </div>

      {error && (
        <button type="button" className="crew-error" onClick={() => setError(null)} title="Dismiss" role="alert">
          {error}
        </button>
      )}
    </div>
  );
}
