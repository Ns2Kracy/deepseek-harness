# syntax=docker/dockerfile:1

# DeepSeek Harness container: the full workspace built in place, the same layout
# the repository's "run from source" flow produces. Every profile bundle,
# plugin row, and the Web frontend dist resolve exactly as they do in a
# checkout, and `dsh plugin` keeps a working pnpm. The image trades size for
# that parity: the runtime stage carries the complete tree.

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DSH_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:24-slim AS runtime
ENV DSH_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# `dsh plugin` spawns pnpm from PATH. The global install pins the exact
# packageManager version from the root manifest, independent of any cwd.
RUN npm install --global pnpm@11.7.0
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node docker/docker-web.patch.yml /opt/dsh/docker-web.patch.yml
# The working directory is the agent's default filesystem location, so the
# unprivileged user must own it even when no volume is mounted over it.
RUN mkdir -p /workspace /home/node/.dsh && chown -R node:node /workspace /home/node/.dsh
USER node
WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["node", "/app/apps/cli/lib/bin.js"]
CMD ["web", "--patch", "/opt/dsh/docker-web.patch.yml"]
