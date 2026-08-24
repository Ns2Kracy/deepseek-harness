# Agent Note: ZimaOS RAW distribution

Status: implemented

English | [中文](2026-08-20-zimaos-raw-distribution.zh.md)

## Problem

DeepSeek Harness had no installable ZimaOS system extension. A ZimaOS RAW image must provide systemd and CasaOS metadata plus an executable runtime entirely below `/usr`, while mutable state must remain outside the read-only extension mount.

The Web profile requires Node.js 24, its production dependency closure, built host bundles, and browser assets. Depending on a device-provided Node.js or installing npm packages on the device would make installation network-dependent and could run an untested version. Copying selected monorepo directories would leave workspace links and dynamic assets outside the artifact.

The CasaOS module host and `dsh web` do not share an origin. The browser client uses same-origin HTTP and WebSocket paths under `/api`, so a static copy of the Web dist under `/usr/share/casaos/www/modules` would connect to the wrong server without a Gateway route.

## Decision

The repository assembles a Linux amd64 SquashFS image named `deepseek_harness.raw`. The package identity is `deepseek_harness`; the service is `deepseek-harness.service`; the official CLI entry is `/usr/bin/dsh`; and the immutable application root is `/usr/lib/deepseek-harness`. The source skeleton under `zimaos/raw/usr` owns the systemd unit, extension-release metadata, CasaOS module metadata, launcher page, icon, and ZimaOS-only Cordis overlay.

The image bundles Node.js `v24.19.0` for Linux x64. `scripts/build-zimaos-raw.ts` downloads the archive and official `SHASUMS256.txt`, verifies the exact archive digest, and caches only the digest-keyed verified archive. `zimaos/runtime/package.json` owns the Web production closure independently from the Python SDK runtime and explicitly installs the required workspace peer providers omitted by pnpm when automatic peer installation is disabled. The shared runtime-closure verifier walks app, package, and vendored manifests and rejects any required peer absent from the complete ZimaOS dependency graph. The assembler uses pnpm legacy deploy with the repository lockfile and the package-specific `allowBuilds` review in `pnpm-workspace.yaml`; build subprocesses remove credential-bearing environment variables. It materializes links, adds the vendored `cosmokit` and `schemastery` runtime packages omitted by deploy, removes development dependency metadata, and atomically rewrites remaining workspace ranges so pnpm hardlinks cannot modify source manifests. Static validation rejects application symlinks, required production dependencies absent from the staged closure, remaining `workspace:` ranges, missing dynamic assets, and native artifacts whose ELF machine is not Linux x64. The Landlock package verifier also rejects placeholders and undeclared binaries.

The RAW exposes `/usr/bin/dsh` as a transparent wrapper around the bundled Node.js and official CLI, so interactive commands use the normal entry, including `dsh web`. The systemd service sets `HOME=/media/ZimaOS-HD`, reads the optional `/media/ZimaOS-HD/.dsh/.env`, and runs `dsh web` with only the ZimaOS overlay and `--no-open`. `ProtectSystem=full` keeps `/usr`, `/boot`, and `/etc` read-only while leaving ZimaOS data mounts such as `/media` writable; `PrivateTmp=true` provides isolated temporary storage. The assembler points the same wrapper at its staged root through `DSH_ZIMAOS_STAGED_ROOT` for Linux CI probes. The overlay restates the complete `webserver` row to select `host: 0.0.0.0`, restates the complete connection row to preserve `webRuntime.trustedHosts` while enabling explicit `allowRemoteManagement`, and restates the complete `web-runtime` row to append optional `DSH_ZIMAOS_TRUSTED_HOST`; the public CLI continues to reject `--host 0.0.0.0`.

