// A *named agent session* -- the thing Codez's crew rail shows a face for, the thing you teleport,
// and the thing another agent addresses when it wants to talk to this one.
//
// This is a deliberately thin layer over real Claude Code behaviour rather than a new concept
// Codez invents and then has to keep in sync:
//
//   - Codez generates the session UUID itself and hands it to `claude --session-id <uuid>` on the
//     first launch. That is what makes everything else here deterministic: the transcript lands at
//     exactly `<home>/.claude/projects/<slug>/<uuid>.jsonl` (see agents.js's
//     sanitizedClaudeSessionDir for why that slug is subtler than it looks), so nothing ever has
//     to scan a directory and guess which transcript belongs to which session. Teleport depends
//     on this completely -- it has to be able to *write* a transcript to a path `claude --resume`
//     will then find.
//   - Resuming is `claude --resume <uuid>`, Claude Code's own real resume, not a replayed
//     transcript.
//   - Divergence (the same session advanced on two machines) forks with `--fork-session`, which
//     is Claude Code's own flag for exactly this -- resume into a fresh session id instead of
//     reusing the original. See teleport.js.
//
// Session records live in the project's own `.codez/sessions.json`, next to `.codez/config.json`,
// for the same reason projectConfig.js gives: metadata that travels and backs up with the project
// itself rather than sitting in a separate app database that teleport would then have to migrate
// as a second, independently-broken thing.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chownToUser } from './osUsers.js';
import { projectPath } from './projects.js';
import { getAgent, sanitizedClaudeSessionDir } from './agents.js';

// Lowercase letters, digits and dashes only. This is an *address*, not a title: it gets typed
// into `claude --name`, shown under a blobatar, and passed to another agent's SendMessage, so it
// has to survive all three without quoting. Matches the shape of the auto-generated names the CLI
// itself produces for unnamed sessions (`groundwell-8f`, `per-install-ai-token`).
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// Reserved because a session named this would make `claude --resume <name>` ambiguous against the
// CLI's own vocabulary, or make the crew rail read like a status rather than a name.
const RESERVED = new Set(['new', 'all', 'none', 'idle', 'claude', 'codez', 'admin', 'self', 'me']);

export function isValidSessionName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !RESERVED.has(name);
}

function sessionsFile(projectDir) {
  return path.join(projectDir, '.codez', 'sessions.json');
}

const EMPTY = { version: 1, sessions: [] };

