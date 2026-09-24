# Codez

A real terminal for Claude Code, hosted on your own server, reachable from anywhere. Not a chat
UI on top of the Claude API -- an actual shell, running an actual PTY, in which you run `claude`
exactly the way you would locally. Invite-only accounts, each with real OS-level isolation, a
project switcher, a read-only file browser, and a preview pane for whatever dev server your
project runs.

## How it's built

- **Backend** (`backend/`): Express + `ws` + `node-pty`. One PTY per open project terminal,
  bridged to the browser over a WebSocket, spawned via `su` as that account's own Linux system
  user (see `osUsers.js`/`pty.js`) -- the actual security boundary between accounts is the kernel's
  own file permissions, not application logic. A signed session cookie (tied to one account) gates
  every API route and the WebSocket upgrade itself.
- **Accounts** (`users.js`, `auth.js`): invite-only -- the first account is created from
  `ADMIN_USERNAME`/`ADMIN_PASSWORD` at first boot, every other one is created by an admin from
  Codez's own Accounts panel. Nobody self-registers; this is real shell access to your server.
- **Frontend** (`frontend/`): React + Vite, `@xterm/xterm` for the terminal itself. Claude-inspired
  warm/dark visual design, not a literal clone of Anthropic's own product -- this is a personal
  tool, not something presented as an official Claude product.
- **Projects**: each one is a directory under the signed-in account's own home directory, and is
  both what the file browser shows and the shell's starting directory -- opening a project is
  opening a folder.
- **Storage quotas** (`diskUsage.js`): 20GB per account by default, 100GB platform-wide, admin-
  adjustable per account. Enforced at project creation, not a kernel quota -- see "Storage" below
  for why, and for what `df` inside a terminal actually reports.
- **Provider settings** (`settings.js`): each account points `claude` at Anthropic directly (an
  interactive login, or an API key), or at any other Anthropic-API-compatible endpoint (DeepSeek,
  Kimi/Moonshot, a custom one) -- stored per account, encrypted at rest.

## Running it locally

```
cd backend && npm install
cd ../frontend && npm install && npm run build   # builds into ../backend/public
cd ../backend
SESSION_SECRET=dev ADMIN_USERNAME=admin ADMIN_PASSWORD=devpassword123 npm start
```

Two things only work on Linux, not for local dev on Windows/macOS:

- `node-pty` is a native module -- it needs to be built for whatever Node runs `npm start`, same
  kind of gotcha as any native addon (see MailZ's own desktop README for the general pattern).
- Account creation shells out to `useradd`/`id`/`su` (see `osUsers.js`) -- these don't exist on
  Windows at all, so the app can only fully boot on Linux. `diskUsage.js`'s `du`-based logic can
  still be exercised in isolation elsewhere (Git Bash ships `du`).

## Deploying

Through zorc, as any other app here: `analyze_deployment_requirements()` then `deploy()`.
`app.yaml` declares `SESSION_SECRET` (generated) and `ADMIN_USERNAME`/`ADMIN_PASSWORD` (supplied
via `deploy()`'s `env_overrides` -- pick a real password, this becomes the first account and gates
shell access to your server). The container runs as root deliberately (no `USER` directive) --
only root can create Linux system users and spawn a process as a different one's uid/gid.

## Persistence

`app.yaml`'s `persistent_storage: {mount_path: /data}` gives this app a real, stable,
Coolify-managed volume -- without it, confirmed live 2026-09-23, Coolify silently gives a plain
`VOLUME` line in the Dockerfile a fresh anonymous volume on *every* deploy, wiping accounts,
projects and Claude Code's own login state each time. This field is only applied on `deploy()`
(app creation), not `redeploy()` -- an app that already exists without it needs tearing down and
redeploying fresh to pick it up.

**Linux system users are a separate persistence problem from the volume.** `/etc/passwd`/`/etc/
group` live in the *container's own* filesystem, not `/data` -- a fresh container after a redeploy
has no record of any account's Linux user at all, even though that account's files (still owned by
the same uid/gid) are sitting right there on the persistent volume. `users.js`'s
`reconcileOsUsers()` runs at startup and recreates every already-known account's system user,
pinned to the exact uid/gid its files already have -- without this, every account breaks
(`su: user ... does not exist`) the moment the container is ever recreated.

## Storage

The `/data` volume is a **100GB loopback ext4 filesystem** (`/mnt/data/codez-quota.img`, loop-
mounted, with an `/etc/fstab` entry so it survives host reboots) on a physical disk separate from
the one every other app on this host stores its data on -- not Coolify's own default (an anonymous
volume on the shared NVMe pool). `df` inside a terminal reports this filesystem's own real,
honest, capped size, not the host's.

