import { useEffect, useRef, useState } from 'react';
import CrewAvatar from './CrewAvatar.jsx';
import { createSession, updateSession } from '../api.js';


// The crew, inline in the top strip. These faces are the app's only persistent navigation: click
// one to put that agent on the screen.
//
// Most of what you can *do* to a session -- fork, teleport, switch -- lives in the command palette
// instead of as buttons here. That is the point of the redesign rather than a shortcut: six
// visible buttons that change meaning depending on which face is selected is exactly the kind of
// chrome that makes a person re-read the interface every time they look at it. Faces show state;
// one key does actions.
//
// Starting and stopping are the exception, and they earned it. A palette entry only helps someone
// who already knows it is there, and "how do I stop this" is a question people ask with their eyes
// -- it was asked here about a shell that had been running unattended with no way to end it. So
// the selected session gets exactly one action button, which is Resume when nothing is running in
// it and Stop when something is, plus a remove that says what it will take.
//
// A session is a real Claude Code session with a real name -- the same name another agent types
// into SendMessage to reach it, and the same name that seeds its face. The shell behind it keeps
// running whether or not anyone is looking (pty.js gives named sessions a long idle life so that
// is actually true, not just implied).
export default function CrewRail({
  project,
  activeSession,
  sessions = [],
  showProjects = false,
  pages = [],
  activePage = 'claude',
  onPage,
  onSelect,
  onResume,
  onQuit,
  onRemove,
  running,
  activity,
  awake,
  onChanged,
  agents = [],
  defaultAgent = 'claude',
  onCreated,
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftAgent, setDraftAgent] = useState(defaultAgent);
  const [removing, setRemoving] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const addRef = useRef(null);

  // What a new face runs unless you say otherwise: the agent whose page you are on. No guessing
  // and no setting to maintain -- you are standing in the answer, and the chips below still let
  // you override it for one face without leaving the page.
  //
  // This replaces inheriting the *project's* declared agent, which was live-caught offering
  // DeepCode in a project (`zmain`) whose whole crew was Claude, silently costing name-addressing
  // and teleport.
  useEffect(() => {
    if (adding) {
      setDraftAgent(defaultAgent);
      addRef.current?.focus();
    }
  }, [adding, defaultAgent]);

  // Which pose each face wears. `activity` is the real signal -- a timestamp set whenever that
  // session's PTY actually emits output -- so "working" means the agent genuinely just said
  // something rather than that a spinner is running on a timer.
  function stateOf(s) {
    const last = activity?.[s.name];
    if (last && Date.now() - last < 1500) return 'working';
    // "Is my agent up?" -- deliberately NOT "is a shell alive?". A shell with nothing running in
    // it is an implementation detail nobody asked about, and showing it as awake was actively
    // misleading: the face looked ready while the thing you came to talk to was gone. A session
    // with no agent reads as asleep, which is also exactly when Resume appears.
    if (running?.has(s.name)) return 'resting';
    return 'asleep';
  }

  // The selected session, when it has no agent running. `null` the rest of the time, which is what
  // hides the Resume button.
  const selected = sessions.find((s) => s.name === activeSession) || null;
  const isRunning = Boolean(selected && running?.has(selected.name));

  function agentLabel(id) {
    return agents.find((a) => a.id === (id || 'claude'))?.label || id || 'claude';
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
      await onChanged?.();
      onSelect({ ...session, project });
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
      await updateSession(s.project || project, s.id, { name });
      await onChanged?.();
      if (activeSession === s.name) onSelect({ ...s, name, project: s.project });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="crew-rail">
      {/* One page per CLI you have agents on, each listing that CLI's agents from every project.
          Shown only once you actually run more than one, on the same principle as the agent marks
          on the faces: with a single-CLI crew there is nothing to choose between, so the tabs
          would be chrome that teaches you nothing.

          Grouping this way rather than by project is not cosmetic. A Claude session's name is
          unique across the whole account and is how other agents address it, so every face on the
          Claude page is a peer that can message every other one -- which is exactly what the
          project-shaped view hid. The other CLIs have no equivalent, and their pages say so. */}
      {pages.length > 1 && (
        <div className="crew-pages" role="tablist" aria-label="Agent pages">
          {pages.map((pg) => (
            <button
              key={pg.id}
              type="button"
              role="tab"
              aria-selected={pg.id === activePage}
              className={`crew-page ${pg.id === activePage ? 'is-on' : ''}`}
              onClick={() => onPage?.(pg.id)}
              title={
                pg.count === 0
                  ? `No ${pg.label} agents yet — + makes one here`
                  : pg.id === 'claude'
                    ? `${pg.count} Claude Code ${pg.count === 1 ? 'agent' : 'agents'} — all peers, each reachable by name`
                    : `${pg.count} ${pg.label} ${pg.count === 1 ? 'agent' : 'agents'} — each runs on its own, not addressable by name`
              }
            >
              {pg.label}
              <span className="crew-page-count">{pg.count}</span>
            </button>
          ))}
        </div>
      )}

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
              onClick={() => onSelect(s)}
              onDoubleClick={() => {
                setRenameDraft(s.name);
                setRenaming(s.id);
              }}
              title={`${s.name} — ${state === 'asleep' && awake?.has(s.name) ? 'no agent running (shell open)' : state} · ${agentLabel(s.agent)}${s.origin?.kind === 'local' ? ` · teleported from ${s.origin.machine || 'another machine'}` : ''}\nClick to switch · double-click to rename`}
            >
              <CrewAvatar name={s.name} state={state} size={34} />
              <span className="crew-member-name">
                {s.name}
                {/* Only when the page actually reaches into more than one project. The two-letter
                    CLI badge that used to sit here is gone: the page you are on already says
                    which CLI these are, so repeating it on every face taught nothing. */}
                {showProjects && <span className="crew-member-where">{s.project}</span>}
              </span>
              <span className={`crew-dot crew-dot-${state}`} aria-hidden="true" />
            </button>
          );
        })}

        {/* An empty page is not a broken one -- it is the page you go to in order to make your
            first agent of that kind. Say so, rather than leaving a bare `+` floating in a strip
            that looks like it failed to load. */}
        {sessions.length === 0 && !adding && (
          <span className="crew-empty">no one here yet —</span>
        )}

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
          </form>
        ) : (
          <button type="button" className="crew-add" onClick={() => setAdding(true)} title="Add an agent">
            +
          </button>
        )}
      </div>

      {/* Which CLI a new face will run. Out of flow so the strip cannot change height when it
          appears -- a reflow of the strip resizes the terminal under it, which is the exact path
          the layout-shift work closed (AGENT_CONTEXT/KNOWN_ISSUES.md).

          Anchored to the rail rather than to the naming form, even though it belongs to that
          form: the faces scroll horizontally, and `overflow-x: auto` clips its own box in BOTH
          axes, so a panel dropping below the strip from inside the scroller was invisible --
          these chips could not be reached at all, which is why every face made in the UI came
          out as Claude whatever you meant to pick. The rail itself never scrolls, so from here
          the panel has nothing to be clipped by. */}
      {adding && (
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
          {/* Where it will actually work. Worth saying up front rather than leaving you to find
              out from a prompt: the name you are typing is also a folder name, so this is the
              one moment where picking a name has a consequence you can still change. */}
          <p className="crew-agent-note">
            <span className="crew-agent-where">
              {project}/{draft.trim().toLowerCase() || 'name'}
            </span>
            {' — its own folder, beside the rest of the crew and '}
            <span className="crew-agent-where">{project}/shared</span>.
          </p>
          <p className="crew-agent-note">
            {draftAgent === 'claude'
              ? 'Other agents can reach this one by name.'
              : 'Runs here with its own history. Only Claude Code sessions are addressable by name or teleportable.'}
          </p>
        </div>
      )}

      {/* One action for the selected session, never two. Deliberately separate from the faces:
          clicking a face only switches to it, so there is no way to start or stop an agent by
          misclicking, and the button names the session so there is no way to be unsure which one
          you just acted on. Resume disappears the moment it has done its job rather than sitting
          there inviting a second agent into the same shell; Stop takes its place. */}
      {selected && !isRunning && (
        <button
          type="button"
          className="crew-resume"
          onClick={() => onResume?.(selected.name)}
          title={
            selected.hasHistory
              ? `Pick ${selected.name} up where it stopped (${agentLabel(selected.agent)} --resume)`
              : `Start ${agentLabel(selected.agent)} in ${selected.name}`
          }
        >
          <span aria-hidden="true">▸</span>
          {selected.hasHistory ? 'Resume' : 'Start'} {selected.name}
        </button>
      )}

      {selected && isRunning && (
        <button
          type="button"
          className="crew-stop"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onQuit?.(selected);
            } catch (err) {
              setError(err.message || 'Could not stop it');
            } finally {
              setBusy(false);
            }
          }}
          title={`End the shell running in ${selected.name}. Its conversation is kept -- Resume picks it up again.`}
        >
          <span aria-hidden="true">■</span>
          Stop {selected.name}
        </button>
      )}

      {/* Removal asks rather than confirms, because the two things people mean by it have very
          different consequences and the old single "Remove" quietly did the harmless one while
          being named like the other. Both are spelled out, and the destructive one says what it
          will take by name. */}
      {selected && !removing && (
        <button type="button" className="crew-remove-open" onClick={() => setRemoving(selected)}>
          Remove {selected.name}…
        </button>
      )}

      {removing && (
        <div className="crew-remove" role="group" aria-label={`Remove ${removing.name}`}>
          <button
            type="button"
            onClick={async () => {
              const going = removing;
              setRemoving(null);
              await onRemove?.(going, { purge: false });
            }}
          >
            Forget the face
            <span>Its conversation stays. Adding the name back picks it up again.</span>
          </button>
          <button
            type="button"
            className="crew-remove-hard"
            onClick={async () => {
              const going = removing;
              setRemoving(null);
              await onRemove?.(going, { purge: true });
            }}
          >
            Delete everything
            <span>
              {removing.dir ? `Deletes its ${removing.dir}/ folder and its conversation. ` : 'Deletes its conversation. '}
              Permanent.
            </span>
          </button>
          <button type="button" className="crew-remove-cancel" onClick={() => setRemoving(null)}>
            Keep it
          </button>
        </div>
      )}

      {error && (
        <button type="button" className="crew-error" onClick={() => setError(null)} title="Dismiss" role="alert">
          {error}
        </button>
      )}
    </div>
  );
}
