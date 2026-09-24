// Project starting points: a few built-in scaffolds, plus "save this project as a template" for
// your own. A template is just a real directory of files -- instantiating one is a recursive copy
// into the new project's directory, nothing more; there's no templating-language substitution here,
// deliberately, since a real scaffold (package.json, a starter file or two) works as-is once copied.
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const USER_TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
fs.mkdirSync(USER_TEMPLATES_DIR, { recursive: true });

const SKIP_COPY = new Set(['.git', 'node_modules', '.codez', '.venv', '__pycache__']);

// Small, real, self-contained starters -- not full framework scaffolds (those change too often
// to hand-maintain honestly here), just enough that "New project" isn't always a blank directory.
const BUILTIN = {
  blank: {
    label: 'Blank',
    description: 'An empty project -- nothing pre-written.',
    files: {},
  },
  'node-express': {
    label: 'Node + Express',
    description: 'A minimal Express server with one route.',
    files: {
      'package.json': JSON.stringify({ name: 'app', version: '0.1.0', type: 'module', scripts: { start: 'node index.js' }, dependencies: { express: '^4.21.0' } }, null, 2) + '\n',
      'index.js': "import express from 'express';\n\nconst app = express();\napp.get('/', (req, res) => res.send('Hello from Codez'));\napp.listen(3000, () => console.log('Listening on :3000'));\n",
      '.gitignore': 'node_modules/\n',
    },
  },
  'python-fastapi': {
    label: 'Python + FastAPI',
    description: 'A minimal FastAPI app with one route.',
    files: {
      'requirements.txt': 'fastapi\nuvicorn\n',
      'main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef root():\n    return {"message": "Hello from Codez"}\n',
      '.gitignore': '__pycache__/\n.venv/\n',
    },
  },
};

export function listTemplates(user) {
  const builtin = Object.entries(BUILTIN).map(([id, t]) => ({ id, label: t.label, description: t.description, kind: 'builtin' }));
  const userDir = path.join(USER_TEMPLATES_DIR, user.id);
  const custom = fs.existsSync(userDir)
    ? fs
        .readdirSync(userDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const meta = readMeta(path.join(userDir, e.name));
          return { id: e.name, label: meta.label || e.name, description: meta.description || '', kind: 'custom' };
        })
    : [];
  return [...builtin, ...custom];
}

function readMeta(dir) {
  const file = path.join(dir, '.codez-template.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function chownRecursive(dir, uid, gid) {
  chownToUser(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) chownRecursive(p, uid, gid);
    else chownToUser(p, uid, gid);
  }
}

export function instantiateTemplate(user, templateId, destDir) {
  if (BUILTIN[templateId]) {
    for (const [rel, content] of Object.entries(BUILTIN[templateId].files)) {
      const full = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    chownRecursive(destDir, user.uid, user.gid);
    return;
  }
  const srcDir = path.join(USER_TEMPLATES_DIR, user.id, templateId);
  if (!fs.existsSync(srcDir)) throw Object.assign(new Error('No such template'), { status: 404 });
  copyDir(srcDir, destDir);
  chownRecursive(destDir, user.uid, user.gid);
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function saveProjectAsTemplate(user, projectDir, name, description) {
  if (!NAME_RE.test(name || '')) throw Object.assign(new Error('Template names: letters, numbers, dots, dashes and underscores only'), { status: 400 });
  const userDir = path.join(USER_TEMPLATES_DIR, user.id);
  const destDir = path.join(userDir, name);
  if (fs.existsSync(destDir)) throw Object.assign(new Error('A template with this name already exists'), { status: 409 });
  copyDir(projectDir, destDir);
  fs.writeFileSync(path.join(destDir, '.codez-template.json'), JSON.stringify({ label: name, description: description || '', savedAt: new Date().toISOString() }, null, 2), 'utf8');
  return { id: name, label: name, description: description || '', kind: 'custom' };
}
