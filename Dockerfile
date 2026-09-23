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
# each Forge user gets an actual Linux system user, not just an app-level ownership check.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git curl passwd \
    && rm -rf /var/lib/apt/lists/*

# The real Claude Code CLI -- what actually runs inside Forge's terminal.
RUN npm install -g @anthropic-ai/claude-code

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
