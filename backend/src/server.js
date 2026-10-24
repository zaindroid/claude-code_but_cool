import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createProxyMiddleware } from 'http-proxy-middleware';

import { login, logout, authStatus, requireAuth, requireAdmin, requireAuthOrToken, bootstrapAdmin, recoveryState, userFromCookieHeader } from './auth.js';
import { createToken, listTokens, revokeToken } from './tokens.js';
import {
  receiveSession,
  refs,
  createBundle,
  applyBundle,
  tryFastForward,
  transcriptMeta,
  readTranscriptFrom,
  appendTranscript,
  markSynced,
} from './teleport.js';
import { listUsers, createUser, setUserQuota, reconcileOsUsers, isFirstBoot } from './users.js';
import { listProjects, createProject, projectPath } from './projects.js';
import { listDir, readFile } from './files.js';
import { attachTerminal, liveSessionNames, busySessionNames, killTerminal, wakeSession } from './pty.js';
import { readSettingsForClient, writeSettings, clearAuthToken, PRESETS } from './settings.js';
import { duBytes, PLATFORM_QUOTA_BYTES, GB } from './diskUsage.js';
import { listAgents, getAgent } from './agents.js';
import { readProjectConfig, writeProjectConfig } from './projectConfig.js';
import { readMcpServers, addMcpServer, removeMcpServer } from './mcp.js';
import { listSkills, createSkill, deleteSkill } from './skills.js';
import { listLessons, createLesson, deleteLesson, injectLessonsIntoProject, promoteLessonToSkill } from './lessons.js';
import { listTemplates, saveProjectAsTemplate } from './templates.js';
import { getUsageForProjects } from './tokenUsage.js';
import { listOwnPorts, isOwnPort } from './ports.js';
import {
  listAllSessions,
  listSessions,
  sessionDir,
  createSession,
  updateSession,
  deleteSession,
  findSessionById,
  launchCommand,
  hasTranscript,
} from './sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');

if (!process.env.SESSION_SECRET) {
  console.error('Refusing to start: SESSION_SECRET is not set');
  process.exit(1);
}
try {
  // Order matters: existing accounts' Linux users have to exist again before bootstrapAdmin
  // checks isFirstBoot() (a fresh container's /etc/passwd never has them, even though the
  // account metadata and home directories under DATA_DIR do -- see osUsers.js/users.js).
  reconcileOsUsers();
  bootstrapAdmin();
} catch (err) {
  console.error(`Refusing to start: ${err.message}`);
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'frame-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'self'"],
      },
    },
  })
);
// Every route here reports failures through this rather than `res.status(err.status || 500)`.
//
// The guard is not defensive padding -- it fixes a real, shipped bug. Errors from
// `child_process.execFileSync` carry the process EXIT CODE on `err.status`, so a git command
// exiting 1 produced `res.status(1)`, which Express rejects with ERR_HTTP_INVALID_STATUS_CODE.
// The request then failed with a generic 500 and the genuine cause never reached the client or
// the log. Anything outside the valid HTTP error range is treated as "not an HTTP status".
function sendError(res, err) {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  const body = { error: err?.message || 'Something went wrong' };
  if (err?.lines !== undefined) body.lines = err.lines;
  res.status(status).json(body);
}

// Resolves the `:project/:name` pair every teleport route takes into a real project directory and
// a real session record, or throws the right 404. A `function` declaration so it is hoisted above
// the routes that close over it.
function teleportTarget(req) {
  const project = String(req.params.project || '');
  const dir = projectPath(req.user, project);
  if (!dir || !fs.existsSync(dir)) throw Object.assign(new Error(`No project called "${project}" here`), { status: 404 });
  const wanted = String(req.params.name || '').toLowerCase();
  const session = (listSessions(req.user, project) || []).find((s) => s.name === wanted);
  if (!session) throw Object.assign(new Error(`No session called "${wanted}" in project "${project}" -- teleport it with /arrive first`), { status: 404 });
  return { project, dir, session };
}

