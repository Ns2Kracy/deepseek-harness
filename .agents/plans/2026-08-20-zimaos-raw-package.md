# ZimaOS RAW Package Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce and publish a self-contained Linux amd64 `deepseek_harness.raw` ZimaOS extension that serves `dsh web` directly on port 3080 with bundled Node.js 24 and writable state under `/var/lib/casaos/deepseek_harness`.

**Architecture:** A source-controlled RAW skeleton owns the systemd, CasaOS, launcher-page, icon, and ZimaOS-only Cordis overlay files. A ZimaOS-specific pure dependency manifest defines the Web runtime closure without widening the Python SDK runtime. A TypeScript assembler reuses a shared pnpm-deploy helper to materialize that closure without symlinks, verifies the pinned Node.js archive, stages the extension, performs static and Linux runtime probes, and invokes `mksquashfs`. The public `dsh web` CLI keeps rejecting `--host 0.0.0.0`; only the staged `zimaos.patch.yml` selects the all-interfaces webserver bind.

**Tech Stack:** TypeScript/Node.js 24, pnpm 11 deploy, Vitest, Cordis patch YAML, systemd, CasaOS module JSON, GitHub Actions, SquashFS.

---

### Task 1: Extract the reusable symlink-free pnpm deploy helper

**Files:**

- Create: `scripts/runtime-deploy.ts`
- Create: `scripts/runtime-deploy.spec.ts`
- Modify: `scripts/build-exe-for-python-sdk.ts:17-35`
- Modify: `scripts/build-exe-for-python-sdk.ts:243-357`

**Step 1: Write failing tests for deploy restoration and link materialization**

Add fixture-based tests for an exported `deployRuntimeClosure()` helper. Cover:

```ts
it('restores a direct dependency omitted by legacy deploy', async () => {
  // source node_modules/@example/direct exists; staging does not
  await deployRuntimeClosure(fixtureOptions)
  expect(await readFile(join(staging, 'node_modules/@example/direct/package.json'), 'utf8'))
    .toContain('"name": "@example/direct"')
})

it('materializes package links and removes deploy-time .bin links', async () => {
  await deployRuntimeClosure(fixtureOptions)
  expect(await firstSymlink(join(staging, 'node_modules'))).toBeUndefined()
  expect(existsSync(join(staging, 'node_modules/.bin'))).toBe(false)
})

it('fails when a declared direct dependency exists in neither deploy output nor source', async () => {
  await expect(deployRuntimeClosure(fixtureOptions))
    .rejects.toThrow('deployed dependency @example/missing is absent')
})
```

Use an injected `runDeploy` callback so unit tests create deterministic fixture output without invoking pnpm.

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run scripts/runtime-deploy.spec.ts
```

Expected: FAIL because `scripts/runtime-deploy.ts` and `deployRuntimeClosure()` do not exist.

**Step 3: Implement the shared deploy helper**

Move the existing legacy deploy, direct-dependency restoration, symlink materialization, and missing-dependency checks out of `SingleExeBuild` into `scripts/runtime-deploy.ts`. Export typed options that name:

```ts
export interface RuntimeDeployOptions {
  deployRootPackage: string
  staging: string
  sourceNodeModules: string
  runDeploy: (args: string[]) => Promise<void>
  logPrefix: string
  removeNames?: readonly string[]
  dryRun?: boolean
}

