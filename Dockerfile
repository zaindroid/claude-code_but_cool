# Build the frontend first (its own node_modules, discarded after)
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Runtime image: node-pty needs real build tools (python3, make, g++) to compile against this
# image's own Node ABI -- there is no getting around that the way there is for pure-JS deps.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git curl \
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
# claude login's own credentials, and everything else a shell in $HOME would otherwise write to
# the container's throwaway filesystem, live under the same persisted volume as projects do --
# without this, signing in to Claude Code would not survive a restart.
ENV HOME=/data/home
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "src/server.js"]
