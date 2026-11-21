# syntax=docker/dockerfile:1
# shmakk web — chat, terminal and GitHub cloud sessions in one container.
#
#   docker compose up -d --build        (see docker-compose.yml / docs/deploy.md)

# ── 1. front-end ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# vite writes to ../src/webui/public
RUN npm run build

# ── 2. server dependencies (native modules need a toolchain) ─────────────────
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# The optional voice/browser stacks are several GB; leave them out by default.
# better-sqlite3 (session recall) is small and worth having.
ARG WITH_OPTIONAL=0
RUN if [ "$WITH_OPTIONAL" = "1" ]; then \
      npm ci --ignore-scripts --no-audit --no-fund; \
    else \
      npm ci --omit=optional --ignore-scripts --no-audit --no-fund \
      && npm install --no-save --ignore-scripts --no-audit --no-fund better-sqlite3@^11; \
    fi \
 && npm rebuild node-pty better-sqlite3

# ── 3. runtime ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
# What an agent working on real repositories expects to find.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl tini ripgrep jq less procps unzip build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOME=/data \
    SHELL=/bin/bash \
    SHMAKK_WORKSPACES_DIR=/data/workspaces \
    PORT=1029

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY skills ./skills
COPY scripts ./scripts
COPY --from=web /app/src/webui/public ./src/webui/public
COPY docker/entrypoint.sh /usr/local/bin/shmakk-entrypoint
RUN chmod +x /usr/local/bin/shmakk-entrypoint \
 && ln -s /app/bin/shmakk.js /usr/local/bin/shmakk && chmod +x /app/bin/shmakk.js \
 && mkdir -p /data && chown -R node:node /data

# Bake in the model-endpoint config from the repo root when there is one.
# endpoints.json carries API keys, so it stays optional: the build context is
# bind-mounted into a RUN and the file is copied only if present, because a
# plain COPY of a missing file is a hard build error.
RUN --mount=type=bind,source=.,target=/ctx \
      if [ -f /ctx/endpoints.json ]; then \
        mkdir -p /data/.config/shmakk \
        && cp /ctx/endpoints.json /data/.config/shmakk/endpoints.json \
        && chown -R node:node /data/.config; \
      fi

# Unprivileged: the agent runs commands, so it must not be root.
USER node
VOLUME /data
EXPOSE 1029

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["tini", "--", "shmakk-entrypoint"]
