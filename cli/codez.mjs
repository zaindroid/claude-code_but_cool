#!/usr/bin/env node
// `codez` -- teleport a coding session between this machine and your Codez server.
//
// Zero dependencies on purpose: this has to run on whatever machine a session happens to be on,
// including a fresh one, without an npm install first. Everything here is built into Node 18+
// (global fetch, node:crypto) or is git itself.
//
// ## What it moves, and why in that order
//
// A session is a transcript, a workspace and an identity (see backend/src/teleport.js). The
// transcript is Claude Code's own append-only JSONL, which is what makes two-way sync safe:
// whichever side is behind gets the missing lines appended, and a genuine divergence is reported
// rather than resolved by guessing. The workspace moves as a git bundle, so what lands on the
// other side is a real fetch with real history that can be really merged. The identity is the
// session's uuid and name, preserved exactly, so `claude --resume` finds the transcript and other
// agents can still address it by name.
//
// Nothing here uploads credentials. A teleported session runs on the provider settings of the
// Codez account it lands in, which is what lets it keep working with this machine switched off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const CONFIG_DIR = path.join(os.homedir(), '.codez');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// --- small helpers ----------------------------------------------------------------------------

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function die(msg, hint) {
  console.error(`${c.red('✗')} ${msg}`);
  if (hint) console.error(`  ${c.dim(hint)}`);
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Exactly Claude Code's own rule: every non-alphanumeric character in the absolute project path
// collapses to a single dash. Verified against 33 real transcript directories -- `C:\Users\zain_`
// becomes `C--Users-zain-`. Getting this wrong means looking for the transcript in a directory
// that does not exist, so it is the one piece of string handling here that must be exact.
const slugFor = (dir) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // 0600 because this file holds a bearer token with access to your sessions.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function requireConfig() {
  const cfg = readConfig();
  if (!cfg?.url || !cfg?.token) die('Not signed in on this machine.', 'Run: codez login https://your-codez-host');
  return cfg;
}

