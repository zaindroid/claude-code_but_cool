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
export const login = (password) => call('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
export const logout = () => call('/api/logout', { method: 'POST' });
export const listProjects = () => call('/api/projects');
export const createProject = (name) => call('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
export const listFiles = (project, path) => call(`/api/files?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path || '.')}`);
export const readFile = (project, path) => call(`/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`);
