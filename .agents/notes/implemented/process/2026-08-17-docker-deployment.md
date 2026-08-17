# Agent Note: Container deployment through a full-workspace image

Status: implemented

English | [中文](2026-08-17-docker-deployment.zh.md)

## Problem

The harness shipped one deployment path per machine: install Node and pnpm and run `npx @deepseek-ai/dsh web`, or build the repository from source. Servers and CI runners had no container artifact. A container also could not publish the Web surface through a mapped port, because the `web` command rejects the wildcard host flag and the server binds loopback by default (see the [bind note](../feature/2026-07-22-web-bind-address.md)).

## Decision

The repository ships a container build at the root: [Dockerfile](../../../../Dockerfile), [.dockerignore](../../../../.dockerignore), the [compose file](../../../../docker-compose.yml), and the [bind overlay](../../../../docker/docker-web.patch.yml). The [publish workflow](../../../../.github/workflows/docker-publish.yml) builds `linux/amd64` and `linux/arm64` on every `master` push, on version tags, and on manual dispatch, and pushes `ghcr.io/ns2kracy/deepseek-harness` always (built-in GitHub token) and Docker Hub's `ns2kracy/deepseek-harness` only while the fork defines `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets. Tags are `latest` on `master`, the git ref name, the semantic version, and `sha-<commit>`.

The image is the full workspace built in place: `node:24-slim`, a build stage that installs the frozen lockfile and runs the repository build, and a runtime stage that copies the complete tree and adds `git`, `curl`, and `ca-certificates`, plus a global `pnpm@11.7.0` install pinned to the root manifest's `packageManager` (so `dsh plugin` reaches pnpm from any working directory). The entry point is `node /app/apps/cli/lib/bin.js`, the process runs as `node` with `/workspace` as the working directory, and the default command is `web --patch /opt/dsh/docker-web.patch.yml`. The overlay is the deliberate all-interfaces posture the [web-server reference](../../../../docs/subsystems/web-server.md) documents: it replaces the webserver row's `host` with `0.0.0.0` while the port still follows `--port`. The `/api` browser-trust fence keeps accepting loopback `Host`s (the compose default publishes the port on the host loopback only) and declared `--trusted-host` authorities.

## Alternatives considered

**Lean runtime from `pnpm deploy --prod`, mirroring the npm-published closure.** Rejected: a pruned tree diverges from the two supported layouts (a checkout and an npm install) exactly where the boot is most subtle — profile-bundle resolution, the healed `profiles/node_modules` fallback, and by-name plugin imports — and deploy adds its own failure modes for a size saving that matters little at this stage.

**Install the published npm package inside the image.** Rejected: the fork builds its own images from its own source; consuming registry artifacts would pin reproducibility to a publication step and could not carry un-released changes.

**Separate images per surface (web, headless, ACP).** Rejected: one entry point already expresses every mode through appended arguments, and separate images would duplicate build time and tag administration without a distinct consumer need.

## Consequences

- The image is large: the runtime stage carries the complete dependency tree including dev dependencies. The cost buys exact layout parity with a source checkout and a `dsh plugin` that works without provisioning.
- The all-interfaces bind exists only through the shipped overlay, never a flag; a command that overrides the default `web` entry must restate `--patch /opt/dsh/docker-web.patch.yml` to stay reachable through a published port.
- LAN exposure is an explicit compose change (port mapping plus `--trusted-host`); the default posture publishes on the host loopback only.
- Docker Hub publishing is opt-in through fork secrets; GHCR publishing works with the fork's built-in token alone.
- The workflow builds both architectures on every `master` push but not on pull requests, so a broken Dockerfile surfaces only after merge until a PR trigger is added.
