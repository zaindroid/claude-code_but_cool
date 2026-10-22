// Teleport: move a live coding session between a machine you own and Codez, in either direction,
// and have it keep working on the other side.
//
// ## What a session actually is
//
// Three things, and all three have to land or the session arrives broken:
//   1. The transcript -- Claude Code's own JSONL at <home>/.claude/projects/<slug>/<uuid>.jsonl.
//      This IS the conversation. `claude --resume <uuid>` reads it.
//   2. The workspace -- the files the conversation is about.
//   3. The identity -- the same uuid and the same name, so `--resume` finds the transcript and
//      other agents can still address it (sessions.js).
//
// Credentials are deliberately NOT in that list. A teleported session authenticates as the Codez
// account it landed in, using that account's own provider settings (settings.js, encrypted at
// rest) -- so it works with nobody's laptop online, which is the whole point, and a machine's own
// API key never travels. That is the one place this is intentionally not a faithful copy.
//
// ## Why git, and why not GitHub
//
// The workspace moves as a git bundle: a single file holding real commits, which `git fetch`
// applies as a real fetch. That buys actual merges, actual history, actual conflict resolution and
// resumable incremental transfer, none of which a tarball of files can offer -- and it was the
// user's own instinct ("use github in between to share the files").
//
// It does NOT go through GitHub. The deployment this serves is reachable only inside a private
// Tailscale network, and routing the files through GitHub would push them -- including transcripts,
// which routinely contain whatever got pasted into a session -- to a third party outside that
// boundary. A bundle posted to Codez's own API keeps every byte inside the network that was
// already trusted, with no new ports, no SSH keys and no second account to manage. GitHub remains
// available as an ordinary extra remote for anyone who wants it; it is just not in the path.
//
// ## Why the transcript syncs the way it does
//
// A Claude Code transcript is append-only -- entries are added, never rewritten. That single fact
// is what makes two-way sync honest instead of hopeful:
//   - If one side's line count is ahead and the shorter side is a byte-exact prefix of it, the
//     shorter side is simply behind. Append the missing lines. Nothing is lost, nothing is merged.
//   - If the common prefix does NOT match, both sides genuinely advanced independently. There is
//     no correct merge of two divergent conversations, so neither is overwritten: the arriving
//     side forks via `claude --resume <uuid> --fork-session`, which is Claude Code's own flag for
//     exactly this, and both histories survive under different ids.
// A sync that silently picked a winner would destroy real work, and a sync that refused to run
// would be useless. Prefix-compare-then-fork is the only version of this that is both safe and
// usable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectPath, createProject, listProjects } from './projects.js';
import { sanitizedClaudeSessionDir, isOnPath } from './agents.js';
import { chownToUser } from './osUsers.js';
import { createSession, findSessionByName, updateSession, transcriptPath } from './sessions.js';
import { readMcpServers } from './mcp.js';