// --- teleport ---------------------------------------------------------------------------------
// Registered BEFORE the global json parser and before the blanket cookie gate below, deliberately,
// for two reasons that both bite otherwise:
//   - These routes carry git bundles and transcript batches, which are far larger than the 256kb
//     the rest of the API is (correctly) limited to. Express runs middleware in registration
//     order, so the global parser would reject a legitimate teleport with a 413 before any
//     route-specific parser could see it.
//   - They authenticate with `requireAuthOrToken` rather than `requireAuth`, because the caller is
//     a CLI on a machine with no browser cookie. See auth.js for why that is scoped to here only.
const teleportJson = express.json({ limit: '24mb' });
const teleportBundle = express.raw({ type: 'application/octet-stream', limit: '128mb' });

app.use('/api/teleport', requireAuthOrToken);

// Connectivity + identity check. The first thing `codez login` calls, so the answer to "is my
// token right and which account am I" is one request with no side effects.
app.get('/api/teleport/hello', (req, res) =>
  res.json({
    ok: true,
    username: req.user.username,
    viaToken: Boolean(req.viaToken),
    projects: listProjects(req.user).map((p) => p.name),
    sessions: listAllSessions(req.user).map((s) => ({ name: s.name, project: s.project, claudeSessionId: s.claudeSessionId })),
  })
);

