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
    launch: () => 'deepcode',
    loginCmd: 'deepcode provider set',
    loginHint: 'DeepCode has no account login — it reads a provider API key set with its own `deepcode provider set` command.',
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
function isOnPath(bin) {
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

// Claude Code stores one transcript directory per project *absolute path*, with '/' replaced by
// '-' -- this is Claude Code's own real, documented convention (~/.claude/projects/<sanitized>/),
// not something Codez invents. Reused here so tokenUsage.js can find the right directory for a
// given project without duplicating this logic.
export function sanitizedClaudeSessionDir(homeDir, projectDir) {
  const sanitized = projectDir.replace(/[/\\]/g, '-');
  return `${homeDir}/.claude/projects/${sanitized}`;
}
