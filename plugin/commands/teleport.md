---
description: Teleport this session to or from Codez (up, down, sync, list)
argument-hint: "[up|down|sync|list] [--name scout] [--project foo]"
allowed-tools: Bash
---

Teleport this coding session between this machine and the Codez server.

Run the Codez CLI with the arguments the user gave. The CLI does all the real work — session
discovery, the git bundle, and the append-only transcript sync. Do not reimplement any of that,
and do not read or move transcript files yourself.

```
node "$CLAUDE_PLUGIN_ROOT/../cli/codez.mjs" $ARGUMENTS
```

If `$ARGUMENTS` is empty, run `sync` — the common case is "make both sides match".

Notes for interpreting the output, so you report it accurately rather than optimistically:

- **Exit code 2 means the session diverged.** Both copies advanced independently. Nothing was
  overwritten and nothing is broken. Report exactly that, show the user the two line counts the
  CLI printed, and offer the fork command it suggested. Do not retry, and do not describe this as
  a failure or a conflict that needs fixing — it is the safe outcome working as designed.
- Lines beginning `!` are warnings that something will not work on the other side (most often an
  MCP server whose command only exists on the origin machine). Pass them through verbatim; they
  are the difference between a session that looks fine and one that actually runs.
- "into refs/teleport/*" is correct and deliberate, not an incomplete transfer. Incoming commits
  are deliberately not merged onto the user's branch unless a fast-forward was provably safe. If
  the CLI suggests `git merge refs/teleport/main`, relay that rather than running it unprompted.
- If it says the machine is not signed in, tell the user to run `codez login <url>` with a token
  from Settings → Machine tokens. Do not try to obtain or guess a token.
