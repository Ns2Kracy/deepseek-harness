# Deploy with Docker

English | [中文](docker.zh.md)

This guide deploys the DeepSeek Harness Web UI as a container built from the repository source, and covers the published images, persistent data, the CLI entry point, and network exposure. It assumes Docker with the compose plugin, and starts from the [root README's Docker section](../../../README.md#run-in-docker).

## Run the Web UI

From the repository root:

```sh
docker compose up -d
```

Then open `http://127.0.0.1:3080`. Model configuration is the same as in the ordinary [Web UI guide](./index.md): open **Settings → Models**, enter a DeepSeek API key, and save it.

## Persistent data and the workspace

The compose file mounts a named volume at the container's `~/.dsh` (`/home/node/.dsh`). The harness keeps API keys, settings, sessions, and profiles there, so they survive image updates and container replacement.

The project directory is mounted at `/workspace`, where the server starts, so `/workspace` is the agent's default filesystem location. Change the bind source to point the agent at a different directory.

The server reads `.env` from its working directory and from `~/.dsh`, and container environment variables take precedence, so `DEEPSEEK_API_KEY` can be supplied by any of those three routes.

## The image entry point

The image entry point is the `dsh` CLI, and the default command serves the Web UI with the shipped bind overlay. Every CLI mode runs by appending its arguments; a mode that overrides the default command must restate the overlay when it needs the container bind:

```sh
# Headless task
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" docker run --rm -v "$PWD:/workspace" \
  ghcr.io/ns2kracy/deepseek-harness:latest --profile headless "Summarize this repository"

# Web UI on another port
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" docker run --rm -p 127.0.0.1:8080:8080 -v "$PWD:/workspace" \
  ghcr.io/ns2kracy/deepseek-harness:latest web --patch /opt/dsh/docker-web.patch.yml --port 8080
```

`dsh plugin --profile <name> <pnpm args>` also works inside the container; pnpm ships with the image.

## Network exposure

The `web` command deliberately refuses the wildcard host flag: the server carries no TLS or authentication, so an all-interfaces bind is a deliberate deployment posture, not a flag. The container takes that posture through `/opt/dsh/docker-web.patch.yml`, which sets the webserver row to bind `0.0.0.0` while the port still follows `--port` (default 3080). The container network is the exposure boundary.

Two consequences follow from the `/api` browser-trust fence:

- **Host loopback (the compose default).** The mapping `127.0.0.1:3080:3080` publishes the port on the host loopback only, and requests arrive with a loopback `Host`, which the fence accepts without extra flags.
- **LAN exposure.** Change the mapping to `3080:3080` and declare the authorities the browser reaches the server by, for example `--trusted-host harness.internal` or `--trusted-host 192.168.1.5:3080`. A port-less authority is trusted on any port; a `host:port` authority is exact. Requests whose `Host` is neither loopback nor declared are refused with 403.

## Images and tags

The [publish workflow](../../../.github/workflows/docker-publish.yml) builds `linux/amd64` and `linux/arm64` on every push to `master`, on version tags, and on manual dispatch:

- `ghcr.io/ns2kracy/deepseek-harness` — published automatically through the fork's built-in GitHub token.
- `ns2kracy/deepseek-harness` on Docker Hub — published only while the fork defines `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets.

Each push publishes `latest` (on `master`), the git ref name, the semantic version from version tags, and a `sha-<commit>` tag.

To build the image locally instead, run `docker build -t dsh .` from the repository root.