export async function deployRuntimeClosure(options: RuntimeDeployOptions): Promise<void>
```

Keep the exact deploy flags:

```text
deploy --legacy --prod
--config.node-linker=hoisted
--config.auto-install-peers=false
--config.link-workspace-packages=true
```

`build-exe-for-python-sdk.ts` must call the helper and retain its current log prefix, staging path, deploy root, excluded docs, and artifact behavior.

**Step 4: Run the focused tests and existing dry-run probe**

Run:

```bash
pnpm exec vitest run scripts/runtime-deploy.spec.ts scripts/build-exe-for-python-sdk-native-pty.spec.ts
pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-linux-x64 --dry-run
```

Expected: tests PASS; dry run prints one deploy and symlink-materialization path without changing Python runtime files.

**Step 5: Commit**

```bash
git add scripts/runtime-deploy.ts scripts/runtime-deploy.spec.ts scripts/build-exe-for-python-sdk.ts
git commit -m "refactor: share runtime deployment assembly"
```

---

### Task 2: Add the source-controlled ZimaOS RAW skeleton

**Files:**

- Create: `zimaos/raw/usr/bin/deepseek-harness`
- Create: `zimaos/raw/usr/lib/deepseek-harness/zimaos.patch.yml`
- Create: `zimaos/raw/usr/lib/extension-release.d/extension-release.deepseek_harness`
- Create: `zimaos/raw/usr/lib/systemd/system/deepseek-harness.service`
- Create: `zimaos/raw/usr/share/casaos/modules/deepseek_harness.json`
- Create: `zimaos/raw/usr/share/casaos/www/modules/deepseek_harness/index.html`
- Create: `zimaos/raw/usr/share/casaos/www/modules/deepseek_harness/appicon.svg`
- Create: `scripts/zimaos-raw-layout.spec.ts`

**Step 1: Write failing static layout tests**

Parse the JSON and text files and assert:

```ts
expect(extensionRelease.trim()).toBe('ID=_any')
expect(module.name).toBe('deepseek_harness')
expect(module.services).toEqual([{ name: 'deepseek-harness' }])
expect(module.ui.entry).toBe('/modules/deepseek_harness/index.html')
expect(service).toContain('ExecStart=/usr/bin/deepseek-harness')
expect(service).toContain('Environment=DSH_HOME=/var/lib/casaos/deepseek_harness')
expect(service).toContain('EnvironmentFile=-/var/lib/casaos/deepseek_harness/.env')
expect(launcher).toContain('--patch /usr/lib/deepseek-harness/zimaos.patch.yml')
expect(launcher).not.toContain('--host 0.0.0.0')
expect(overlay).toContain('host: 0.0.0.0')
expect(page).toContain('location.hostname')
expect(page).toContain(':3080/')
```

Also assert that the launcher, service, page, overlay, and manifest contain no CasaOS Gateway registration command or route.

**Step 2: Run the test and verify RED**

```bash
pnpm exec vitest run scripts/zimaos-raw-layout.spec.ts
```

Expected: FAIL because `zimaos/raw/` does not exist.

**Step 3: Add the minimal RAW skeleton**

The launcher is POSIX `sh`, creates `/var/lib/casaos/deepseek_harness`, then uses `exec`:

```sh
#!/bin/sh
set -eu
state=/var/lib/casaos/deepseek_harness
install -d -m 0700 "$state"
export DSH_HOME="$state"
exec /usr/lib/deepseek-harness/node/bin/node \
  /usr/lib/deepseek-harness/app/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --patch /usr/lib/deepseek-harness/zimaos.patch.yml \
  --port 3080 --no-open
```

The service orders after `network-online.target`, uses the launcher above, and restarts on failure. Do not add CasaOS Gateway or message-bus dependencies.

The overlay restates the whole `webserver` config because Cordis patch rows replace `config`:

```yaml
- id: webserver
  config:
    host: 0.0.0.0
    port: !!js ctx.webStartup.port ?? 3080
```

The CasaOS page sets no-cache metadata and navigates with `location.replace()` to `http://${location.hostname}:3080/`. Copy and adapt `apps/web/public/favicon.svg` as `appicon.svg`; do not add a binary icon toolchain.

**Step 4: Run static layout tests**

```bash
pnpm exec vitest run scripts/zimaos-raw-layout.spec.ts
```

Expected: PASS.

**Step 5: Verify the public CLI safety invariant**

```bash
pnpm exec vitest run apps/cli/tests/built-bin.e2e.ts -t "rejects wildcard host"
```

Expected: PASS; ordinary `dsh web --host 0.0.0.0` remains rejected.

