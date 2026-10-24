async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) throw Object.assign(new Error(body?.error || res.statusText), { status: res.status });
  return body;
}

export const authStatus = () => call('/api/auth/status');
export const login = (username, password) => call('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
export const logout = () => call('/api/logout', { method: 'POST' });
export const listProjects = () => call('/api/projects');
export const createProject = (name, opts = {}) => call('/api/projects', { method: 'POST', body: JSON.stringify({ name, ...opts }) });
export const listFiles = (project, path) => call(`/api/files?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path || '.')}`);
export const readFile = (project, path) => call(`/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`);

export const getSettings = () => call('/api/settings');
export const saveSettings = (patch) => call('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
export const clearAuthToken = () => call('/api/settings/token', { method: 'DELETE' });

export const listUsers = () => call('/api/admin/users');
export const createUserAccount = (username, password) => call('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password }) });
export const setUserQuota = (id, quotaGb) => call(`/api/admin/users/${id}/quota`, { method: 'PATCH', body: JSON.stringify({ quotaGb }) });

export const getUsage = () => call('/api/usage');

// Agents
export const listAgents = () => call('/api/agents');
export const getProjectConfig = (project) => call(`/api/projects/${encodeURIComponent(project)}/config`);
export const setProjectConfig = (project, patch) => call(`/api/projects/${encodeURIComponent(project)}/config`, { method: 'PUT', body: JSON.stringify(patch) });

// MCP servers
export const listMcpServers = (project) => call(`/api/projects/${encodeURIComponent(project)}/mcp`);
export const addMcpServer = (project, spec) => call(`/api/projects/${encodeURIComponent(project)}/mcp`, { method: 'POST', body: JSON.stringify(spec) });
export const removeMcpServer = (project, name) => call(`/api/projects/${encodeURIComponent(project)}/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });

// Skills
export const listSkills = (project) => call(`/api/skills${project ? `?project=${encodeURIComponent(project)}` : ''}`);
export const createSkill = (spec, project) => call(`/api/skills${project ? `?project=${encodeURIComponent(project)}` : ''}`, { method: 'POST', body: JSON.stringify(spec) });
export const deleteSkill = (name, project) => call(`/api/skills/${encodeURIComponent(name)}${project ? `?project=${encodeURIComponent(project)}` : ''}`, { method: 'DELETE' });

// Lessons (knowledge transfer)
export const listLessons = () => call('/api/lessons');
export const createLesson = (spec) => call('/api/lessons', { method: 'POST', body: JSON.stringify(spec) });
export const deleteLesson = (id) => call(`/api/lessons/${id}`, { method: 'DELETE' });
export const promoteLesson = (id) => call(`/api/lessons/${id}/promote`, { method: 'POST' });
export const injectLessons = (project, lessonIds) => call(`/api/projects/${encodeURIComponent(project)}/inject-lessons`, { method: 'POST', body: JSON.stringify({ lessonIds }) });

// Templates
export const listTemplates = () => call('/api/templates');
export const saveAsTemplate = (project, name, description) => call('/api/templates', { method: 'POST', body: JSON.stringify({ project, name, description }) }).then((r) => r);

// Token usage HUD
export const getTokenUsage = () => call('/api/usage/tokens');

// Named agent sessions -- the crew.
//
// listCrew is account-wide on purpose, matching the backend: session names are unique across the
// whole account because every session is a peer on one machine as far as Claude Code is concerned,
// so the rail can show who exists (and who is awake) without asking project by project.
export const listCrew = () => call('/api/sessions');
export const listSessions = (project) => call(`/api/projects/${encodeURIComponent(project)}/sessions`);
export const createSession = (project, name, agent) =>
  call(`/api/projects/${encodeURIComponent(project)}/sessions`, { method: 'POST', body: JSON.stringify({ name, agent }) });
export const updateSession = (project, id, patch) =>
  call(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
// Starts the agent in this session's shell, starting the shell too if it is not running. The
// server types the command, having decided resume-vs-fresh from the transcript on disk -- the page
// no longer needs a mounted terminal, a registered sender, or an output event it might never get.
export const wakeSession = (project, id, { fork = false, cols, rows } = {}) =>
  call(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(id)}/wake`, {
    method: 'POST',
    body: JSON.stringify({ fork, cols, rows }),
  });

// Stops the shell, leaves the session. The counterpart to waking one.
export const quitSession = (project, id) =>
  call(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(id)}/quit`, { method: 'POST' });
// `purge` also deletes the session's folder and transcript. Default false, so the old behaviour --
// forget the face, keep the history -- is still what you get unless the caller says otherwise.
export const deleteSession = (project, id, { purge = false } = {}) =>
  call(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(id)}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
// Asks the backend for the exact command to wake this session. The backend decides resume-vs-fresh
// by looking at whether the transcript actually exists, which the frontend has no way to know and
// must not guess -- `--session-id` on a uuid that already has history is a hard error, as is
// `--resume` on one that has none.
export const sessionLaunchCommand = (project, id, { fork = false } = {}) =>
  call(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(id)}/launch${fork ? '?fork=1' : ''}`);

// Machine tokens, for teleport. The POST response is the only time the real token exists outside
// the server -- it is stored hashed and can never be read back, so the UI has to make the user
// copy it there and then.
export const listMachineTokens = () => call('/api/tokens');
export const createMachineToken = (label) => call('/api/tokens', { method: 'POST', body: JSON.stringify({ label }) });
export const revokeMachineToken = (id) => call(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Which ports this account's own processes are listening on. The preview panel's whole list, and
// the dot in the status line that says an agent has something to show.
export const listPorts = () => call('/api/ports');
