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