**Step 6: Commit**

```bash
git add zimaos/raw scripts/zimaos-raw-layout.spec.ts
git commit -m "feat: add ZimaOS raw extension skeleton"
```

---

### Task 3: Implement deterministic RAW assembly

**Files:**

- Create: `scripts/build-zimaos-raw.ts`
- Create: `scripts/build-zimaos-raw.spec.ts`
- Create: `zimaos/runtime/package.json`
- Modify: `pnpm-workspace.yaml:1-21`
- Modify: `pnpm-lock.yaml`
- Modify: `package.json:19-145`
- Modify: `.gitignore:28-35`

**Step 1: Write failing assembler unit tests**

Export pure helpers and test their failure paths before running a large build:

```ts
expect(parseNodeChecksum(sums, 'node-v24.19.0-linux-x64.tar.xz'))
  .toBe('14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647')
expect(() => parseNodeChecksum('', archive)).toThrow('checksum entry missing')
expect(() => assertPackageIdentity(stagedRoot)).toThrow(/inconsistent package identity/)
expect(() => assertNoSymlinks(appRoot)).toThrow(/symbolic link/)
expect(webProbePaths()).toEqual(['/', '/api/host.describe'])
```

Add a fixture where `ExecStart` names a missing staged path and verify assembly validation rejects it.

**Step 2: Run the test and verify RED**

```bash
pnpm exec vitest run scripts/build-zimaos-raw.spec.ts
```

Expected: FAIL because the assembler does not exist.

**Step 3: Implement configuration and CLI parsing**

Pin:

```ts
const NODE_VERSION = 'v24.19.0'
const NODE_ARCHIVE = `node-${NODE_VERSION}-linux-x64.tar.xz`
const MODULE_ID = 'deepseek_harness'
const SERVICE_NAME = 'deepseek-harness'
```

Support:

```text
--out <path>          default: deepseek_harness.raw
--staging <path>      optional retained staging root for debugging
--skip-build          require existing built artifacts
--skip-runtime-probe  unit/local assembly only; CI release never passes it
--dry-run             print commands and paths without mutation
```

Reject non-Linux runtime probes unless `--skip-runtime-probe` is explicit. Assembly itself may run on another host only when it does not execute the Linux runtime.

**Step 4: Implement production build and runtime closure staging**

Run `pnpm run build:official` unless `--skip-build`. Add `zimaos/runtime` as a workspace member and make its zero-code manifest the single owner of this distribution closure:

```json
{
  "name": "dsh-zimaos-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/dsh": "workspace:^"
  }
}
```

Use `deployRuntimeClosure()` with `dsh-zimaos-runtime`, staging into:

```text
<raw-root>/usr/lib/deepseek-harness/app
```

Mechanically require the deployed closure to resolve `@deepseek-ai/dsh`, its base and Web bundle patches, the Web frontend `dist/index.html`, and every runtime package reached by a keyless Web boot. Do not add Web packages to `python/sdk-runtime/package.json`; the Python SDK runtime and ZimaOS Web runtime evolve independently.

**Step 5: Download and verify bundled Node.js**

Download from:

```text
https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz
https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
```

Extract the exact matching digest from the official list, compute the archive SHA-256, reject mismatch, then extract to:

```text
<raw-root>/usr/lib/deepseek-harness/node
```

Use a cache under `.cache/zimaos-raw/` keyed by the exact version and digest. A corrupt cache entry must fail or be replaced only after a fresh verified download; it must never be trusted by filename alone.

**Step 6: Stage the skeleton and validate contents**

Copy `zimaos/raw/usr` into the temporary root and set executable mode on the launcher and bundled Node binary. Validate:

- `ID=_any` exactly.
- Module JSON parses and names `deepseek_harness` / `deepseek-harness` consistently.
- Every module entry/icon path and systemd `ExecStart` exists under the staged root.
- The overlay has `host: 0.0.0.0` and the launcher does not pass wildcard `--host`.
- The app tree contains no symlink and no `workspace:` dependency specifier.
- The CLI, base and Web bundle patches, frontend `dist/index.html`, Linux x64 Landlock launcher, and Linux x64 `node-pty` addon resolve inside the app tree.
- No staged path expects writes below `/usr`.

