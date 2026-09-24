// Real token usage for the HUD, not an estimate from watching terminal output. Claude Code writes
// a real transcript of every session as JSONL under its own, documented location --
// `<home>/.claude/projects/<sanitized-project-path>/<session-id>.jsonl` -- and each assistant
// message line carries the actual `usage` object the API returned (input/output/cache tokens).
// Reading that is the same real accounting Claude Code's own `/cost` command uses, just summed
// across every session a project has ever had rather than only the current one.
//
// The other three agents (OpenCode, Codex, DeepCode) are not wired up here yet -- their own local
// storage formats weren't verified live in this session, and a guessed parser would silently show
// a wrong number, which is worse than honestly showing "not tracked yet". See getUsageForProject.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizedClaudeSessionDir } from './agents.js';

// Anthropic's per-million-token list prices, current as of this file's writing -- used only to
// turn a real token count into a rough dollar figure, labeled "estimated" everywhere it's shown.
// A custom/DeepSeek/Kimi provider (see settings.js) bills differently; this is a Claude-pricing
// estimate regardless of which provider actually served the tokens.
const PRICE_PER_M = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
};

function sumClaudeUsage(dir) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  if (!fs.existsSync(dir)) return totals;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    let lines;
    try {
      lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = entry?.message?.usage;
      if (!usage) continue;
      totals.inputTokens += usage.input_tokens || 0;
      totals.outputTokens += usage.output_tokens || 0;
      totals.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
      totals.cacheReadTokens += usage.cache_read_input_tokens || 0;
    }
  }
  return totals;
}

function estimateCost(t) {
  return (
    (t.inputTokens / 1e6) * PRICE_PER_M.input +
    (t.outputTokens / 1e6) * PRICE_PER_M.output +
    (t.cacheCreationTokens / 1e6) * PRICE_PER_M.cacheWrite +
    (t.cacheReadTokens / 1e6) * PRICE_PER_M.cacheRead
  );
}

// projects: [{name, dir, agent}]
export function getUsageForProjects(user, projects) {
  return projects.map(({ name, dir, agent }) => {
    if (agent !== 'claude') {
      return { project: name, agent, tracked: false };
    }
    const totals = sumClaudeUsage(sanitizedClaudeSessionDir(user.homeDir, dir));
    const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
    return {
      project: name,
      agent,
      tracked: true,
      ...totals,
      totalTokens,
      estimatedCostUsd: Math.round(estimateCost(totals) * 10000) / 10000,
    };
  });
}
