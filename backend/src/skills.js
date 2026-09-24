// Manages Claude Code skills -- real `SKILL.md` files in Claude Code's own two real skill
// locations: `<homeDir>/.claude/skills/<name>/SKILL.md` (personal, applies to every project this
// account opens) and `<projectDir>/.claude/skills/<name>/SKILL.md` (project-scoped, travels with
// the project). Claude Code discovers and loads these itself the moment it starts -- this file
// only writes the same frontmatter+body format by hand-editing would produce, plus lets
// lessons.js turn a saved lesson into a proper skill (see promoteLessonToSkill there).
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function skillsDir(scopeDir) {
  return path.join(scopeDir, '.claude', 'skills');
}

export function personalSkillsDir(user) {
  return skillsDir(user.homeDir);
}

export function projectSkillsDir(projectDir) {
  return skillsDir(projectDir);
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { description: '', body: raw };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { description: fm.description || '', body: m[2].trim() };
}

export function listSkills(scopeDir) {
  const dir = skillsDir(scopeDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const file = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) return null;
      const { description, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      return { name: e.name, description, body };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createSkill(user, scopeDir, name, description, body) {
  if (!NAME_RE.test(name || '')) throw Object.assign(new Error('Skill names: lowercase letters, numbers and dashes only'), { status: 400 });
  const dir = path.join(skillsDir(scopeDir), name);
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${String(description || '').replace(/\n/g, ' ').trim()}\n---\n\n${String(body || '').trim()}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  chownToUser(dir, user.uid, user.gid);
  chownToUser(path.join(dir, 'SKILL.md'), user.uid, user.gid);
  // Walk back up chowning the .claude/skills and .claude dirs too, in case this is the first
  // skill either account or project has ever had -- fs.mkdirSync(recursive) creates them as root.
  let p = skillsDir(scopeDir);
  const stopAt = path.resolve(scopeDir);
  while (p.startsWith(stopAt) && p !== path.dirname(stopAt)) {
    try {
      chownToUser(p, user.uid, user.gid);
    } catch {
      /* best effort */
    }
    if (p === stopAt) break;
    p = path.dirname(p);
  }
  return { name, description, body };
}

export function deleteSkill(scopeDir, name) {
  if (!NAME_RE.test(name || '')) return;
  const dir = path.join(skillsDir(scopeDir), name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