**Step 7: Add direct behavioral probes**

Before SquashFS creation on Linux:

1. Run bundled Node with the staged CLI and `--version`.
2. Run the launcher against a temporary path mapping or add assembler-owned launcher arguments so it can target the staged `/usr` root without requiring a mount.
3. Set temporary `DSH_HOME`, start `dsh web` with the staged ZimaOS overlay, and wait for port 3080 using condition polling.
4. Request `/` with `Host: 127.0.0.1:3080` and require the injected Web shell.
5. Request `/api/host.describe` with the same Host authority and require a non-5xx application response.
6. Request an untrusted Host authority and require the browser trust fence to reject it.
7. Stop the process and require bounded clean shutdown.

Do not require a DeepSeek API key; startup and host description are keyless.

**Step 8: Create and inspect SquashFS**

Require `mksquashfs` and invoke:

```text
mksquashfs <raw-root> deepseek_harness.raw -noappend -no-xattrs
```

If `unsquashfs` is available, list the image and re-check the mandatory paths. Write `<out>.sha256` beside the image for workflow and operator verification.

**Step 9: Run focused tests and the dry-run interface**

```bash
pnpm exec vitest run scripts/runtime-deploy.spec.ts scripts/zimaos-raw-layout.spec.ts scripts/build-zimaos-raw.spec.ts
pnpm run build:zimaos-raw -- --dry-run
```

Expected: tests PASS; dry run prints the pinned URLs, staging layout, deploy command, probes, and `mksquashfs` command without writing `deepseek_harness.raw`.

**Step 10: Run Linux assembly in a container or Linux host**

```bash
pnpm run build:zimaos-raw
unsquashfs -ll deepseek_harness.raw | grep -E 'deepseek-harness|deepseek_harness|node/bin/node'
sha256sum -c deepseek_harness.raw.sha256
```

Expected: image created, all mandatory paths listed, checksum passes, and the built-in runtime probe has already passed.

**Step 11: Commit**

```bash
git add scripts/build-zimaos-raw.ts scripts/build-zimaos-raw.spec.ts zimaos/runtime/package.json pnpm-workspace.yaml pnpm-lock.yaml package.json .gitignore
git commit -m "feat: assemble self-contained ZimaOS raw image"
```

---

### Task 4: Add the GitHub Actions build and rolling latest Release

**Files:**

- Create: `.github/workflows/zimaos-raw.yml`
- Modify: `scripts/ci-workflow.spec.ts:391-405`

**Step 1: Write failing workflow-structure tests**

Load `.github/workflows/zimaos-raw.yml` and assert:

```ts
expect(workflow.on.pull_request).toBeDefined()
expect(workflow.on.push.branches).toContain('master')
expect(workflow.on.push.tags).toContain('dsh-v*')
expect(job['runs-on']).toBe('ubuntu-24.04')
expect(job.permissions).toEqual({ contents: 'write' })
expect(commands).toContain('pnpm run build:zimaos-raw')
expect(commands).toContain('sha256sum -c deepseek_harness.raw.sha256')
expect(releaseStep.if).toContain("refs/tags/dsh-v")
expect(releaseScript).toContain('git tag -f latest')
expect(releaseScript).toContain('git push origin refs/tags/latest --force')
expect(releaseScript).toContain('gh release upload latest deepseek_harness.raw --clobber')
expect(releaseScript).toContain('--latest')
expect(releaseScript).not.toContain('--prerelease')
expect(releaseScript).not.toContain('--draft')
```

Also require a concurrency group that prevents two tag runs from moving `latest` simultaneously.

**Step 2: Run the workflow test and verify RED**

```bash
pnpm exec vitest run scripts/ci-workflow.spec.ts -t "ZimaOS RAW"
```

