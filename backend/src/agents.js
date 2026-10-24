// The registry of coding-agent CLIs Codez knows how to drive. Every one of them is still just a
// real CLI run in a real shell (see pty.js) -- nothing here reimplements an agent's own logic.
// What this file adds is metadata: what to check to know it's installed, how to install it, and
// which of its own real commands ("guided mode" buttons, see AgentBar.jsx) map to logging in,
// resuming a session, and so on. Every command listed here is the tool's own documented command,
// not something invented for Codez.
//
// "legend mode" needs none of this -- it's just the plain terminal Codez always had. This file
// only powers the optional layer on top of it.
export const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    checkCmd: 'claude --version',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    // Already installed in the Codez image itself (see Dockerfile) -- every account has it
    // without needing to install anything.
    preinstalled: true,
    launch: (opts = {}) => (opts.resume ? 'claude --resume' : opts.continue ? 'claude --continue' : 'claude'),
    loginCmd: 'claude',
    loginHint: 'Opens Claude Code’s own interactive login inside the terminal (a Claude subscription), or reads the API key set in Settings.',
    resumeCmd: 'claude --resume',
    continueCmd: 'claude --continue',
    // Claude Code's own transcript format -- see tokenUsage.js, this is what makes real token
    // tracking for this agent possible without parsing terminal output.
    sessionGlob: (homeDir, projectDir) => sanitizedClaudeSessionDir(homeDir, projectDir),
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    checkCmd: 'opencode --version',
    installCmd: 'curl -fsSL https://opencode.ai/v2/install | bash',
    preinstalled: false,
    launch: (opts = {}) => (opts.resume ? 'opencode --continue' : 'opencode'),
    loginCmd: 'opencode auth login',
    loginHint: 'OpenCode’s own auth command — lets you pick a provider and paste a key, or run its own browser login where the provider supports it.',
    resumeCmd: 'opencode --continue',
    continueCmd: 'opencode --continue',
    sessionListCmd: 'opencode session list',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    checkCmd: 'codex --version',
    installCmd: 'npm install -g @openai/codex',
    preinstalled: false,
    launch: () => 'codex',
    loginCmd: 'codex',
    loginHint: 'Codex prompts to “Sign in with ChatGPT” the first time it runs, or reads an API key if one’s configured — same flow as running it locally.',
    resumeCmd: null, // Not yet confirmed live -- see README note; omitted rather than guessed.
    continueCmd: null,
  },
  deepcode: {
    id: 'deepcode',
    label: 'DeepCode',
    bin: 'deepcode',
    checkCmd: 'deepcode --version',
    installCmd: 'pip install deepcode-hku',
    preinstalled: false,
    // Plainly. An earlier version prefixed this with `deepcode init`, on the strength of
    // DeepCode's own "not configured" message telling you to run it -- but in this container that
    // command fails: init copies an existing config and the pip package ships no
    // `deepcode_config.json.example` to copy from. Codez writes the config itself now, from the
    // account's settings, which is also the only way the provider key gets in. See deepcode.js.
    launch: () => 'deepcode',
    // No login command, because there is none. This said `deepcode provider set` for a long
    // time, and the palette offered it as "Sign in to deepcode" -- run live, DeepCode answers
    // `Unknown option: provider`. Its key goes in a config file, which Codez now writes from the
    // account's settings (deepcode.js), so the real path is the settings page, not a command.
    loginCmd: null,
    loginHint: 'DeepCode has no account login and no sign-in command. Set its provider and API key in Codez’s own provider settings — Codez writes DeepCode’s config file from them.',
    resumeCmd: null, // DeepCode's resume is an in-session `/resume`, not a launch flag.
    continueCmd: null,
    inSessionResumeHint: 'Type /resume once inside a DeepCode session to pick up an earlier one.',
  },
};

// `preinstalled` in AGENTS above is only what the Dockerfile *attempts* -- OpenCode's and
// DeepCode's own installers are allowed to fail there without failing the whole build (see the
// Dockerfile's own comment), so whether a given account's terminal can actually run one is a
// live fact, not something safe to hardcode. Checked with `which`, against this same container's
// PATH every account's shell inherits (see pty.js) -- if it's not found here, it won't be found
// there either.
import { execFileSync } from 'node:child_process';

// `command -v` rather than the external `which` binary -- a plain Debian-slim base image (this
// container's own) isn't guaranteed to have `which` installed, but `command` is a POSIX shell
// builtin every /bin/sh has.
// Exported because teleport.js needs the same check for a different question: an arriving
// session's `.mcp.json` can name a command that existed on the origin machine and does not exist
// in this container, and saying so at arrival is much kinder than letting it surface later as an
// agent inexplicably failing a tool call.
export function isOnPath(bin) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function listAgents() {
  return Object.values(AGENTS).map(({ id, label, bin, loginHint, inSessionResumeHint }) => ({
    id,
    label,
    bin,
    available: isOnPath(bin),
    loginHint,
    inSessionResumeHint: inSessionResumeHint || null,
  }));
}

export function getAgent(id) {
  return AGENTS[id] || null;
}

// Claude Code stores one transcript directory per project *absolute path* under its own real,
// documented location (~/.claude/projects/<sanitized>/) -- not something Codez invents. Reused
// here so tokenUsage.js and teleport.js can find the right directory without duplicating this.
//
// The sanitizing rule collapses EVERY non-alphanumeric character to a single dash, not just the
// path separators -- verified 2026-10-22 against all 33 real transcript directories on a live
// machine: `C:\Users\zain_` lands at `C--Users-zain-`, i.e. the colon and the trailing underscore
// both became dashes, and no slug held any character outside [A-Za-z0-9-]. Replacing only the
// separators (as this did until now) was wrong for every project whose name contains `_` or `.`
// -- both of which projects.js's own NAME_RE explicitly allows -- and silently pointed the token
// HUD and the has-a-prior-session check at a directory Claude Code never writes to. Anything that
// has to *write* a transcript for `claude --resume` to then find depends on this being exact.
export function sanitizedClaudeSessionDir(homeDir, projectDir) {
  const sanitized = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  return `${homeDir}/.claude/projects/${sanitized}`;
}
