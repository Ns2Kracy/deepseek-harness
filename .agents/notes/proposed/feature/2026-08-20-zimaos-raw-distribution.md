# Agent Note: ZimaOS RAW distribution

Status: proposed

English | [中文](2026-08-20-zimaos-raw-distribution.zh.md)

## Problem

DeepSeek Harness has no installable ZimaOS system extension. A ZimaOS RAW image must provide a systemd unit, system-extension metadata, CasaOS module metadata, and an executable runtime entirely below `/usr`, while all mutable state must live outside the read-only extension mount.

The Web profile requires Node.js 24, its production dependency closure, built host bundles, and built browser assets. Depending on a ZimaOS-provided Node.js or installing npm packages on the device would make installation network-dependent and could run a version that the repository does not test. Copying the monorepo or selected `lib/` directories would also leave workspace links and dynamic assets outside the artifact.

The CasaOS module host and `dsh web` do not share an origin. The browser client uses same-origin HTTP and WebSocket paths under `/api`, so placing the complete Web dist under `/usr/share/casaos/www/modules` without a Gateway route would connect it to the wrong server. This distribution deliberately avoids CasaOS Gateway registration and instead opens the Web profile on a fixed LAN port.

## Proposal

The repository ships one Linux amd64 RAW image named `deepseek_harness.raw`. The package identity is `deepseek_harness`; the service is `deepseek-harness.service`; the executable is `/usr/bin/deepseek-harness`; and the immutable application root is `/usr/lib/deepseek-harness`. Static checks reject inconsistent spellings across the extension-release file, module JSON, service declaration, launcher, and output filename.

The image carries an exact Node.js 24 Linux x64 release selected in version-controlled build configuration and verified against Node.js's published SHA-256 list. The application tree is a materialized production dependency closure from the completely built workspace. It contains no workspace symlinks and runs under plain bundled Node.js without tsx, source paths, the caller's `node_modules`, or files outside the staged root.

The systemd service sets `DSH_HOME=/var/lib/casaos/deepseek_harness`, reads the optional `/var/lib/casaos/deepseek_harness/.env`, and restarts the process after failure. The launcher creates the writable state directory, then executes the staged CLI as `dsh --profile web --host 0.0.0.0 --port 3080 --no-open`. It does not register a CasaOS Gateway route or depend on the CasaOS message bus.

The CasaOS module directory contains an icon and a small no-cache launcher page. The page derives the current ZimaOS hostname and navigates the new tab to `http://<host>:3080/`. The complete DeepSeek Harness frontend remains owned and served by `dsh web`, preserving same-origin `/api` requests and WebSocket upgrades.

A repository script assembles the RAW image in a temporary root. It builds official production artifacts, materializes the runtime closure, downloads and verifies Node.js, copies the source-controlled RAW skeleton, validates JSON and required paths, runs the staged CLI under bundled Node.js, starts the staged Web profile on Linux, probes the HTML and `/api` paths, and then invokes `mksquashfs` with `-noappend -no-xattrs`. Build output is never committed.

GitHub Actions runs the assembly and probes for pull requests and ordinary `master` pushes, uploading `deepseek_harness.raw` as a workflow artifact. A `dsh-v*` tag additionally moves the lightweight `latest` tag to the built commit and creates or updates the `latest` GitHub Release. That release is neither draft nor prerelease and replaces the existing RAW asset with the bytes that passed the same workflow's probes.

## Alternatives considered

**Register `/api` through CasaOS Gateway.** Rejected because this distribution intentionally uses a direct LAN listener and does not add a CasaOS management-plane integration. The module launcher opens the backend-served frontend instead.

**Serve the complete frontend from the CasaOS module directory.** Rejected because the existing client resolves `/api` and its WebSockets against the page origin. Without Gateway registration or a new cross-origin transport configuration, the static copy cannot reach `dsh web` correctly.

**Use the device's Node.js or install npm dependencies during installation.** Rejected because ZimaOS does not promise the tested Node.js version or network availability, and a read-only RAW package must already contain its executable runtime.

**Compile a single Node.js SEA executable.** Rejected because dynamic package loading, native dependencies, profile configuration, and browser assets still require a staged file tree. SEA would add bespoke bundling logic without removing the runtime closure that must be verified.

**Publish amd64 and arm64 images together.** Rejected for the first release because the selected ZimaOS target is amd64. The filenames and workflow can gain an architecture suffix and matrix when an arm64 device becomes a supported verification target.

## Acceptance criteria

- `deepseek_harness.raw` contains `ID=_any`, the module manifest, launcher, systemd service, icon, launcher page, bundled Node.js, and a materialized production application tree at the approved paths.
- The assembled launcher uses only files inside the RAW image plus `/var/lib/casaos/deepseek_harness`, and a clean Linux amd64 probe starts `dsh web` on `0.0.0.0:3080` without a system Node.js installation.
- The CasaOS launcher page preserves the current hostname and opens the backend-served frontend on port 3080; no build or runtime step registers a CasaOS Gateway route.
- The assembly rejects an invalid checksum, missing dynamic runtime file, remaining workspace symlink, inconsistent package identity, malformed module JSON, missing systemd target, or failed Web/API probe.
- Pull requests build and verify the image without publishing it. A `dsh-v*` tag updates a public, non-draft, non-prerelease `latest` Release and replaces only its `deepseek_harness.raw` asset.
- Contributor documentation states the local build command, ZimaOS installation command with an absolute path, service checks, writable-state location, direct-port security posture, and Mod Store entry fields.

## Risks

Binding `0.0.0.0:3080` exposes the Harness UI and its shell, filesystem, credential, and agent capabilities directly to the reachable network. This proposal adds no CasaOS authentication layer; operators must treat the network as trusted or provide an external firewall or authenticated reverse proxy. Gateway-backed authentication is the reintroduction condition if the package must be safe on an untrusted LAN.

The bundled Node.js and native dependency tree increase image size and may depend on the ZimaOS glibc and kernel baseline. CI can prove Linux amd64 assembly and startup but cannot substitute for installation on a real ZimaOS device; release verification therefore includes the documented `zpkg install`, `systemctl`, HTTP, and log probes.

The rolling `latest` Release favors Mod Store discovery over immutable release URLs. Versioned source tags remain the audit trail, while consumers that need reproducible bytes must record the asset checksum from the selected workflow run.

The RAW mount is read-only. Any plugin or dependency that writes beside its installed files will fail even though session and settings state use `DSH_HOME`; the staged runtime probe must exercise startup from a read-only application tree, and later write-path failures require moving that state under `/var/lib/casaos/deepseek_harness` rather than weakening the extension layout.
