import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createProxyMiddleware } from 'http-proxy-middleware';

import { login, logout, authStatus, requireAuth, sessionFromCookieHeader } from './auth.js';
import { listProjects, createProject } from './projects.js';
import { listDir, readFile } from './files.js';
import { attachTerminal } from './pty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 8080;

for (const required of ['SESSION_SECRET', 'ACCESS_PASSWORD']) {
  if (!process.env[required]) {
    console.error(`Refusing to start: ${required} is not set`);
    process.exit(1);
  }
}

// $HOME (see Dockerfile) is where `claude login` keeps its credentials and where any shell tool
// writes its own config -- it has to exist before a PTY tries to start a shell in it.
if (process.env.HOME) fs.mkdirSync(process.env.HOME, { recursive: true });

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
app.use(express.json({ limit: '256kb' }));

let ready = false;
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => (ready ? res.json({ status: 'ready' }) : res.status(503).json({ status: 'starting' })));
app.get('/version', (req, res) => res.json({ sha: process.env.APP_SHA || 'unknown', built: process.env.APP_BUILT || 'unknown' }));
app.get('/openapi.json', (req, res) =>
  res.json({ openapi: '3.0.0', info: { title: 'Forge', version: '0.1.0' }, paths: { '/api/projects': {}, '/api/files': {}, '/api/file': {} } })
);

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/auth/status', authStatus);

app.use('/api', requireAuth);

app.get('/api/projects', (req, res) => res.json({ projects: listProjects() }));
app.post('/api/projects', (req, res) => {
  try {
    res.json(createProject(String(req.body?.name || '').trim()));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
app.get('/api/files', (req, res) => {
  const entries = listDir(String(req.query.project || ''), String(req.query.path || '.'));
  if (!entries) return res.status(404).json({ error: 'Not found' });
  res.json({ entries });
});
app.get('/api/file', (req, res) => {
  const file = readFile(String(req.query.project || ''), String(req.query.path || ''));
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

// A dev server the person starts inside their project's terminal (npm run dev, etc) shows up
// here once they tell Forge which port it's on -- kept as a plain per-request header rather than
// server-side state, since the only thing that needs to know is this one proxy call itself.
app.use('/preview/:project', requireAuth, (req, res, next) => {
  const port = Number(req.headers['x-forge-preview-port']) || Number(req.query.port);
  if (!port || port < 1 || port > 65535) return res.status(400).json({ error: 'Missing or invalid preview port' });
  createProxyMiddleware({
    target: `http://127.0.0.1:${port}`,
    changeOrigin: true,
    ws: true,
    pathRewrite: { [`^/preview/${req.params.project}`]: '' },
  })(req, res, next);
});

const staticDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(staticDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/preview')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(staticDir, 'index.html'));
});

const server = app.listen(PORT, () => {
  ready = true;
  console.log(`Forge listening on :${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws/terminal')) return socket.destroy();
  const session = sessionFromCookieHeader(req.headers.cookie);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const url = new URL(req.url, 'http://localhost');
    attachTerminal(ws, {
      project: url.searchParams.get('project'),
      sessionId: url.searchParams.get('sessionId'),
      cols: Number(url.searchParams.get('cols')) || 80,
      rows: Number(url.searchParams.get('rows')) || 24,
    });
  });
});
