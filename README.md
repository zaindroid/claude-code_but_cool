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
(`backend/src/projectConfig.js`). Every agent-facing button in the UI works the same way: it types
that tool's own real command into the live PTY, exactly as if you'd typed it. Codez implements auth
for none of them and wires no flags behind your back, so there is nothing here to keep in sync with
a CLI that changes.

The guided-mode bar and its legend-mode toggle are gone. The whole interface is now the plain
terminal plus a command palette, so there is no mode to switch out of.

## The crew: named agent sessions

A **session** is one named agent with a face. Add one, give it a name, and you get a real Claude
Code session that persists: its shell keeps running when you close the tab, a second browser or
device can attach to the same live terminal, and the name is how you reach it.

The name is doing real work, not decoration:

- It is the **address**. Every session of one account runs inside the same container, so as far as
  Claude Code is concerned they are peer sessions on one machine — which means `ListAgents` and
  `SendMessage` already work between them, with no messaging layer invented here. Two agents in the
  same account can talk to each other by name.
- It is the **seed for the face**. Faces are generated with [blobatar](https://blobatar.dev)
  (MIT, deterministic), so a face is derived from the same string you address the agent by, and
  everyone looking at the same crew sees identical faces with nothing synced.
- It must be **unique across the account**, not just the project. This is forced rather than
  chosen: `--name` is machine-wide, so two projects each with a `scout` would make `ListAgents`
  ambiguous and silently break the messaging that naming them is for.

A face shows what its agent is actually doing. "Working" is driven by real output arriving from
that session's PTY, not by a timer — so a face is busy only when its agent genuinely just said
something.

One limit worth knowing: a named session survives a page reload, a dropped connection and a closed
laptop, but **not a redeploy of Codez itself**. The shell is a process inside the container, so
deploying a new version kills every running shell. The conversation is untouched — transcripts
live on the persistent volume — so every session can be picked straight back up with Wake, which
resumes rather than restarts.

Codez generates the session uuid itself and passes `--session-id`, which is what makes everything
else exact: the transcript lands at a path Codez can predict rather than discover, so resuming is
`claude --resume <uuid>` and forking is `--fork-session`, both Claude Code's own flags.

## Teleport: move a session between machines

A session running on your laptop can be moved onto the server and keep going with the laptop
switched off, then moved back. On the machine you're moving it from:

```
node cli/codez.mjs login https://your-codez-host   # once, with a token from the Teleport panel
node cli/codez.mjs detect                          # what it found, without sending anything
node cli/codez.mjs up                              # send it
node cli/codez.mjs down scout                      # bring it back later
```

There's a bundled Claude Code plugin in `plugin/` so `/teleport` works from inside a session.

**What moves:** the transcript (Claude Code's own JSONL — this *is* the conversation), the
workspace, and the identity (same uuid, same name).

**What doesn't:** credentials. A teleported session runs on the provider settings of the account it
lands in, which is exactly what lets it work with the origin machine off, and means a machine's own
API key never travels.

**Why sync is safe.** A transcript is append-only, so whichever side is behind simply receives the
lines it lacks. Sides are compared by hashing their common prefix, byte for byte — so a longer file
whose prefix differs is *not* treated as merely "ahead". If both sides genuinely advanced, teleport
stops and says so instead of picking a winner, and you can continue one of them as a fork with both
histories intact.

**Workspaces move as git bundles**, so what arrives is a real fetch with real history that can be
really merged. They land on `refs/teleport/*` and your branch is never moved for you unless a
fast-forward is provably safe. A project that isn't a git repo gets `git init` and one commit on
first teleport — stated plainly because it's a real change to your files, and the alternative was a
tarball, which can only overwrite.

**Not via GitHub**, despite git being the mechanism. This deployment is reachable only inside a
private network, and routing transcripts — which carry whatever got pasted into a session — through
a third party would leave that boundary for nothing in return. Codez's own API is the transport.
GitHub still works fine as an ordinary extra remote if you want one.

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

The number in the status line is real, not an estimate scraped from terminal output:
Claude Code writes its own transcript for every session as JSONL, with the actual `usage` object
the API returned on every assistant message (`backend/src/tokenUsage.js` reads exactly that, the
same accounting Claude Code's own `/cost` uses). OpenCode, Codex and DeepCode aren't wired up yet --
their own local storage formats weren't verified live in this build, and a guessed number would be
worse than honestly saying "not tracked" for those.

It used to float in a HUD in the corner. It now sits in the status line, partly because a number
this quiet doesn't need to hover over the screen, and partly because that HUD was one of the
elements a layout-shift probe repeatedly named while chasing a flicker bug (`KNOWN_ISSUES.md`).

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
- Token usage for OpenCode, Codex and DeepCode (shown as "not tracked" rather than guessed).
- Any merge assistance for a diverged teleport. Codez tells you it diverged, keeps both histories
  and offers a fork; actually reconciling two conversations is left to you, because there is no
  correct automatic answer and pretending otherwise would lose work.
- Full OS/kernel-level isolation between accounts (separate containers or VMs per account) --
  what's actually implemented is real Linux-user/file-permission isolation within one shared
  container (see "How it's built" above), which stops one account from reading another's files but
  does not sandbox against a container/kernel escape or isolate CPU/memory per account.