Expected: FAIL because the workflow does not exist.

**Step 3: Implement the workflow**

Use:

- `actions/checkout@v5` with full history for tag publication.
- `pnpm/action-setup@v4` with runner-private destination and repository-pinned pnpm.
- `actions/setup-node@v5` with Node 24 and pnpm cache.
- `pnpm install --frozen-lockfile`.
- `sudo apt-get install -y squashfs-tools xz-utils`.
- `pnpm run build:zimaos-raw`.
- `actions/upload-artifact@v6` for the RAW and checksum on every event.

On `dsh-v*` only, use `GITHUB_TOKEN` and `gh` to:

1. Move the lightweight `latest` Git tag to `GITHUB_SHA` with force.
2. Create `latest` Release if absent using `--latest`, or edit it to clear draft/prerelease and mark latest.
3. Upload `deepseek_harness.raw` and `deepseek_harness.raw.sha256` with `--clobber`.
4. Query `gh release view latest --json isDraft,isPrerelease,tagName` and fail unless values are exactly `false`, `false`, and `latest`.

Do not use a third-party release action or a repository secret when the built-in token is sufficient.

**Step 4: Run workflow and YAML checks**

```bash
pnpm exec vitest run scripts/ci-workflow.spec.ts -t "ZimaOS RAW"
pnpm exec tsx scripts/run-oxlint.ts scripts/ci-workflow.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/zimaos-raw.yml scripts/ci-workflow.spec.ts
git commit -m "ci: publish ZimaOS raw latest release"
```

---

### Task 5: Document build, installation, operation, and store submission

**Files:**

- Create: `docs/cookbook/zimaos-raw.md`
- Create: `docs/cookbook/zimaos-raw.zh.md`
- Create: `docs/cookbook/zimaos-raw.i18n.yaml`
- Modify: `docs/cookbook/README.md`
- Modify: `docs/cookbook/README.zh.md`
- Modify: `docs/cookbook/README.i18n.yaml`
- Modify: `.agents/notes/proposed/feature/2026-08-20-zimaos-raw-distribution.md`
- Modify: `.agents/notes/proposed/feature/2026-08-20-zimaos-raw-distribution.zh.md`
- Modify: `.agents/notes/proposed/feature/2026-08-20-zimaos-raw-distribution.i18n.yaml`

**Step 1: Write the English installation tutorial**

Document prerequisites and exact commands:

```bash
pnpm run build:zimaos-raw
scp deepseek_harness.raw root@zimaos:/var/lib/extensions/
ssh root@zimaos 'zpkg install /var/lib/extensions/deepseek_harness.raw'
ssh root@zimaos 'systemctl status deepseek-harness.service --no-pager'
curl http://ZIMAOS_IP:3080/
```

Include:

- `/var/lib/casaos/deepseek_harness/.env` for `DEEPSEEK_API_KEY`, optional provider configuration, and `DSH_ZIMAOS_TRUSTED_HOST` when the UI is opened through a stable DNS alias instead of the device IP.
- `journalctl -u deepseek-harness.service` troubleshooting.
- `zpkg list`, `zpkg remove deepseek_harness`, and `zpkg list-remote`.
- The direct-port warning: port 3080 exposes remote-code-execution capabilities and requires a trusted LAN, firewall, or authenticated reverse proxy.
- Read-only `/usr` and writable `/var/lib/casaos/deepseek_harness` behavior.
- Mod Store JSON:

```json
{
  "name": "deepseek_harness",
  "title": "DeepSeek Harness",
  "repo": "deepseek-ai/deepseek-harness"
}
```

If the publishing fork owns Releases instead, use its actual `owner/repo`; do not document a placeholder as a working store submission.

**Step 2: Add the Chinese counterpart in the same pass**

Mirror heading order, code blocks, lists, links, warnings, and commands exactly. Link the cookbook index to the new tutorial in both languages.

**Step 3: Mark the Agent Note implemented after the code is real**

Move the triplet:

