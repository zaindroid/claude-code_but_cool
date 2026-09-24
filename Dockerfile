# Build the frontend first (its own node_modules, discarded after)
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Runtime image: node-pty needs real build tools (python3, make, g++) to compile against this
# image's own Node ABI -- there is no getting around that the way there is for pure-JS deps.
# `passwd` provides useradd/id -- see backend/src/osUsers.js, the real per-account isolation:
# each Codez user gets an actual Linux system user, not just an app-level ownership check.
# python3-pip is for DeepCode below, not node-pty (which only needs the bare python3 interpreter).
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv make g++ git curl passwd \
    && rm -rf /var/lib/apt/lists/*

# The four coding-agent CLIs Codez's terminal can run (see backend/src/agents.js) -- installed
# here, at build time, as root, because accounts themselves are real non-root Linux users (see
# osUsers.js) with no write access to a global npm/pip prefix: `npm install -g` from inside an
# account's own terminal would just fail with EACCES. Claude Code is the one this app has actually
# run end to end -- its own install line is the only one allowed to fail the whole build. The other
# three are each on their own line with a non-fatal fallback (|| echo ...), so a broken installer
# for one of them can't take Claude Code down with it. `/api/agents` checks which of these actually
# landed with a live `command -v` at request time (see agents.js's isOnPath) -- the frontend never
# just trusts that this section worked.
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex || echo "codex install failed -- will show as unavailable"
RUN (curl -fsSL https://opencode.ai/v2/install | bash) || echo "opencode install failed -- will show as unavailable"
RUN pip install --break-system-packages --no-cache-dir deepcode-hku || echo "deepcode install failed -- will show as unavailable"
ENV PATH="/root/.opencode/bin:${PATH}"

WORKDIR /app
COPY backend/package.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY --from=frontend-build /app/backend/public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

# Deliberately no USER directive: the main process has to run as root to create Linux system
# users and spawn each PTY as that user's own uid/gid (osUsers.js, pty.js) -- that per-account
# separation is the actual point, root only ever does the useradd/chown/spawn-as-uid work itself,
# never runs a person's own shell commands as root.
CMD ["node", "src/server.js"]