// Lands a session here (creating the project, within quota, if it doesn't exist) and reports
// anything about it that will not work on this side.
app.post('/api/teleport/arrive', teleportJson, (req, res) => {
  try {
    const { project, name, claudeSessionId, agent, machine, cwd } = req.body || {};
    res.json(
      receiveSession(req.user, {
        project: String(project || '').trim(),
        name: String(name || '').trim().toLowerCase(),
        claudeSessionId: String(claudeSessionId || ''),
        agent: agent ? String(agent) : 'claude',
        machine: machine ? String(machine).slice(0, 64) : null,
        cwd: cwd ? String(cwd).slice(0, 512) : null,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

// Everything the other side needs to work out what to send: which commits this side has, and the
// exact shape of its transcript. `prefix` asks for the hash of the first N lines, which is how
// "behind" is told apart from "diverged" (see teleport.js).
app.get('/api/teleport/:project/:name/state', (req, res) => {
  try {
    const { dir, session } = teleportTarget(req);
    res.json({
      project: req.params.project,
      session: { name: session.name, id: session.id, claudeSessionId: session.claudeSessionId, origin: session.origin },
      refs: refs(req.user, dir),
      transcript: transcriptMeta(req.user, dir, session, req.query.prefix ?? null),
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/teleport/:project/:name/bundle', (req, res) => {
  try {
    const { dir } = teleportTarget(req);
    const have = String(req.query.have || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const data = createBundle(req.user, dir, have);
    // 204 rather than an empty 200: "you are already up to date" is a real, expected answer to
    // this question, and git itself refuses to create an empty bundle rather than making one.
    if (!data) return res.status(204).end();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(data);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/teleport/:project/:name/bundle', teleportBundle, (req, res) => {
  try {
    const { dir } = teleportTarget(req);
    if (!req.body?.length) return res.status(400).json({ error: 'Empty bundle' });
    const applied = applyBundle(req.user, dir, req.body);
    // Fast-forwarded only when provably safe; otherwise the incoming work sits in refs/teleport/*
    // for a real merge. Either way the caller is told which happened rather than left to assume.
    const ff = tryFastForward(req.user, dir);
    res.json({ ...applied, fastForward: ff });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/teleport/:project/:name/transcript', (req, res) => {
  try {
    const { dir, session } = teleportTarget(req);
    res.json(readTranscriptFrom(req.user, dir, session, Number(req.query.from) || 0));
  } catch (err) {
    sendError(res, err);
  }
});

// Append-only, with a compare-and-append guard: see appendTranscript. A 409 here is not a failure,
// it is the other side saying "the transcript moved, look again" -- which is what keeps two
// machines pushing at once from destroying each other's history.
app.post('/api/teleport/:project/:name/transcript', teleportJson, (req, res) => {
  try {
    const { dir, session } = teleportTarget(req);
    const result = appendTranscript(req.user, dir, session, Number(req.body?.fromLine), req.body?.lines);
    markSynced(req.user, req.params.project, session.id, result.lines);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

app.use(express.json({ limit: '256kb' }));

let ready = false;
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => (ready ? res.json({ status: 'ready' }) : res.status(503).json({ status: 'starting' })));
// Reported unauthenticated and on purpose: the questions it answers -- which commit is live, did
// the restart pick up the variable I just set, is there an account yet -- are the ones you need
// answered when you cannot get in, and none of the answers help anyone who is not already
// deploying this. SOURCE_COMMIT is what Coolify injects at build; APP_SHA stays first so any other
// host can override it.
app.get('/version', (req, res) =>
  res.json({
    sha: process.env.APP_SHA || process.env.SOURCE_COMMIT || 'unknown',
    built: process.env.APP_BUILT || 'unknown',
    firstBoot: isFirstBoot(),
    recovery: recoveryState(),
  })
);
app.get('/openapi.json', (req, res) =>
  res.json({ openapi: '3.0.0', info: { title: 'Codez', version: '0.1.0' }, paths: { '/api/projects': {}, '/api/files': {}, '/api/file': {}, '/api/admin/users': {} } })
);

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/auth/status', authStatus);

app.use('/api', requireAuth);

app.get('/api/projects', (req, res) => res.json({ projects: listProjects(req.user) }));
app.post('/api/projects', (req, res) => {
  try {
    const agent = req.body?.agent ? String(req.body.agent) : 'claude';
    const templateId = req.body?.templateId ? String(req.body.templateId) : null;
    res.json(createProject(req.user, String(req.body?.name || '').trim(), { agent, templateId }));
  } catch (err) {
    sendError(res, err);
  }
});

// Resolves ':project' against the signed-in user only -- projectPath() already refuses anything
// that isn't a direct child of their own projectsDir (see projects.js), so every route below this
// point inherits that same path-traversal safety for free.
function requireProjectDir(req, res) {
  const dir = projectPath(req.user, req.params.project);
  if (!dir || !fs.existsSync(dir)) {
    res.status(404).json({ error: 'No such project' });
    return null;
  }
  return dir;
}

app.get('/api/agents', (req, res) => res.json({ agents: listAgents() }));

// --- machine tokens ---------------------------------------------------------------------------
// Behind the cookie-only gate on purpose: minting a credential is something a signed-in human
// does in a browser, never something an existing token can do for itself. Otherwise one leaked
// token could quietly issue itself replacements and revoking it would achieve nothing.
app.get('/api/tokens', (req, res) => res.json({ tokens: listTokens(req.user) }));
app.post('/api/tokens', (req, res) => {
  try {
    const { token, record } = createToken(req.user, req.body?.label);
    // The only response that ever contains the real token. Not logged, not stored in plaintext,
    // and not retrievable afterward -- the UI has to tell the user to copy it now.
    res.status(201).json({ token, record });
  } catch (err) {
    sendError(res, err);
  }
});
app.delete('/api/tokens/:id', (req, res) => {
  try {
    res.json(revokeToken(req.user, req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/projects/:project/config', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  res.json({ config: readProjectConfig(dir) });
});
app.put('/api/projects/:project/config', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  try {
    const patch = {};
    if (req.body?.agent) {
      if (!getAgent(String(req.body.agent))) throw Object.assign(new Error('Unknown agent'), { status: 400 });
      patch.agent = String(req.body.agent);
    }
    if (typeof req.body?.legendMode === 'boolean') patch.legendMode = req.body.legendMode;
    res.json({ config: writeProjectConfig(req.user, dir, patch) });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Named agent sessions (sessions.js) -------------------------------------------------------
// Account-wide, because that is the scope session *names* live in: every one of this account's
// sessions runs in the same shared container, so to Claude Code they are peer sessions on one
// machine that address each other by name. The crew rail reads this one route to show the whole
// crew at once rather than asking per project.
app.get('/api/sessions', (req, res) => {
  // Both of these are real facts checked at request time, not flags this app remembers -- same
  // principle as /api/agents checking `command -v` rather than trusting the Dockerfile worked.
  // They mean genuinely different things and the crew rail shows them differently:
  //   hasHistory -- a transcript exists on disk, so this session has really run and can --resume
  //   awake      -- a shell is alive for it right now, so it is running or waiting on input
  //   running    -- that shell has a program in the foreground, i.e. the agent is actually up.
  //                 Distinct from awake on purpose: exit your agent and the shell lives on with
  //                 nothing in it, which is precisely the state the Resume button exists for.
  const awake = liveSessionNames(req.user);
  const running = busySessionNames(req.user);
  const sessions = listAllSessions(req.user).map((s) => {
    const dir = projectPath(req.user, s.project);
    return {
      ...s,
      hasHistory: dir ? hasTranscript(req.user, dir, s) : false,
      awake: awake.has(s.name),
      running: running.has(s.name),
    };
  });
  res.json({ sessions });
});

app.get('/api/projects/:project/sessions', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  // Carries the same three live facts as the account-wide route above. It used to return the bare
  // records, which is the list the crew rail actually renders -- so the rail had no way to know a
  // session had history and its Resume button would have offered to "Start" a conversation that
  // already existed. The command the server hands back was always the right one; the label was
  // the thing that would have lied.
  const awake = liveSessionNames(req.user);
  const running = busySessionNames(req.user);
  res.json({
    sessions: listSessions(req.user, req.params.project).map((s) => ({
      ...s,
      hasHistory: hasTranscript(req.user, dir, s),
      awake: awake.has(s.name),
      running: running.has(s.name),
    })),
  });
});

app.post('/api/projects/:project/sessions', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  try {
    res.status(201).json({
      session: createSession(req.user, req.params.project, {
        name: String(req.body?.name || '').trim().toLowerCase(),
        agent: req.body?.agent ? String(req.body.agent) : undefined,
      }),
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/projects/:project/sessions/:id', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  try {
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim().toLowerCase();
    if (req.body?.avatar !== undefined) patch.avatar = req.body.avatar;
    res.json({ session: updateSession(req.user, req.params.project, req.params.id, patch) });
  } catch (err) {
    sendError(res, err);
  }
});

// Stops a session's shell now. Separate from removing it: "I am done working for today" and "this
// agent should not exist" are different intentions, and conflating them is how you lose a
// conversation you meant to keep.
app.post('/api/projects/:project/sessions/:id/quit', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  const session = findSessionById(req.user, req.params.project, req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session' });
  res.json(killTerminal(req.user, req.params.project, session.name));
});

// `?purge=1` deletes the session's own folder and its transcript as well. Without it, history
// stays and the name can be added back to resume -- the long-standing default.
app.delete('/api/projects/:project/sessions/:id', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  try {
    const session = findSessionById(req.user, req.params.project, req.params.id);
    // Killed before the record goes, since killTerminal resolves the shell by session *name* and
    // there would be nothing left to look it up from afterwards. A shell left running against a
    // folder that is about to be deleted is the one outcome worth ruling out here.
    if (session) killTerminal(req.user, req.params.project, session.name);
    res.json(deleteSession(req.user, req.params.project, req.params.id, { purge: req.query.purge === '1' }));
  } catch (err) {
    sendError(res, err);
  }
});

// The command to wake this session, as a string the frontend types into the real terminal (the
// same contract AgentBar's guided-mode buttons already use). Whether it resumes or starts fresh
// is decided here by looking at the filesystem, because `--session-id` on a uuid that already has
// a transcript and `--resume` on one that doesn't are both hard errors -- see launchCommand.
app.get('/api/projects/:project/sessions/:id/launch', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  const session = findSessionById(req.user, req.params.project, req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session' });
  const resume = hasTranscript(req.user, dir, session);
  res.json({
    command: launchCommand(session, { resume, fork: req.query.fork === '1' }),
    resume,
  });
});

// Wakes a session: works out the right command and types it into the session's shell, starting
// that shell first if it is not running.
//
// The frontend used to do this itself, and it was the most fragile thing in the app -- it needed
// the terminal pane mounted, its send function registered, and for a just-started shell an output
// event within eight seconds or the command was dropped in silence. The case that broke it is the
// ordinary one: quit Claude and the shell sits at a bare prompt, emitting nothing ever again, so a
// wake waiting on "first output" waited for a byte that was never coming. You were left at a
// prompt with no way back into the agent except knowing what to type.
//
// Deciding resume-vs-fresh stays here, where /launch already does it, because the answer comes
// from the filesystem: `--session-id` on a uuid that already has a transcript and `--resume` on one
// that does not are both hard errors.
app.post('/api/projects/:project/sessions/:id/wake', async (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  const session = findSessionById(req.user, req.params.project, req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session' });
  const resume = hasTranscript(req.user, dir, session);
  const command = launchCommand(session, { resume, fork: req.body?.fork === true });
  try {
    const woken = await wakeSession(req.user, {
      project: req.params.project,
      session: session.name,
      command,
      cols: Number(req.body?.cols) || 80,
      rows: Number(req.body?.rows) || 24,
    });
    if (!woken) return res.status(404).json({ error: 'Unknown project' });
    res.json({ ...woken, resume });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/projects/:project/mcp', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  res.json({ servers: readMcpServers(dir) });
});
app.post('/api/projects/:project/mcp', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  try {
    res.json({ servers: addMcpServer(req.user, dir, String(req.body?.name || '').trim(), req.body || {}) });
  } catch (err) {
    sendError(res, err);
  }
});
app.delete('/api/projects/:project/mcp/:name', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  res.json({ servers: removeMcpServer(req.user, dir, req.params.name) });
});

// Skills: ?project=<name> scopes to that project's own .claude/skills; omitted scopes to the
// account's personal ~/.claude/skills, which every one of their projects picks up.
function skillsScopeDir(req, res) {
  if (req.query.project) {
    const dir = projectPath(req.user, String(req.query.project));
    if (!dir || !fs.existsSync(dir)) {
      res.status(404).json({ error: 'No such project' });
      return null;
    }
    return dir;
  }
  return req.user.homeDir;
}
app.get('/api/skills', (req, res) => {
  const scope = skillsScopeDir(req, res);
  if (!scope) return;
  res.json({ skills: listSkills(scope) });
});
app.post('/api/skills', (req, res) => {
  const scope = skillsScopeDir(req, res);
  if (!scope) return;
  try {
    res.json(createSkill(req.user, scope, String(req.body?.name || '').trim(), req.body?.description, req.body?.body));
  } catch (err) {
    sendError(res, err);
  }
});
app.delete('/api/skills/:name', (req, res) => {
  const scope = skillsScopeDir(req, res);
  if (!scope) return;
  deleteSkill(scope, req.params.name);
  res.json({ ok: true });
});

app.get('/api/lessons', (req, res) => res.json({ lessons: listLessons(req.user) }));
app.post('/api/lessons', (req, res) => {
  try {
    res.json(createLesson(req.user, req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});
app.delete('/api/lessons/:id', (req, res) => {
  deleteLesson(req.user, req.params.id);
  res.json({ ok: true });
});
app.post('/api/lessons/:id/promote', (req, res) => {
  try {
    res.json(promoteLessonToSkill(req.user, req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});
app.post('/api/projects/:project/inject-lessons', (req, res) => {
  const dir = requireProjectDir(req, res);
  if (!dir) return;
  try {
    res.json(injectLessonsIntoProject(req.user, dir, Array.isArray(req.body?.lessonIds) ? req.body.lessonIds : []));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/templates', (req, res) => res.json({ templates: listTemplates(req.user) }));
app.post('/api/templates', (req, res) => {
  const dir = projectPath(req.user, String(req.body?.project || ''));
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'No such project' });
  try {
    res.json(saveProjectAsTemplate(req.user, dir, String(req.body?.name || '').trim(), req.body?.description));
  } catch (err) {
    sendError(res, err);
  }
});

// The token-usage HUD -- one call, every open project's real usage (Claude Code only tracked for
// real right now, see tokenUsage.js), so the frontend can poll one endpoint instead of one per tab.
app.get('/api/usage/tokens', (req, res) => {
  const projects = listProjects(req.user).map((p) => {
    const dir = projectPath(req.user, p.name);
    return {
      name: p.name,
      dir,
      agent: p.agent,
      // The crew's agents, not just the project's: a project declared as one agent can hold
      // sessions running another, and whether any Claude transcript exists for it is what decides
      // if there is a real number to report. See getUsageForProjects.
      sessionAgents: (listSessions(req.user, p.name) || []).map((s) => s.agent),
      // Each agent's own folder, because that is what its transcript slug is derived from.
      sessionDirs: (listSessions(req.user, p.name) || []).map((s) => sessionDir(dir, s)),
    };
  });
  res.json({ usage: getUsageForProjects(req.user, projects) });
});
app.get('/api/files', (req, res) => {
  const entries = listDir(req.user, String(req.query.project || ''), String(req.query.path || '.'));
  if (!entries) return res.status(404).json({ error: 'Not found' });
  res.json({ entries });
});
app.get('/api/file', (req, res) => {
  const file = readFile(req.user, String(req.query.project || ''), String(req.query.path || ''));
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

// Everyone can see their own usage against their own quota, plus the platform-wide total (not
// other accounts' individual usage -- that's the admin panel's job, see /api/admin/users below).
// What this account has listening right now. The preview panel polls it, which is how an agent
// that just ran `npm run dev` ends up offering its result in the UI without anyone being told the
// port -- see ports.js for why this is a reading rather than a guess.
app.get('/api/ports', (req, res) => {
  try {
    res.json({ ports: listOwnPorts(req.user) });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/usage', (req, res) => {
  res.json({
    usedBytes: duBytes(req.user.homeDir),
    quotaBytes: req.user.quotaBytes,
    platformUsedBytes: duBytes(DATA_DIR),
    platformQuotaBytes: PLATFORM_QUOTA_BYTES,
  });
});

app.get('/api/settings', (req, res) => res.json({ settings: readSettingsForClient(req.user), presets: PRESETS }));
app.put('/api/settings', (req, res) => {
  try {
    res.json({ settings: writeSettings(req.user, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/settings/token', (req, res) => res.json({ settings: clearAuthToken(req.user) }));

// Admin-only: the only way any account other than the bootstrap admin ever gets created --
// invite-only by design, see auth.js's own comment on bootstrapAdmin. includeUsage runs a real
// `du` per account, which is why this isn't also exposed on the plain (non-admin) users list.
app.get('/api/admin/users', requireAdmin, (req, res) => res.json({ users: listUsers({ includeUsage: true }), platformQuotaBytes: PLATFORM_QUOTA_BYTES, platformUsedBytes: duBytes(DATA_DIR) }));
app.post('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const user = createUser({ username: String(req.body?.username || '').trim(), password: String(req.body?.password || ''), role: req.body?.role === 'admin' ? 'admin' : 'user' });
    res.json({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
  } catch (err) {
    sendError(res, err);
  }
});
// "Increased by admin on request" -- no self-service request queue, just a direct admin action;
// someone asks (however they ask), the admin bumps it here.
app.patch('/api/admin/users/:id/quota', requireAdmin, (req, res) => {
  try {
    const gb = Number(req.body?.quotaGb);
    if (!Number.isFinite(gb) || gb <= 0) return res.status(400).json({ error: 'quotaGb must be a positive number' });
    const user = setUserQuota(req.params.id, gb * GB);
    res.json({ id: user.id, quotaBytes: user.quotaBytes });
  } catch (err) {
    sendError(res, err);
  }
});

// A dev server an agent starts in its own terminal, shown inside Codez.
//
// The port is in the *path* now, and that is the whole fix. It used to ride in `?port=`, which the
// first request carries and nothing after it does: the browser resolves the page's own
// `<script src="app.js">` against the directory it was served from, with no query string, so
// every stylesheet, script and image after the opening document came back 400. The preview
// appeared to work and then showed a blank page, which is as good as not existing -- and is why
// this looked like a missing feature rather than a broken one. A prefix is inherited by relative
// URLs for free.
//
// The port must be one this account is itself listening on. Accounts share a container and
// therefore share 127.0.0.1, so without that check "preview port 3000" means "preview whoever
// got to 3000 first" -- someone else's dev server, proxied through your own authenticated
// session. See ports.js.
// One proxy per port, made once and kept. Two reasons, and the second one bit hard.
//
// `ws: true` makes http-proxy-middleware register a listener on the server's own `upgrade` event,
// and that listener does not know which paths this middleware was mounted under -- it takes every
// upgrade the process sees. Built fresh per request, as this was, each preview request added
// another one, and from then on Codez's own terminal socket (/ws/terminal) was being handed to
// whatever dev server the preview pointed at. Caught live: a `python3 -m http.server` logging a
// steady stream of `GET /ws/terminal?project=... 404` while the terminal that started it sat
// there reconnecting.
//
// So: no websockets through the preview. A dev server's hot reload will not come through, which
// costs a page refresh; a terminal that cannot hold a socket costs the whole app. If HMR is worth
// having later it needs one explicit upgrade handler that checks the path itself, not this flag.
const previewProxies = new Map();
function proxyForPort(port) {
  if (!previewProxies.has(port))
    previewProxies.set(
      port,
      createProxyMiddleware({
        target: `http://127.0.0.1:${port}`,
        changeOrigin: true,
        ws: false,
      })
    );
  return previewProxies.get(port);
}

function proxyToOwnPort(req, res, next, { port }) {
  if (!port || port < 1 || port > 65535) return res.status(400).json({ error: 'Missing or invalid preview port' });
  if (!isOwnPort(req.user, port))
    return res.status(404).json({ error: `Nothing of yours is listening on port ${port}` });
  return proxyForPort(port)(req, res, next);
}

// Express strips the matched mount path before the handler runs, so what reaches the proxy is
// already the path the dev server expects -- no rewriting needed, and none attempted.
app.use('/preview/:project/:port', requireAuth, (req, res, next) =>
  proxyToOwnPort(req, res, next, { port: Number(req.params.port) })
);

// What a page asks for from the site root rather than from its own directory: Vite's `/@vite/client`
// and `/src/main.jsx`, a built bundle's `/assets/*`, a favicon. A path prefix cannot catch those --
// they leave the prefix by construction -- so they are recognised by where they were asked from.
// The referer is a preview URL this same session was just served, and it only ever selects among
// ports this account already owns, so it widens nothing: it is the same gate, asked about the page
// that is doing the asking.
function previewRefererPort(req) {
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return null;
  try {
    const m = /^\/preview\/[^/]+\/(\d{1,5})(?:\/|$)/.exec(new URL(ref).pathname);
    return m ? Number(m[1]) : null;
  } catch {
    return null; // a referer that is not a URL tells us nothing
  }
}

const staticDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(staticDir));
// Anything left: a preview's own root-absolute asset, or the single-page app.
app.use((req, res, next) => {
  // Codez's own routes are never somebody's dev-server asset, whatever referer they arrive with.
  if (req.path.startsWith('/api') || req.path.startsWith('/preview') || req.path.startsWith('/ws/')) return next();
  const port = previewRefererPort(req);
  if (!port) return next();
  return requireAuth(req, res, () => proxyToOwnPort(req, res, next, { port }));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/preview')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(staticDir, 'index.html'));
});

const server = app.listen(PORT, () => {
  ready = true;
  console.log(`Codez listening on :${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws/terminal')) return socket.destroy();
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const url = new URL(req.url, 'http://localhost');
    attachTerminal(ws, user, {
      project: url.searchParams.get('project'),
      // A named session keys the terminal by name so it survives a reload and can take a second
      // viewer; `sessionId` is the old per-tab random id, still used for anonymous terminals.
      // See pty.js's terminalKey.
      session: url.searchParams.get('session') || null,
      sessionId: url.searchParams.get('sessionId'),
      cols: Number(url.searchParams.get('cols')) || 80,
      rows: Number(url.searchParams.get('rows')) || 24,
    });
  });
});
