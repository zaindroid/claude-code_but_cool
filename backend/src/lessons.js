// "Knowledge transfer" between projects: an account-level library of short, reusable lessons --
// something learned in one project's session that's worth having on hand in the next one. Not
// automatic (Codez doesn't read a session's transcript and decide what mattered for you) -- you
// write or paste the lesson yourself, same as jotting a note, and Codez gives it two real places
// to land: appended into a project's own `CLAUDE.md` (which Claude Code reads automatically at
// startup -- a real, documented mechanism, not a Codez invention) or promoted into a proper skill
// (skills.js) so it's discoverable by description rather than just always-on context.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';
import { createSkill, personalSkillsDir } from './skills.js';

function fileFor(user) {
  return path.join(user.homeDir, '.codez-lessons.json');
}

export function listLessons(user) {
  const file = fileFor(user);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function save(user, lessons) {
  fs.writeFileSync(fileFor(user), JSON.stringify(lessons, null, 2), 'utf8');
  chownToUser(fileFor(user), user.uid, user.gid);
}

export function createLesson(user, { title, body, tags, sourceProject }) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!t) throw Object.assign(new Error('A title is required'), { status: 400 });
  if (!b) throw Object.assign(new Error('The lesson itself can’t be empty'), { status: 400 });
  const lesson = {
    id: crypto.randomUUID(),
    title: t,
    body: b,
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [],
    sourceProject: sourceProject || null,
    createdAt: new Date().toISOString(),
  };
  const lessons = listLessons(user);
  lessons.unshift(lesson);
  save(user, lessons);
  return lesson;
}

export function deleteLesson(user, id) {
  const lessons = listLessons(user).filter((l) => l.id !== id);
  save(user, lessons);
}

const MARKER_START = '<!-- codez:lessons:start -->';
const MARKER_END = '<!-- codez:lessons:end -->';

// Appends into CLAUDE.md between markers -- re-running this replaces only that block (found by the
// markers), so injecting again after adding more lessons doesn't pile up duplicate copies of ones
// already there.
export function injectLessonsIntoProject(user, projectDir, lessonIds) {
  const all = listLessons(user);
  const chosen = all.filter((l) => lessonIds.includes(l.id));
  if (!chosen.length) throw Object.assign(new Error('No matching lessons'), { status: 400 });

  const file = path.join(projectDir, 'CLAUDE.md');
  let existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = [
    MARKER_START,
    '## Lessons carried over from other projects',
    '',
    ...chosen.map((l) => `### ${l.title}\n${l.body}`),
    MARKER_END,
  ].join('\n');

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = existing.slice(0, startIdx) + block + existing.slice(endIdx + MARKER_END.length);
  } else {
    existing = existing.trim().length ? `${existing.trim()}\n\n${block}\n` : `${block}\n`;
  }
  fs.writeFileSync(file, existing, 'utf8');
  chownToUser(file, user.uid, user.gid);
  return { injected: chosen.length };
}

export function promoteLessonToSkill(user, id) {
  const lesson = listLessons(user).find((l) => l.id === id);
  if (!lesson) throw Object.assign(new Error('No such lesson'), { status: 404 });
  const name = lesson.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `lesson-${lesson.id.slice(0, 8)}`;
  return createSkill(user, user.homeDir, name, lesson.title, lesson.body);
}