```text
.agents/notes/proposed/feature/2026-08-20-zimaos-raw-distribution.*
→ .agents/notes/implemented/feature/2026-08-20-zimaos-raw-distribution.*
```

Change `Status: proposed` to `Status: implemented`; rename `## Proposal` / `## 提案` to `## Decision` / `## 决定`; fold acceptance criteria and risks into present-tense verification and consequences. Update paths and exact Node version to what shipped, without retaining implementation checklists.

Before moving, use the Agent Note archive skill to confirm no active note is superseded; current search found no ZimaOS/RAW note.

**Step 4: Record and validate both bilingual pairs**

```bash
pnpm run verify-translation-pairing --write docs/cookbook/zimaos-raw.md docs/cookbook/README.md .agents/notes/implemented/feature/2026-08-20-zimaos-raw-distribution.md
pnpm run verify-translation-pairing docs/cookbook/zimaos-raw.md docs/cookbook/README.md .agents/notes/implemented/feature/2026-08-20-zimaos-raw-distribution.md
pnpm run verify-agent-note-format
pnpm run doc-sync
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add docs/cookbook .agents/notes/proposed/feature .agents/notes/implemented/feature
git commit -m "docs: add ZimaOS raw installation guide"
```

---

### Task 6: End-to-end acceptance and outgoing checks

**Files:**

- Verify only; fix the owning files if a check fails.

**Step 1: Run focused unit and workflow tests**

```bash
pnpm exec vitest run \
  scripts/runtime-deploy.spec.ts \
  scripts/zimaos-raw-layout.spec.ts \
  scripts/build-zimaos-raw.spec.ts \
  scripts/ci-workflow.spec.ts
```

Expected: PASS.

**Step 2: Run the public CLI regression test**

```bash
pnpm exec vitest run apps/cli/tests/built-bin.e2e.ts -t "rejects wildcard host"
```

Expected: PASS.

**Step 3: Build and inspect the real Linux amd64 artifact**

Run on Linux or the exact workflow runner:

```bash
pnpm run build:zimaos-raw
sha256sum -c deepseek_harness.raw.sha256
unsquashfs -ll deepseek_harness.raw | grep -E \
  'extension-release.deepseek_harness|deepseek-harness.service|deepseek_harness.json|node/bin/node|@deepseek-ai/dsh/lib/bin.js'
```

Expected: assembler runtime probes PASS, checksum PASS, and every required path is listed.

**Step 4: Run repository checks matched to the diff**

```bash
pnpm run typecheck
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
git diff --check master...HEAD
```

Do not run the complete test suite unless a focused failure or cross-cutting deploy-helper regression requires escalation.

**Step 5: Verify on a real ZimaOS device**

```bash
scp deepseek_harness.raw root@zimaos:/var/lib/extensions/
ssh root@zimaos 'zpkg install /var/lib/extensions/deepseek_harness.raw'
ssh root@zimaos 'systemctl is-active deepseek-harness.service'
ssh root@zimaos 'systemctl status deepseek-harness.service --no-pager'
curl --fail http://ZIMAOS_IP:3080/
ssh root@zimaos 'journalctl -u deepseek-harness.service -n 100 --no-pager'
```

Expected: service is active, HTTP succeeds, and logs contain no missing runtime, read-only filesystem, native-addon, or Host-trust errors.

**Step 6: Mechanically inspect public registrations and release metadata**

```bash
grep -R "deepseek_harness\|deepseek-harness" \
  zimaos/raw scripts/build-zimaos-raw.ts .github/workflows/zimaos-raw.yml docs/cookbook/zimaos-raw.md

gh release view latest --json tagName,isDraft,isPrerelease,assets
```

Expected: identity values are intentional and consistent; release tag is `latest`, draft/prerelease are false, and the RAW plus checksum assets exist.

**Step 7: Final commit only if verification changed files**

```bash
git add <only-the-files-fixed-during-verification>
git commit -m "fix: complete ZimaOS raw acceptance"
```
