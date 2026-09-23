# Forge

A real terminal for Claude Code, hosted on your own server, reachable from anywhere. Not a chat
UI on top of the Claude API -- an actual shell, running an actual PTY, in which you run `claude`
exactly the way you would locally. Password-gated (single user), with a project switcher, a
read-only file browser, and a preview pane for whatever dev server your project runs.

## How it's built

- **Backend** (`backend/`): Express + `ws` + `node-pty`. One PTY per open project terminal,
  bridged to the browser over a WebSocket. A signed session cookie gates every API route and the
  WebSocket upgrade itself -- there is no per-user account system, just one password
  (`ACCESS_PASSWORD`) for the one person this is for.
- **Frontend** (`frontend/`): React + Vite, `@xterm/xterm` for the terminal itself. Claude-inspired
  warm/dark visual design, not a literal clone of Anthropic's own product -- this is a personal
  tool, not something presented as an official Claude product.
- **Projects**: each one is a directory under `DATA_DIR/projects`, and is both what the file
  browser shows and the shell's starting directory -- opening a project is opening a folder.

## Running it locally

```
cd backend && npm install
cd ../frontend && npm install && npm run build   # builds into ../backend/public
cd ../backend
SESSION_SECRET=dev ACCESS_PASSWORD=dev npm start
```

`node-pty` is a native module -- it needs to be built for whatever Node runs `npm start`, same
kind of gotcha as any native addon (see MailZ's own desktop README for the general pattern, if
this ever needs multiple runtimes the way that project does).

## Deploying

Through zorc, as any other app here: `analyze_deployment_requirements()` then `deploy()`.
`app.yaml` declares `SESSION_SECRET` (generated) and `ACCESS_PASSWORD` (you supply this via
`deploy()`'s `env_overrides` -- pick a real password, this gates shell access to your server).

**Persistence is the one open question for this app**: projects and Claude Code's own login
credentials need to survive a restart/redeploy to be worth anything for daily use. The Dockerfile
declares a `/data` volume and points `$HOME` and `DATA_DIR` at it, but whether zorc's deploy
pipeline actually attaches a persistent volume for a plain `kind: coolify` app (as opposed to the
database-backed persistence `database: true` provisions) has not been confirmed. If it turns out
not to be, everything under `/data` is wiped on every redeploy -- worth verifying directly rather
than assuming either way.

## Signing in to Claude Code itself

Two ways, same as running Claude Code anywhere else:

1. **Interactive login**: open a project's terminal, run `claude`, and follow its own sign-in
   flow (a Claude subscription). Credentials persist at `$HOME/.claude` under the `/data` volume,
   if that volume is in fact persistent (see above).
2. **API key**: set `ANTHROPIC_API_KEY` on the deployed app (via zorc's `set_app_env_vars`, not
   declared in `app.yaml` since it's optional) instead of logging in interactively.

## What v1 deliberately leaves out

- File **editing** through the web UI -- the file browser is read-only; editing happens through
  whatever you run in the terminal (Claude Code included). Real scope, not a missing feature by
  accident.
- Auto-detecting a running dev server's port for Preview -- you tell it the port once instead.
- Resuming a terminal session across a page reload beyond the current tab's short reconnect grace
  period (60s) -- reloading the page currently starts a fresh shell in that project.
- Multiple people/accounts -- this is a single-password, single-user tool by design, the same as
  MailZ's own local-mode philosophy, not a product meant to be shared.
