import { useEffect, useRef, useState } from 'react';
import CrewAvatar from './CrewAvatar.jsx';
import { listSessions, createSession, updateSession } from '../api.js';

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
export default function CrewRail({ project, activeSession, onSelect, activity, awake, refreshKey, onSessionsChange }) {
  const [sessions, setSessions] = useState([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
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

  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);

  // Which pose each face wears. `activity` is the real signal -- a timestamp set whenever that
  // session's PTY actually emits output -- so "working" means the agent genuinely just said
  // something rather than that a spinner is running on a timer.
  function stateOf(s) {
    const last = activity?.[s.name];
    if (last && Date.now() - last < 1500) return 'working';
    if (awake?.has(s.name)) return 'resting';
    return 'asleep';
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
      const { session } = await createSession(project, name);
      setDraft('');
      setAdding(false);
      await reload();
      onSelect(session.name);
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
              title={`${s.name} — ${state}${s.origin?.kind === 'local' ? ` · teleported from ${s.origin.machine || 'another machine'}` : ''}\nDouble-click to rename`}
            >
              <CrewAvatar name={s.name} state={state} size={34} />
              <span className="crew-member-name">{s.name}</span>
              <span className={`crew-dot crew-dot-${state}`} aria-hidden="true" />
            </button>
          );
        })}

        {adding ? (
          <form className="crew-add-form" onSubmit={submitNew}>
            {/* The face appears as you type, so you pick a name and meet the agent in the same
                motion. Deterministic and local, so it costs nothing to render on every keystroke. */}
            <CrewAvatar name={draft.trim().toLowerCase() || 'new'} state={draft.trim() ? 'idle' : 'asleep'} size={28} />
            <input
              ref={addRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => !draft && setAdding(false)}
              onKeyDown={(e) => e.key === 'Escape' && (setDraft(''), setAdding(false))}
              placeholder="name it"
              maxLength={32}
              disabled={busy}
              aria-label="New agent name"
            />
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