async function api(cfg, method, route, { json, body, raw } = {}) {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api/teleport${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    body: json ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return null;
  if (raw) {
    if (!res.ok) die(`${method} ${route} failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body, handled below */
  }
  if (!res.ok) {
    const err = new Error(parsed?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

function git(args, cwd = process.cwd()) {
  // Array args, never a shell string: paths on a real machine contain spaces, and this has to
  // behave identically on Windows and Linux.
  //
  // stderr is explicitly piped rather than left to default. execFileSync forwards the child's
  // stderr to the parent's by default, so every probing call that is *expected* to fail (asking
  // whether this is a repo at all, whether a sha exists) printed a raw `fatal: ...` line straight
  // at the user even though gitQuiet handled it. Captured here so callers decide what to show.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitQuiet(args, cwd = process.cwd()) {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (err) {
    return { ok: false, out: (err.stderr || err.stdout || err.message || '').toString() };
  }
}

// --- local session discovery ------------------------------------------------------------------

function transcriptLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

// Finds the session this command is about: the one named explicitly, or the most recently touched
// transcript for the current directory. "Most recent" is the right default because the session you
// want to teleport is nearly always the one you were just in.
function findLocalSession({ sessionId, cwd = process.cwd() }) {
  const slugDir = path.join(CLAUDE_PROJECTS, slugFor(cwd));
  if (!fs.existsSync(slugDir)) {
    die(
      `No Claude Code sessions found for ${cwd}`,
      `Expected transcripts in ${slugDir} — run \`claude\` here at least once first.`
    );
  }
  const files = fs
    .readdirSync(slugDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, id: f.replace(/\.jsonl$/, ''), mtime: fs.statSync(path.join(slugDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) die(`No session transcripts in ${slugDir}`);

  const chosen = sessionId ? files.find((x) => x.id === sessionId) : files[0];
  if (!chosen) die(`No transcript for session ${sessionId} in ${slugDir}`);

  // The display name set by `/rename` or `claude --name`, which Claude Code keeps in a sibling
  // directory next to the transcript rather than inside it.
  const sidecar = path.join(slugDir, chosen.id);
  let title = null;
  try {
    title = JSON.parse(fs.readFileSync(path.join(sidecar, 'custom-title.json'), 'utf8')).customTitle || null;
  } catch {
    /* unnamed session -- caller falls back */
  }

  return {
    id: chosen.id,
    file: path.join(slugDir, chosen.f),
    slugDir,
    sidecar,
    title,
    lines: transcriptLines(path.join(slugDir, chosen.f)).length,
  };
}

// A session name has to survive being typed into `claude --name`, shown under an avatar, and
// passed to another agent's SendMessage -- so the same narrow shape the server enforces.
function normalizeName(raw, fallback) {
  const base = String(raw || fallback || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (base.length < 2) die('Could not work out a session name.', 'Pass one explicitly: codez up --name scout');
  return base;
}

// --- the sync itself --------------------------------------------------------------------------

// Decides what to do about the transcript, and is the only place that gets to make that call.
//
// Returns one of: 'in-sync', 'push' (local is ahead), 'pull' (remote is ahead), 'diverged'.
// The decision rests on a byte-exact prefix comparison rather than timestamps or line counts
// alone: equal counts with different content is a divergence, and a longer file whose prefix
// differs is NOT simply "ahead".
async function decideTranscript(cfg, project, name, local) {
  const localLines = transcriptLines(local.file);
  const m0 = await api(cfg, 'GET', `/${encodeURIComponent(project)}/${encodeURIComponent(name)}/state`);
  const remoteLines = m0.transcript.lines;

  if (remoteLines === 0 && localLines.length === 0) return { action: 'in-sync', localLines, remoteLines };
  const m = Math.min(localLines.length, remoteLines);

  if (m > 0) {
    const atPrefix = await api(
      cfg,
      'GET',
      `/${encodeURIComponent(project)}/${encodeURIComponent(name)}/state?prefix=${m}`
    );
    const localPrefixSha = sha(localLines.slice(0, m).join('\n'));
    if (atPrefix.transcript.prefixSha !== localPrefixSha) {
      return { action: 'diverged', localLines, remoteLines, at: m };
    }
  }

  if (localLines.length > remoteLines) return { action: 'push', localLines, remoteLines };
  if (remoteLines > localLines.length) return { action: 'pull', localLines, remoteLines };
  return { action: 'in-sync', localLines, remoteLines };
}

async function pushTranscript(cfg, project, name, localLines, fromLine) {
  const slice = localLines.slice(fromLine);
  if (!slice.length) return { appended: 0 };
  // Sent in batches: a long session's transcript is many megabytes, and one giant request is both
  // more likely to fail and worse to retry than several that each make progress.
  const BATCH = 400;
  let at = fromLine;
  let appended = 0;
  for (let i = 0; i < slice.length; i += BATCH) {
    const chunk = slice.slice(i, i + BATCH);
    const res = await api(cfg, 'POST', `/${encodeURIComponent(project)}/${encodeURIComponent(name)}/transcript`, {
      json: { fromLine: at, lines: chunk },
    });
    at = res.lines;
    appended += res.appended;
    process.stdout.write(`\r  ${c.dim(`transcript → ${appended}/${slice.length} lines`)}`);
  }
  process.stdout.write('\n');
  return { appended };
}

async function pullTranscript(cfg, project, name, local, fromLine) {
  const res = await api(
    cfg,
    'GET',
    `/${encodeURIComponent(project)}/${encodeURIComponent(name)}/transcript?from=${fromLine}`
  );
  if (!res.lines.length) return { appended: 0 };
  // Appended, never rewritten -- the same guarantee the server side gives. If this file is
  // mid-write by a running `claude`, appending is still safe where truncating would not be.
  fs.appendFileSync(local.file, res.lines.join('\n') + '\n', 'utf8');
  console.log(`  ${c.dim(`transcript ← ${res.lines.length} lines`)}`);
  return { appended: res.lines.length };
}

function localShas(cwd) {
  const r = gitQuiet(['rev-list', '--all', '--max-count=200'], cwd);
  return r.ok ? r.out.trim().split('\n').filter(Boolean) : [];
}

function ensureLocalRepo(cwd) {
  if (gitQuiet(['rev-parse', '--is-inside-work-tree'], cwd).ok) return false;
  console.log(`  ${c.yellow('!')} ${cwd} is not a git repo — initialising one so the workspace can sync safely.`);
  git(['init', '-q'], cwd);
  git(['add', '-A'], cwd);
  const r = gitQuiet(['commit', '-q', '-m', 'codez: initial commit before first teleport', '--allow-empty'], cwd);
  if (!r.ok) console.log(`  ${c.dim('(nothing to commit yet — that is fine)')}`);
  return true;
}

async function pushWorkspace(cfg, project, name, cwd, remoteRefs) {
  ensureLocalRepo(cwd);
  const have = Object.values(remoteRefs || {});
  const bundle = path.join(os.tmpdir(), `codez-${crypto.randomUUID()}.bundle`);
  const excludes = have.filter((s) => /^[0-9a-f]{7,40}$/i.test(s)).filter((s) => gitQuiet(['cat-file', '-e', `${s}^{commit}`], cwd).ok);
  const args = ['bundle', 'create', bundle, '--all', ...excludes.map((s) => `^${s}`)];
  const made = gitQuiet(args, cwd);
  if (!made.ok) {
    if (/empty bundle/i.test(made.out)) {
      console.log(`  ${c.dim('workspace → already up to date')}`);
      return;
    }
    die(`git bundle failed: ${made.out.trim()}`);
  }
  const data = fs.readFileSync(bundle);
  fs.rmSync(bundle, { force: true });
  const res = await api(cfg, 'POST', `/${encodeURIComponent(project)}/${encodeURIComponent(name)}/bundle`, { body: data });
  const kb = Math.round(data.length / 1024);
  console.log(`  ${c.dim(`workspace → ${kb}KB`)}`);
  if (res?.fastForward?.moved) console.log(`  ${c.dim('remote working tree fast-forwarded')}`);
  else if (res?.fastForward?.diverged) console.log(`  ${c.yellow('!')} remote workspace has diverged — your commits are in refs/teleport/* there, waiting for a real merge`);
  else if (res?.fastForward?.reason) console.log(`  ${c.dim(`remote not fast-forwarded: ${res.fastForward.reason}`)}`);
}

async function pullWorkspace(cfg, project, name, cwd) {
  ensureLocalRepo(cwd);
  const have = localShas(cwd).join(',');
  const data = await api(cfg, 'GET', `/${encodeURIComponent(project)}/${encodeURIComponent(name)}/bundle?have=${have}`, { raw: true });
  if (!data) {
    console.log(`  ${c.dim('workspace ← already up to date')}`);
    return;
  }
  const bundle = path.join(os.tmpdir(), `codez-in-${crypto.randomUUID()}.bundle`);
  fs.writeFileSync(bundle, data);
  try {
    // Into refs/teleport/* rather than onto your branches: an incoming bundle must never move the
    // branch you are standing on or touch your working tree. You merge when you choose to.
    const r = gitQuiet(['fetch', '-q', bundle, 'refs/heads/*:refs/teleport/*', '--force'], cwd);
    if (!r.ok) die(`git fetch from bundle failed: ${r.out.trim()}`);
    console.log(`  ${c.dim(`workspace ← ${Math.round(data.length / 1024)}KB into refs/teleport/*`)}`);

    const dirty = gitQuiet(['status', '--porcelain'], cwd);
    if (dirty.ok && dirty.out.trim()) {
      console.log(`  ${c.yellow('!')} uncommitted local changes — not fast-forwarding. Merge when ready: ${c.cyan('git merge refs/teleport/main')}`);
      return;
    }
    const head = gitQuiet(['rev-parse', 'HEAD'], cwd);
    const inc = gitQuiet(['rev-parse', 'refs/teleport/main'], cwd);
    if (!head.ok || !inc.ok) return;
    const base = gitQuiet(['merge-base', head.out.trim(), inc.out.trim()], cwd);
    if (base.ok && base.out.trim() === head.out.trim() && head.out.trim() !== inc.out.trim()) {
      const ff = gitQuiet(['merge', '--ff-only', 'refs/teleport/main', '-q'], cwd);
      if (ff.ok) console.log(`  ${c.green('✓')} fast-forwarded your workspace`);
    } else if (base.ok && base.out.trim() !== head.out.trim()) {
      console.log(`  ${c.yellow('!')} workspaces diverged — merge when ready: ${c.cyan('git merge refs/teleport/main')}`);
    }
  } finally {
    fs.rmSync(bundle, { force: true });
  }
}

// --- commands ---------------------------------------------------------------------------------

async function cmdLogin(args) {
  const url = args._[0];
  if (!url) die('Usage: codez login <url> [--token czt_...]');
  let token = args.token;
  if (!token) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    token = await new Promise((r) => rl.question('Paste a Codez API token (Settings → Machine tokens): ', (a) => (rl.close(), r(a.trim()))));
  }
  if (!token?.startsWith('czt_')) die('That does not look like a Codez token (they start with czt_).');
  const cfg = { url: url.replace(/\/$/, ''), token, machine: args.machine || os.hostname() };
  const hello = await api(cfg, 'GET', '/hello').catch((e) => die(`Could not reach Codez: ${e.message}`));
  writeConfig(cfg);
  console.log(`${c.green('✓')} Signed in to ${c.bold(cfg.url)} as ${c.bold(hello.username)} (machine: ${cfg.machine})`);
  console.log(`  ${c.dim(`${hello.projects.length} project(s), ${hello.sessions.length} session(s) there`)}`);
}

async function cmdList() {
  const cfg = requireConfig();
  const hello = await api(cfg, 'GET', '/hello');
  console.log(`${c.bold(hello.username)} on ${cfg.url}`);
  if (!hello.sessions.length) return console.log(c.dim('  no named sessions yet'));
  for (const s of hello.sessions) console.log(`  ${c.cyan(s.name.padEnd(20))} ${c.dim(s.project)}`);
}

async function cmdUp(args) {
  const cfg = requireConfig();
  const cwd = process.cwd();
  const local = findLocalSession({ sessionId: args.session, cwd });
  const name = normalizeName(args.name || local.title, path.basename(cwd));
  const project = args.project || path.basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '-');

  console.log(`${c.bold('⇡ teleporting up')}  ${c.cyan(name)} ${c.dim(`(${local.lines} lines, session ${local.id.slice(0, 8)})`)}`);
  console.log(`  ${c.dim(`→ ${cfg.url} / project ${project}`)}`);

  const arrival = await api(cfg, 'POST', '/arrive', {
    json: { project, name, claudeSessionId: local.id, agent: 'claude', machine: cfg.machine, cwd },
  }).catch((e) => die(e.message));

  const state = await api(cfg, 'GET', `/${encodeURIComponent(project)}/${encodeURIComponent(name)}/state`);
  await pushWorkspace(cfg, project, name, cwd, state.refs);

  const decision = await decideTranscript(cfg, project, name, local);
  if (decision.action === 'diverged') {
    console.log(`\n${c.yellow('!')} ${c.bold('Diverged.')} This session advanced both here and on Codez (they agree for the first ${decision.at} lines).`);
    console.log(`  Local has ${decision.localLines.length} lines, Codez has ${decision.remoteLines}.`);
    console.log(`  Neither is being overwritten. To continue the Codez copy as a separate session, open it there and press Fork,`);
    console.log(`  or run: ${c.cyan(`claude --resume ${local.id} --fork-session`)} here.`);
    process.exit(2);
  }
  if (decision.action === 'push') await pushTranscript(cfg, project, name, decision.localLines, decision.remoteLines);
  else if (decision.action === 'pull') await pullTranscript(cfg, project, name, local, decision.localLines.length);
  else console.log(`  ${c.dim('transcript already in sync')}`);

  for (const w of arrival.warnings || []) console.log(`  ${c.yellow('!')} ${w}`);
  console.log(`\n${c.green('✓')} ${c.bold(name)} is live on Codez. Open it there and press Wake, or:`);
  console.log(`  ${c.cyan(`claude --resume ${local.id} --name ${name}`)}  ${c.dim('(in that project\'s terminal)')}`);
}

async function cmdDown(args) {
  const cfg = requireConfig();
  const cwd = process.cwd();
  const name = normalizeName(args.name || args._[0], null);
  const hello = await api(cfg, 'GET', '/hello');
  const remote = hello.sessions.find((s) => s.name === name);
  if (!remote) die(`No session called "${name}" on ${cfg.url}`, `Known: ${hello.sessions.map((s) => s.name).join(', ') || 'none'}`);
  const project = args.project || remote.project;

  console.log(`${c.bold('⇣ teleporting down')}  ${c.cyan(name)} ${c.dim(`→ ${cwd}`)}`);

  await pullWorkspace(cfg, project, name, cwd);

  // The transcript has to land in THIS machine's slug directory for this cwd, which is almost
  // certainly a different path than it had on the server -- that is the whole reason the slug is
  // computed from the local absolute path rather than carried along with the session.
  const slugDir = path.join(CLAUDE_PROJECTS, slugFor(cwd));
  fs.mkdirSync(slugDir, { recursive: true });
  const file = path.join(slugDir, `${remote.claudeSessionId}.jsonl`);
  const local = { file, id: remote.claudeSessionId, lines: transcriptLines(file).length };

  const decision = await decideTranscript(cfg, project, name, local);
  if (decision.action === 'diverged') {
    console.log(`\n${c.yellow('!')} ${c.bold('Diverged.')} Both copies advanced (they agree for the first ${decision.at} lines). Nothing overwritten.`);
    console.log(`  Run ${c.cyan(`claude --resume ${remote.claudeSessionId} --fork-session`)} to continue one as a new session.`);
    process.exit(2);
  }
  if (decision.action === 'pull') await pullTranscript(cfg, project, name, local, decision.localLines.length);
  else if (decision.action === 'push') await pushTranscript(cfg, project, name, decision.localLines, decision.remoteLines);
  else console.log(`  ${c.dim('transcript already in sync')}`);

  // Restore the display name so `/resume` and the prompt box show it here too.
  try {
    const sidecar = path.join(slugDir, remote.claudeSessionId);
    fs.mkdirSync(sidecar, { recursive: true });
    fs.writeFileSync(path.join(sidecar, 'custom-title.json'), JSON.stringify({ customTitle: name }), 'utf8');
  } catch {
    /* cosmetic only */
  }

  console.log(`\n${c.green('✓')} ${c.bold(name)} is here. Continue it with:`);
  console.log(`  ${c.cyan(`claude --resume ${remote.claudeSessionId}`)}`);
}

async function cmdSync(args) {
  // Sync is just "up", which already handles both directions: decideTranscript figures out which
  // side is behind and moves work the right way. Kept as its own verb because "sync" is what
  // people reach for when they do not want to think about direction.
  await cmdUp(args);
}

// Answers "what would `up` actually send?" without touching the network or needing a login.
//
// Worth its own command rather than being a --dry-run flag: the question people ask before
// teleporting is "have you found the right session", and that is answerable entirely locally.
// It is also the one part of this CLI that can be tested on any machine with real transcripts.
async function cmdDetect(args) {
  const cwd = process.cwd();
  const local = findLocalSession({ sessionId: args.session, cwd });
  const name = normalizeName(args.name || local.title, path.basename(cwd));
  const project = args.project || path.basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '-');
  const repo = gitQuiet(['rev-parse', '--is-inside-work-tree'], cwd).ok;
  const branch = repo ? gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).out?.trim() : null;
  const dirty = repo ? Boolean(gitQuiet(['status', '--porcelain'], cwd).out?.trim()) : false;
  const sidecarFiles = fs.existsSync(path.join(local.sidecar, 'tool-results'))
    ? fs.readdirSync(path.join(local.sidecar, 'tool-results')).length
    : 0;

  console.log(`${c.bold('would teleport')}`);
  console.log(`  session name   ${c.cyan(name)}${local.title ? c.dim(`  (from /rename: "${local.title}")`) : c.dim('  (derived from directory)')}`);
  console.log(`  session id     ${local.id}`);
  console.log(`  transcript     ${local.file}`);
  console.log(`                 ${c.dim(`${local.lines} lines`)}`);
  console.log(`  slug dir       ${c.dim(local.slugDir)}`);
  console.log(`  tool-results   ${c.dim(`${sidecarFiles} file(s)`)}`);
  console.log(`  workspace      ${cwd}`);
  console.log(`                 ${repo ? c.dim(`git repo, branch ${branch}${dirty ? ', uncommitted changes' : ', clean'}`) : c.yellow('not a git repo — would be initialised')}`);
  console.log(`  → project      ${c.cyan(project)}`);
  const cfg = readConfig();
  console.log(`  → server       ${cfg?.url ? c.dim(cfg.url) : c.yellow('not signed in — run codez login <url>')}`);
}

function cmdHelp() {
  console.log(`${c.bold('codez')} — teleport a coding session between this machine and your Codez server

  ${c.bold('codez login <url>')} [--token czt_…] [--machine name]
      Store credentials for this machine. Get a token from Settings → Machine tokens.

  ${c.bold('codez up')} [--name scout] [--project foo] [--session <uuid>]
      Send the current directory's most recent session up to Codez. Creates the project there
      if needed. Also pulls down anything Codez is ahead on, so it doubles as a two-way sync.

  ${c.bold('codez down <name>')} [--project foo]
      Bring a session from Codez into the current directory.

  ${c.bold('codez sync')} [--name scout]
      Two-way sync of the current session. Same as \`up\`.

  ${c.bold('codez detect')}      What \`up\` would send, without sending it. No login needed.
  ${c.bold('codez list')}        What is on the server.
  ${c.bold('codez whoami')}      Which account this machine is signed in as.

${c.dim('Transcripts are append-only, so sync never overwrites: whichever side is behind gets the')}
${c.dim('missing lines. If both advanced, it stops and tells you instead of picking a winner.')}
${c.dim('Workspaces move as git bundles and land in refs/teleport/* — your branches are never moved')}
${c.dim('for you unless a fast-forward is provably safe.')}`);
}

// --- entry ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

const run = {
  login: cmdLogin,
  up: cmdUp,
  push: cmdUp,
  down: cmdDown,
  pull: cmdDown,
  sync: cmdSync,
  list: cmdList,
  ls: cmdList,
  detect: cmdDetect,
  whoami: async () => {
    const cfg = requireConfig();
    const h = await api(cfg, 'GET', '/hello');
    console.log(`${h.username} @ ${cfg.url} ${c.dim(`(machine: ${cfg.machine}, via ${h.viaToken ? 'token' : 'cookie'})`)}`);
  },
  help: async () => cmdHelp(),
}[cmd || 'help'];

if (!run) {
  cmdHelp();
  process.exit(1);
}

run(args).catch((err) => die(err.message, err.status === 401 ? 'Token rejected — run codez login again.' : undefined));