export function readSessions(projectDir) {
  const file = sessionsFile(projectDir);
  if (!fs.existsSync(file)) return { ...EMPTY, sessions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...EMPTY, ...parsed, sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch {
    // A corrupt file reads as empty rather than throwing: a session record is recoverable
    // metadata (the real transcript is the source of truth and is still on disk), so failing
    // closed here would lock someone out of a project over a file this app can simply rewrite.
    return { ...EMPTY, sessions: [] };
  }
}

function writeSessions(user, projectDir, next) {
  const dir = path.join(projectDir, '.codez');
  const isNew = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const file = sessionsFile(projectDir);
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  if (isNew) chownToUser(dir, user.uid, user.gid);
  chownToUser(file, user.uid, user.gid);
  return next;
}

// Every session this account owns, across every one of its projects.
//
// Deliberately derived by scanning the projects rather than kept in a second account-level index:
// the per-project file is the single source of truth, so a teleported project brings its sessions
// with it and shows up here automatically, with no index to rebuild or drift out of sync. An
// account has tens of projects, not thousands -- this is a directory walk, not a query.
export function listAllSessions(user) {
  if (!fs.existsSync(user.projectsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(user.projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(user.projectsDir, entry.name);
    for (const s of readSessions(dir).sessions) out.push({ ...s, project: entry.name });
  }
  return out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function listSessions(user, project) {
  const dir = projectPath(user, project);
  if (!dir) return null;
  return readSessions(dir).sessions.map((s) => ({ ...s, project }));
}

export function findSessionByName(user, name) {
  return listAllSessions(user).find((s) => s.name === name) || null;
}

export function findSessionById(user, project, id) {
  const dir = projectPath(user, project);
  if (!dir) return null;
  return readSessions(dir).sessions.find((s) => s.id === id) || null;
}

// `claudeSessionId` is normally generated here and never supplied -- except by teleport, which
// must preserve the uuid the session already has on its origin machine. That uuid is the name of
// the transcript file and the argument to `--resume`, so a teleported session given a fresh one
// would arrive with its entire history present on disk and unreachable.
export function createSession(user, project, { name, agent = 'claude', origin = null, claudeSessionId = null } = {}) {
  if (claudeSessionId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claudeSessionId)) {
    // Checked rather than trusted: this value lands in a filesystem path, and `claude
    // --session-id` rejects anything that isn't a real uuid anyway, so a bad one would otherwise
    // fail later and further away from its cause.
    throw Object.assign(new Error('claudeSessionId must be a valid UUID'), { status: 400 });
  }
  const dir = projectPath(user, project);
  // projectPath only validates the *shape* of the name (no traversal, a direct child of this
  // account's own projects dir) -- it says nothing about whether that project exists. Checking
  // existence separately matters here because writeSessions' own mkdirSync is recursive: without
  // this, registering a session against a typo'd project name would quietly conjure the project
  // directory into existence, skipping createProject entirely and with it the disk-quota check
  // that is the one place growth through Codez's own UI can actually be stopped (diskUsage.js).
  // Caught by the sessions test, which expected a 404 and got a brand-new project instead.
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw Object.assign(new Error('Unknown project'), { status: 404 });
  }
  if (!isValidSessionName(name)) {
    throw Object.assign(
      new Error('Session name must be 2-32 characters, lowercase letters, numbers and dashes -- it is the name other agents address this one by'),
      { status: 400 }
    );
  }
  if (!getAgent(agent)) throw Object.assign(new Error('Unknown agent'), { status: 400 });

  // Uniqueness is enforced across the WHOLE ACCOUNT, not just within this project, and that is
  // not an arbitrary strictness -- it is forced by how the thing being named actually works.
  // Every account's sessions run inside one shared container (containers-per-account were
  // deliberately rejected; see AGENT_CONTEXT/OVERVIEW.md), so to Claude Code they are all peer
  // sessions on a single machine. `--name` is machine-wide there: live-verified 2026-10-22 that
  // starting a session whose name another live session already holds gets it superseded or
  // suffixed by the CLI itself, with ListAgents then unable to address either unambiguously.
  // Two projects each with a `scout` would therefore silently break agent-to-agent messaging --
  // the whole point of naming them. Rejecting it here is the honest place to say so.
  const clash = findSessionByName(user, name);
  if (clash) {
    throw Object.assign(
      new Error(`Another session in project "${clash.project}" is already called "${name}". Session names are unique across your whole account, because agents address each other by name.`),
      { status: 409 }
    );
  }

  const record = {
    id: `s_${randomUUID().slice(0, 8)}`,
    name,
    agent,
    // Generated now, not on first launch, and never regenerated: this is the uuid that goes to
    // `claude --session-id`, so it is also the transcript filename and the handle teleport and
    // `--resume` both key on. A session record without one would be a session Codez cannot find
    // the transcript for. Teleport passes the origin machine's uuid in instead (see above).
    claudeSessionId: claudeSessionId || randomUUID(),
    createdAt: new Date().toISOString(),
    // Where this session came from. `local` means it was teleported in from a machine; the
    // machine name is recorded so the UI can say "arrived from zains-pc" and so teleport knows
    // which side to sync back to by default. See teleport.js.
    origin: origin || { kind: 'codez', machine: null, cwd: null },
    teleport: { state: 'resident', lastSyncAt: null, transcriptLines: 0 },
  };

  const current = readSessions(dir);
  writeSessions(user, dir, { ...current, sessions: [...current.sessions, record] });
  return { ...record, project };
}

export function updateSession(user, project, id, patch) {
  const dir = projectPath(user, project);
  if (!dir) throw Object.assign(new Error('Unknown project'), { status: 404 });
  const current = readSessions(dir);
  const idx = current.sessions.findIndex((s) => s.id === id);
  if (idx === -1) throw Object.assign(new Error('Unknown session'), { status: 404 });

  // A rename is a re-address, so it goes through the same account-wide uniqueness check as
  // creation -- and has to allow renaming a session to the name it already has (a no-op save
  // from the UI), which a bare findSessionByName would otherwise reject as a clash with itself.
  if (patch.name !== undefined && patch.name !== current.sessions[idx].name) {
    if (!isValidSessionName(patch.name)) {
      throw Object.assign(new Error('Session name must be 2-32 characters, lowercase letters, numbers and dashes'), { status: 400 });
    }
    const clash = findSessionByName(user, patch.name);
    if (clash) {
      throw Object.assign(new Error(`"${patch.name}" is already taken by a session in project "${clash.project}"`), { status: 409 });
    }
  }

  // Whitelisted: `id` and `claudeSessionId` are the two fields everything else keys on, so they
  // are never patchable from a request -- changing either would orphan the real transcript on
  // disk while leaving a record that looks fine.
  const allowed = ['name', 'agent', 'avatar', 'origin', 'teleport', 'lastActiveAt'];
  const next = { ...current.sessions[idx] };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];

  const sessions = [...current.sessions];
  sessions[idx] = next;
  writeSessions(user, dir, { ...current, sessions });
  return { ...next, project };
}

// Removes Codez's record of a session. Does NOT delete the Claude Code transcript: that is the
// real conversation, it lives under the account's own home, and deleting someone's actual history
// as a side effect of tidying a sidebar would be a genuinely destructive surprise. A removed
// session can be re-registered against the same uuid and resume exactly where it left off.
export function deleteSession(user, project, id) {
  const dir = projectPath(user, project);
  if (!dir) throw Object.assign(new Error('Unknown project'), { status: 404 });
  const current = readSessions(dir);
  const sessions = current.sessions.filter((s) => s.id !== id);
  if (sessions.length === current.sessions.length) throw Object.assign(new Error('Unknown session'), { status: 404 });
  writeSessions(user, dir, { ...current, sessions });
  return { ok: true };
}

// Where Claude Code will actually keep this session's transcript, once it has one.
//
// Deterministic precisely because Codez chose the uuid itself (see createSession) -- this is the
// path teleport writes to on arrival and reads from on sync, and the path whose mere existence
// tells us whether a session has ever really run.
export function transcriptPath(user, projectDir, session) {
  return path.join(sanitizedClaudeSessionDir(user.homeDir, projectDir), `${session.claudeSessionId}.jsonl`);
}

export function hasTranscript(user, projectDir, session) {
  try {
    return fs.statSync(transcriptPath(user, projectDir, session)).size > 0;
  } catch {
    return false;
  }
}

// The exact command string to wake this session in a terminal.
//
// Returned to the frontend as a string rather than executed here, because that is this project's
// established contract for anything agent-facing (see AgentBar.jsx): the button types the real
// command into the real shell, so what runs is always something you could have typed yourself and
// can see, edit, or ignore. Nothing is wired behind your back, and nothing here has to be kept in
// sync with flags the CLI might change.
//
// `resume` is passed in rather than inferred from the session record on purpose: the caller reads
// it from whether the transcript file actually exists (hasTranscript), which is the real source of
// truth. A boolean stored on the record would be a second copy of that fact, free to drift -- and
// getting it wrong is not cosmetic: `--session-id` against a uuid that already has a transcript
// is an error, and `--resume` against one that doesn't is equally stuck.
export function launchCommand(session, { resume = false, fork = false } = {}) {
  if (session.agent !== 'claude') {
    const agent = getAgent(session.agent);
    // The other three agents have no equivalent of --session-id/--name, so a named Codez session
    // on them is just a workspace with a label: launch their own plain resume/start command and
    // be honest in the UI that the name is local to Codez rather than addressable by other agents.
    return agent ? agent.launch({ resume }) : 'claude';
  }
  const parts = ['claude'];
  if (resume) {
    parts.push('--resume', session.claudeSessionId);
    // Claude Code's own flag for "resume this, but into a fresh session id" -- which is exactly
    // what divergence needs when the same session advanced both here and on the origin machine
    // (see teleport.js). Forking is how two real histories both survive instead of one quietly
    // overwriting the other.
    if (fork) parts.push('--fork-session');
  } else {
    parts.push('--session-id', session.claudeSessionId);
  }
  parts.push('--name', fork ? `${session.name}-fork` : session.name);
  return parts.join(' ');
}