This was a deliberate step up from the app-level quota alone: the quota (`diskUsage.js`) is real
and enforced, but `df` would otherwise still report the full host disk regardless of it, which
read as misleading rather than just "not a hard kernel wall". A true *per-account* kernel quota
(ext4 project quotas, or XFS) was considered and rejected -- the shared host filesystem has no
quota support enabled, and turning it on live would touch every other app's storage on the same
disk, a bigger risk than this problem justified.

## Multiple agents, and the guided layer over the terminal

Codez can drive four real coding-agent CLIs (`backend/src/agents.js`): Claude Code, OpenCode,
Codex and DeepCode, all baked into the image at build time (see the Dockerfile) since accounts are
real non-root Linux users with no write access to install one themselves mid-session. Whether one
actually made it into a given build is checked live, not assumed -- `/api/agents` runs `command -v`
against the container's own PATH, the same PATH every account's shell inherits (see pty.js), so the
New Project screen only ever claims a tool is available if it genuinely is.

Every project picks one agent at creation, recorded in that project's own `.codez/config.json`
(`backend/src/projectConfig.js`). Above the terminal, a thin **guided-mode bar** (`AgentBar.jsx`)
shows buttons for that agent's own real commands -- login, resume, start -- each one just typing
that exact string into the live PTY, the same as typing it yourself. **Legend mode** turns the bar
off and hands back exactly the plain terminal Codez always had; nothing about the terminal itself
changes either way, and it's one click to switch back.

Opening an existing project whose agent is Claude Code checks for a real prior transcript
(`~/.claude/projects/<sanitized-path>/`, Claude Code's own on-disk convention) and offers **Resume**
only when one genuinely exists.

## MCP servers, skills, and knowledge transfer between projects

- **MCP servers** (`backend/src/mcp.js`): the Tools panel writes a project's real `.mcp.json` --
  Claude Code's own documented project-scoped MCP config format, read automatically the moment
  `claude` starts there. Codez never runs or proxies an MCP server itself, only the same file you'd
  otherwise hand-edit.
- **Skills** (`backend/src/skills.js`): real `SKILL.md` files, personal (`~/.claude/skills/`,
  applies to every project this account opens) or project-scoped (`<project>/.claude/skills/`).
- **Lessons** (`backend/src/lessons.js`): an account-wide library for carrying something learned in
  one project into another -- write or paste one, then either **inject** it into a project's own
  `CLAUDE.md` (Claude Code reads that automatically at startup, another real, existing mechanism)
  or **promote** it straight into a proper skill. Nothing here is read automatically out of a
  session's transcript -- you write the lesson, Codez just gives it two real, useful places to land.
- **Templates** (`backend/src/templates.js`): a few small built-in starters (blank, Node+Express,
  Python+FastAPI), plus "save this project as a template" for your own -- a real recursive file
  copy, no templating-language substitution.

## Real token usage, not a guess

The HUD in the bottom-right corner sums real numbers, not an estimate scraped from terminal output:
Claude Code writes its own transcript for every session as JSONL, with the actual `usage` object
the API returned on every assistant message (`backend/src/tokenUsage.js` reads exactly that, the
same accounting Claude Code's own `/cost` uses). OpenCode, Codex and DeepCode aren't wired up yet --
their own local storage formats weren't verified live in this build, and a guessed number would be
worse than the HUD honestly saying "not tracked yet" for those.

## Signing in to Claude Code itself

Two ways, same as running Claude Code anywhere else, set per account from the Settings page:

1. **Interactive login**: open a project's terminal, run `claude`, and follow its own sign-in flow
   (a Claude subscription). Credentials persist at that account's own `$HOME/.claude`.
2. **API key, or another provider entirely**: Settings lets an account set an API key (Anthropic
   or otherwise) or point at a whole different Anthropic-API-compatible endpoint (DeepSeek, Kimi),
   stored encrypted, injected into that account's terminals automatically.

## What v1 deliberately leaves out

- File **editing** through the web UI -- the file browser is read-only; editing happens through
  whatever you run in the terminal (Claude Code included). Real scope, not a missing feature by
  accident.
- Auto-detecting a running dev server's port for Preview -- you tell it the port once instead.
- Resuming a terminal session across a page reload beyond the current tab's short reconnect grace
  period (60s) -- reloading the page currently starts a fresh shell in that project.
- Full OS/kernel-level isolation between accounts (separate containers or VMs per account) --
  what's actually implemented is real Linux-user/file-permission isolation within one shared
  container (see "How it's built" above), which stops one account from reading another's files but
  does not sandbox against a container/kernel escape or isolate CPU/memory per account.
