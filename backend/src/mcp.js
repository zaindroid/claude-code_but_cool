// Manages a project's `.mcp.json` -- Claude Code's own real, documented project-scoped MCP config
// format (an `mcpServers` map of name -> {command, args, env}), read automatically by `claude`
// itself the moment it starts in that directory. Codez does not run or proxy MCP servers itself;
// this just writes the same file you'd otherwise hand-edit, so add/remove is a form instead of a
// text editor. Other agents that also read a `.mcp.json` in the project root (OpenCode does) pick
// this up the same way, for free.
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';

function mcpPath(projectDir) {
  return path.join(projectDir, '.mcp.json');
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function readMcpServers(projectDir) {
  const file = mcpPath(projectDir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.mcpServers || {};
  } catch {
    return {};
  }
}

function save(user, projectDir, servers) {
  fs.writeFileSync(mcpPath(projectDir), JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
  chownToUser(mcpPath(projectDir), user.uid, user.gid);
}

export function addMcpServer(user, projectDir, name, spec) {
  if (!NAME_RE.test(name || '')) throw Object.assign(new Error('MCP server names: letters, numbers, dashes and underscores only'), { status: 400 });
  const command = String(spec?.command || '').trim();
  if (!command) throw Object.assign(new Error('A command is required (e.g. npx, uvx, or a full path)'), { status: 400 });
  const args = Array.isArray(spec?.args) ? spec.args.map(String) : [];
  const env = spec?.env && typeof spec.env === 'object' ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) : {};

  const servers = readMcpServers(projectDir);
  servers[name] = { command, args, ...(Object.keys(env).length ? { env } : {}) };
  save(user, projectDir, servers);
  return servers;
}

export function removeMcpServer(user, projectDir, name) {
  const servers = readMcpServers(projectDir);
  delete servers[name];
  save(user, projectDir, servers);
  return servers;
}