The service does not register a CasaOS Gateway route or depend on the CasaOS message bus. The CasaOS module provides a no-cache launcher page that preserves the current hostname and navigates to `http://<host>:3080/`. The complete frontend remains served by `dsh web`, preserving same-origin `/api` requests and WebSocket upgrades. The connection Host injects the matching management capability into its boot HTML, so remote Client settings scopes use Host storage instead of the unavailable memory mode. Before any Client plugin activates, the Web boot entry supplies UUID v4 generation through `crypto.getRandomValues()` when an HTTP LAN origin does not expose `crypto.randomUUID()`.

The assembler validates identity and required paths, runs the staged CLI under bundled Node.js, and on Linux x64 starts the staged launcher, probes the Web shell and `/api/host.describe`, calls `settings.describe` through an authority configured by `DSH_ZIMAOS_TRUSTED_HOST`, rejects the same management request through an untrusted Host authority, and requires bounded shutdown. It normalizes staged inode times to `SOURCE_DATE_EPOCH` or the source commit timestamp and creates SquashFS with fixed creation time, root ownership, `-noappend`, and `-no-xattrs`. It inspects mandatory image paths when `unsquashfs` is available and writes a SHA-256 file beside the image. Build output stays under ignored build locations. GitHub Actions keeps the verified build artifact for job handoff, publishes successful same-repository PR (Pull Request) builds as direct assets on the rolling `zimaos-raw-preview` prerelease, and advances the non-prerelease `latest` Release only from the newest successful `dsh-v*` tag. Fork pull requests cannot obtain the repository write permission required to replace preview assets.

## Alternatives considered

**Register `/api` through CasaOS Gateway.** Rejected because this distribution intentionally uses a direct LAN listener and does not add a CasaOS management-plane integration. Gateway-backed authentication is the reintroduction condition if the package must be safe on an untrusted LAN.

**Serve the complete frontend from the CasaOS module directory.** Rejected because the client resolves `/api` and WebSockets against the page origin. Without Gateway registration or a new cross-origin transport configuration, the static copy cannot reach `dsh web` correctly.

**Use the device's Node.js or install npm dependencies during installation.** Rejected because ZimaOS does not promise the tested Node.js version or network availability, and a read-only RAW package must already contain its executable runtime.

**Compile a single Node.js SEA executable.** Rejected because dynamic package loading, native dependencies, profile configuration, and browser assets still require a staged file tree. SEA would add bespoke bundling logic without removing the runtime closure that must be verified.

**Publish amd64 and arm64 images together.** Deferred because the selected first target is amd64. The filename and release automation can gain an architecture suffix and matrix when an arm64 device becomes a supported verification target.

## Consequences

The artifact is self-contained and its application tree is independent of the build checkout after assembly. Focused tests pin package identity, missing paths, symlink rejection, hardlink-safe manifest rewriting, unresolved production dependency rejection, launcher composition, direct-port behavior, and shared deploy behavior. A keyless assembled-client snapshot keeps a non-loopback page without the Host capability unavailable, then verifies that the same page with the capability opens the Host-backed Models settings. The Linux runtime probe requires a successful `settings.describe` RPC with the expected response id and descriptor fields; an HTTP 2xx business error does not pass. Static assembly fails before packaging when the checked-in Linux launcher is still a non-ELF placeholder; Linux x64 must build and verify that launcher before creating the image. Deploy probes leave source package manifests byte-identical. Linux x64 remains authoritative for the bundled native artifacts and Web startup probes.

Binding `0.0.0.0:3080` exposes the Harness UI and its shell, filesystem, settings, credential, and agent capabilities directly to the reachable network. This package adds no CasaOS authentication layer; operators must use a trusted network, firewall, or authenticated reverse proxy.

The bundled Node.js and native dependency tree increase image size and may depend on the ZimaOS glibc and kernel baseline. CI startup can validate Linux amd64 behavior but cannot replace installation on a real ZimaOS device. Mod Store publication and real-device acceptance remain separate follow-up work; the local assembler does not claim those surfaces exist.

The RAW mount is read-only. Any plugin or dependency that writes beside its installed files will fail; mutable state belongs under `/media`, with `/media/ZimaOS-HD/.dsh` as the default Harness home.