// Every filesystem and git operation on an account's own data runs as that account's Linux user,
// never as root. Not belt-and-braces: root writing into an account's home is how you end up with
// root-owned files inside a 0700 home directory that the account's own shell then cannot modify,
// which is a real bug this project has already had a version of (the OpenCode binary under /root,
// see AGENT_CONTEXT/KNOWN_ISSUES.md). `su` rather than uid/gid spawn options for the reason
// pty.js documents at length: node never calls initgroups(), su does.
function runAsUser(user, command, { cwd, input } = {}) {
  try {
    return execFileSync('su', [user.linuxUsername, '-s', '/bin/bash', '-c', command], {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Rewrapped for two reasons, both of which cost real debugging time the first time this ran
    // against the live server.
    //
    // 1. child_process puts the process EXIT CODE on `err.status`. Every route here does
    //    `res.status(err.status || 500)`, so a git command exiting 1 became `res.status(1)` and
    //    Express threw `ERR_HTTP_INVALID_STATUS_CODE` -- turning a specific, diagnosable git
    //    failure into an opaque 500 with the actual cause nowhere in the response.
    // 2. execFileSync's own message is just "Command failed", with the real explanation sitting
    //    unread in `err.stderr`. Folding stderr into the message is the difference between
    //    "500 Internal Server Error" and being told exactly which command failed and why.
    const stderr = String(err.stderr || '').trim();
    throw Object.assign(new Error(`ran as ${user.linuxUsername} and failed: ${command}${stderr ? `\n${stderr}` : ''}`), {
      status: 500,
      exitCode: err.status,
    });
  }
}

// Single-quote for POSIX sh: wrap in single quotes and escape embedded single quotes. Used for
// every path that reaches a shell, because project and session names are user-supplied -- they are
// already validated to a narrow character set upstream, but a shell command built by string
// concatenation should not be the thing relying on that.
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function git(user, projectDir, args) {
  return runAsUser(user, `git -C ${q(projectDir)} ${args}`);
}

// --- workspace -------------------------------------------------------------------------------

export function isGitRepo(user, projectDir) {
  try {
    return git(user, projectDir, 'rev-parse --is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
}

// A teleportable workspace has to be a git repo, and this creates one if it isn't.
//
// Stated plainly because it is a real side effect on someone's files: the first teleport of a
// non-repo project runs `git init` and makes one commit. The alternative was a tarball, which
// cannot merge and would therefore have to overwrite -- and silently overwriting the side that
// happened to sync second is precisely the data loss this whole module is arranged to avoid. An
// initial commit is recoverable and inspectable; a clobbered workspace is not.
export function ensureRepo(user, projectDir, { initialCommit = true } = {}) {
  if (isGitRepo(user, projectDir)) return { created: false };
  git(user, projectDir, 'init -q');
  // user.email/name are set locally (not --global) so this never touches anything else the
  // account owns, and so a commit does not fail outright on a container with no git identity.
  git(user, projectDir, `config user.email ${q(`${user.linuxUsername}@codez.local`)}`);
  git(user, projectDir, `config user.name ${q(user.username || user.linuxUsername)}`);

  // Codez's own per-project metadata is excluded from git, via .git/info/exclude rather than
  // .gitignore: info/exclude is local to this clone, so it never appears as a change in the
  // user's own repo or travels to their other machines. Without it, `.codez/` sits permanently
  // untracked, `git status --porcelain` is never empty, and every future sync refuses to
  // fast-forward with "working tree has uncommitted changes" -- for files the user never wrote.
  try {
    runAsUser(user, `printf '%s\\n' '/.codez/' >> ${q(path.join(projectDir, '.git', 'info', 'exclude'))}`);
  } catch {
    /* exclude is a convenience; a repo without it still works */
  }

  // `initialCommit: false` is what a project receiving a teleport wants, and the distinction
  // matters more than it looks. A fresh commit here would give the new repo a root of its own,
  // unrelated to the history about to arrive -- so every single first teleport would land as two
  // unrelated histories, report "diverged", and leave the files invisible in the working tree. A
  // repo with no commits at all has nothing to diverge from, so the arriving branch can simply be
  // adopted (see applyBundle).
  if (initialCommit) {
    git(user, projectDir, 'add -A');
    try {
      git(user, projectDir, `commit -q -m ${q('codez: initial commit before first teleport')} --allow-empty`);
    } catch {
      /* nothing to commit is fine, and not worth refusing a teleport over */
    }
  }
  return { created: true };
}

// The shas this side already has, so the other side can build an incremental bundle instead of
// resending history both already hold.
export function refs(user, projectDir) {
  if (!isGitRepo(user, projectDir)) return {};
  const out = {};
  let text = '';
  try {
    text = git(user, projectDir, 'show-ref --head').trim();
  } catch {
    // `show-ref` exits non-zero when there is nothing to show, which is an ordinary state for a
    // repo with no commits yet -- not an error worth failing a teleport over. An empty ref map is
    // the correct answer and makes the other side send a full bundle, which is what it should do.
    return {};
  }
  for (const line of text ? text.split('\n') : []) {
    const [sha, ref] = line.split(' ');
    if (sha && ref) out[ref] = sha;
  }
  return out;
}

// The branch an incoming bundle actually landed on.
//
// Not hardcoded to `refs/teleport/main`, because the branch name on the other machine is whatever
// that machine's git defaults to -- `master` on an older install, `main` on a newer one, or
// anything the person chose. Assuming `main` meant a bundle pushed from a `master` repo always
// reported "not fast-forwarded" for a reason that had nothing to do with the user's work.
function incomingRef(user, projectDir) {
  let text = '';
  try {
    // The format string is quoted because this command is handed to `bash -c`: unquoted,
    // `%(refname)`'s parentheses are bash syntax, the shell dies with a parse error before git
    // ever runs, and the caller sees "nothing arrived" for a perfectly healthy repo. Live-caught
    // 2026-10-22 on the first real teleport, where the refs had in fact arrived correctly.
    text = git(user, projectDir, `for-each-ref --format=${q('%(refname)')} refs/teleport/`).trim();
  } catch {
    return null;
  }
  const all = text ? text.split('\n').filter(Boolean) : [];
  if (!all.length) return null;
  return all.find((r) => r.endsWith('/main')) || all.find((r) => r.endsWith('/master')) || all[0];
}

// A bundle of everything this side has that `have` does not.
//
// `git bundle create` with negative refs is the standard incremental form. When the other side
// has nothing in common, this falls back to a full bundle, which is correct rather than wasteful:
// a first teleport genuinely has to carry the whole history.
export function createBundle(user, projectDir, have = []) {
  ensureRepo(user, projectDir);
  const bundlePath = path.join('/tmp', `codez-${crypto.randomUUID()}.bundle`);
  const excludes = have
    .filter((sha) => /^[0-9a-f]{7,40}$/i.test(sha))
    // A sha the other side claims but this repo has never heard of would make bundle create fail
    // outright, so each is checked before it is used as a boundary.
    .filter((sha) => {
      try {
        git(user, projectDir, `cat-file -e ${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    })
    .map((sha) => `^${sha}`)
    .join(' ');
  try {
    git(user, projectDir, `bundle create ${q(bundlePath)} --all ${excludes}`);
  } catch (err) {
    // "Refusing to create empty bundle" is git telling us the other side is already up to date --
    // a normal outcome of a no-op sync, not an error to propagate.
    if (/empty bundle/i.test(err.stderr || err.message || '')) return null;
    throw err;
  }
  const data = fs.readFileSync(bundlePath);
  fs.rmSync(bundlePath, { force: true });
  return data;
}

// Applies a bundle as a real fetch, into a namespace of its own.
//
// Fetched into refs/teleport/* rather than straight onto the local branches, and this is the
// deliberate part: an incoming bundle never moves anyone's checked-out branch or touches the
// working tree. What arrives is visible to `git log`, diffable, and mergeable when someone decides
// to merge it -- which is the behaviour that makes a two-way sync safe to run without being asked
// "are you sure" every time. applyBundle reports what landed; merging is a separate, explicit act.
export function applyBundle(user, projectDir, bundleBuffer) {
  // No initial commit: a repo created to receive a teleport must not invent a root commit of its
  // own, or the arriving history is unrelated to it forever. See ensureRepo.
  ensureRepo(user, projectDir, { initialCommit: false });
  const bundlePath = path.join('/tmp', `codez-in-${crypto.randomUUID()}.bundle`);
  // Written 0600 by this process (root), then relaxed to 0644 *by root* so the account's own git
  // can read it when the fetch runs under `su`.
  //
  // This chmod used to run through runAsUser, which could never work and is worth keeping a note
  // about: the file belongs to root, and chmod may only be called by the file's owner, so the
  // account user got EPERM and exit 1 on every single teleport. It was invisible because that
  // exit code was then being used as an HTTP status (see runAsUser). Root owns the file, so root
  // has to be the one to open it up.
  fs.writeFileSync(bundlePath, bundleBuffer, { mode: 0o600 });
  try {
    fs.chmodSync(bundlePath, 0o644);
    const out = git(user, projectDir, `fetch -q ${q(bundlePath)} "refs/heads/*:refs/teleport/*" --force`);
    return { ok: true, output: out, refs: refs(user, projectDir) };
  } finally {
    fs.rmSync(bundlePath, { force: true });
  }
}

// Fast-forwards the working branch to what arrived, but only when that is provably safe: the
// current branch has to be a strict ancestor of the incoming one, and the working tree clean.
// Anything else is a real divergence and is left for a human (or the agent itself, in its own
// terminal, where it can see what it is doing) to merge.
export function tryFastForward(user, projectDir, ref = null) {
  try {
    const incomingRefName = ref || incomingRef(user, projectDir);
    if (!incomingRefName) return { moved: false, reason: 'nothing arrived to fast-forward to' };

    // No HEAD at all means this project was created to receive this session and has no history of
    // its own, so there is nothing to merge *with* -- the arriving branch simply becomes the
    // branch. This is the normal path for a first teleport, and without it the commits land in
    // refs/teleport/* while the working tree stays empty and the files appear to have vanished.
    let head = null;
    try {
      head = git(user, projectDir, 'rev-parse HEAD').trim();
    } catch {
      const branch = incomingRefName.split('/').pop();
      git(user, projectDir, `checkout -q -B ${q(branch)} ${q(incomingRefName)}`);
      return { moved: true, adopted: true, branch, to: git(user, projectDir, 'rev-parse HEAD').trim() };
    }

    const dirty = git(user, projectDir, 'status --porcelain').trim();
    if (dirty) return { moved: false, reason: 'working tree has uncommitted changes' };
    const incoming = git(user, projectDir, `rev-parse ${q(incomingRefName)}`).trim();
    if (head === incoming) return { moved: false, reason: 'already up to date' };
    const base = git(user, projectDir, `merge-base ${head} ${incoming}`).trim();
    if (base !== head) return { moved: false, reason: 'diverged -- needs a real merge', diverged: true };
    git(user, projectDir, `merge --ff-only ${q(incomingRefName)} -q`);
    return { moved: true, from: head, to: incoming };
  } catch (err) {
    return { moved: false, reason: (err.stderr || err.message || 'fast-forward failed').trim() };
  }
}

// --- transcript ------------------------------------------------------------------------------

function readLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    // A trailing newline is normal and must not become a phantom empty entry: an off-by-one in
    // the line count here would make every sync look like a divergence.
    return text.split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// What this side has, in the shape the other side needs to decide what to do.
//
// `prefixSha` is the load-bearing field: the hash of the first `prefix` lines. Comparing it
// against the other side's hash of *its* first `prefix` lines is what distinguishes "behind" from
// "diverged", and it is a byte-exact comparison rather than a heuristic.
export function transcriptMeta(user, projectDir, session, prefix = null) {
  const file = transcriptPath(user, projectDir, session);
  const lines = readLines(file);
  const n = prefix === null ? lines.length : Math.min(Number(prefix) || 0, lines.length);
  return {
    lines: lines.length,
    sha: lines.length ? sha(lines.join('\n')) : null,
    prefix: n,
    prefixSha: n ? sha(lines.slice(0, n).join('\n')) : null,
  };
}

export function readTranscriptFrom(user, projectDir, session, from = 0) {
  const lines = readLines(transcriptPath(user, projectDir, session));
  return { total: lines.length, from: Math.max(0, from), lines: lines.slice(Math.max(0, from)) };
}

// Appends lines, and refuses to do anything else.
//
// `fromLine` must equal the current line count exactly. That makes this operation an append and
// only an append: it cannot truncate, cannot rewrite, and cannot be used to overwrite a
// transcript that moved since the caller last looked -- it just reports the real count and lets
// the caller re-decide. Compare-and-append rather than a blind write is what keeps two machines
// pushing at once from destroying each other's history.
export function appendTranscript(user, projectDir, session, fromLine, incoming) {
  const file = transcriptPath(user, projectDir, session);
  const current = readLines(file);
  if (Number(fromLine) !== current.length) {
    throw Object.assign(
      new Error(`Transcript moved: expected to append at line ${fromLine} but it now has ${current.length}`),
      { status: 409, lines: current.length }
    );
  }
  const clean = (incoming || []).filter((l) => typeof l === 'string' && l.length > 0);
  if (!clean.length) return { lines: current.length, appended: 0 };

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // The whole transcript directory tree has to belong to the account, not to root: `claude` runs
  // as that Linux user and has to be able to append to this file itself afterward. Chowning only
  // the file would leave a root-owned parent directory it cannot write into.
  const slugRoot = sanitizedClaudeSessionDir(user.homeDir, projectDir);
  for (const p of [path.join(user.homeDir, '.claude'), path.join(user.homeDir, '.claude', 'projects'), slugRoot]) {
    try {
      chownToUser(p, user.uid, user.gid);
    } catch {
      /* may not exist yet at this level; the next iteration covers the ones that do */
    }
  }
  fs.appendFileSync(file, (current.length ? '' : '') + clean.join('\n') + '\n', 'utf8');
  chownToUser(file, user.uid, user.gid);
  return { lines: current.length + clean.length, appended: clean.length };
}

// --- arrival ---------------------------------------------------------------------------------

// Everything that has to be true for a teleported session to run here on its own.
//
// Reported rather than silently patched, because the honest answers differ: a missing project is
// something this can fix, and an MCP server pointing at a binary that only exists on the origin
// machine is not. The second one is exactly the kind of thing that would otherwise show up later
// as an agent mysteriously failing a tool call, so it is surfaced at arrival instead.
export function arrivalReport(user, project, projectDir) {
  const warnings = [];
  // readMcpServers returns Claude Code's own shape: a plain { name: {command, args, env} } map.
  const servers = readMcpServers(projectDir);
  for (const [name, spec] of Object.entries(servers || {})) {
    const cmd = String(spec?.command || '').trim();
    if (!cmd) continue;
    if (!isOnPath(cmd)) {
      warnings.push(
        `MCP server "${name}" runs \`${cmd}\`, which is not on PATH in this container -- it worked on the origin machine but will fail here until it is installed or the entry is removed.`
      );
    }
  }
  return { project, warnings };
}

// Lands a session here: makes sure the project exists, registers the session under its ORIGINAL
// uuid (so the transcript it is about to receive is the one `--resume` will find), and reports
// anything that will not work.
export function receiveSession(user, { project, name, claudeSessionId, agent = 'claude', machine = null, cwd = null }) {
  let dir = projectPath(user, project);
  if (!dir) throw Object.assign(new Error('Invalid project name'), { status: 400 });

  if (!fs.existsSync(dir)) {
    // Goes through createProject rather than mkdir so the disk-quota check runs: a teleport is
    // one of the easiest ways to bring a lot of files onto this box, which makes it exactly the
    // path that must not skip the quota (diskUsage.js).
    createProject(user, project, { agent });
    dir = projectPath(user, project);
  }

  const existing = findSessionByName(user, name);
  let session;
  if (existing) {
    if (existing.claudeSessionId !== claudeSessionId) {
      // Same name, different conversation. Refused rather than resolved: renaming someone's
      // session or overwriting an unrelated one are both worse than saying so.
      throw Object.assign(
        new Error(`A different session here is already called "${name}" (in project "${existing.project}"). Rename one of them, or teleport under a different name.`),
        { status: 409 }
      );
    }
    session = existing;
  } else {
    session = createSession(user, project, {
      name,
      agent,
      claudeSessionId,
      origin: { kind: 'local', machine, cwd },
    });
  }

  // Same reason as applyBundle: a project that exists to receive a session must not be given a
  // root commit of its own before the real history arrives, or the two can never be related.
  ensureRepo(user, dir, { initialCommit: false });
  return { session, ...arrivalReport(user, project, dir) };
}

export function markSynced(user, project, sessionId, lines) {
  return updateSession(user, project, sessionId, {
    teleport: { state: 'synced', lastSyncAt: new Date().toISOString(), transcriptLines: lines },
  });
}

export function projectExists(user, project) {
  const dir = projectPath(user, project);
  return Boolean(dir && fs.existsSync(dir));
}

export { listProjects };
