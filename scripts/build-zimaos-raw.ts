/** Build and validate the self-contained Linux x64 ZimaOS RAW image. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  assertSafeStagingPath,
  deployRuntimeClosure,
  removePathSafely,
} from './runtime-deploy.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const NODE_VERSION = 'v24.19.0'
const NODE_ARCHIVE = `node-${NODE_VERSION}-linux-x64.tar.xz`
const NODE_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`
const MODULE_ID = 'deepseek_harness'
const SERVICE_NAME = 'deepseek-harness'
const APP_ROOT = 'usr/lib/deepseek-harness/app'
const NODE_ROOT = 'usr/lib/deepseek-harness/node'
const DEFAULT_OUTPUT = `${MODULE_ID}.raw`
const LOG_PREFIX = 'build-zimaos-raw'
const PROBE_TIMEOUT_MS = 30_000
const ELF_X64_MACHINE = 62
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|TOKEN|SECRET|PASSWORD|PASS|CREDENTIALS?|AUTH)(?:_|$)/iu

interface BuildOptions {
  readonly output: string
  readonly staging?: string
  readonly skipBuild: boolean
  readonly skipRuntimeProbe: boolean
  readonly dryRun: boolean
}

interface CasaOsModule {
  readonly name: string
  readonly services: ReadonlyArray<{ readonly name: string }>
  readonly ui: {
    readonly name: string
    readonly entry: string
    readonly icon: string
  }
}

/**
 * Return the official digest for one exact Node.js archive.
 * @param sums - contents of the official SHASUMS256.txt.
 * @param archive - exact archive basename.
 * @returns the lowercase SHA-256 digest.
 */
export function parseNodeChecksum(sums: string, archive: string): string {
  for (const line of sums.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})\s+(.+)$/u.exec(line.trim())
    if (match === null) continue
    const digest = match[1]
    if (digest !== undefined && match[2] === archive) return digest
  }
  throw new Error(`${LOG_PREFIX}: checksum entry missing for ${archive}.`)
}

/**
 * Reject inconsistent extension, module, and service identifiers.
 * @param stagedRoot - root of the staged filesystem image.
 */
export function assertPackageIdentity(stagedRoot: string): void {
  const extensionRelease = readFileSync(
    stagedPath(
      stagedRoot,
      `usr/lib/extension-release.d/extension-release.${MODULE_ID}`,
    ),
    'utf8',
  )
  const module = parseCasaOsModule(
    readFileSync(
      stagedPath(stagedRoot, `usr/share/casaos/modules/${MODULE_ID}.json`),
      'utf8',
    ),
  )
  const serviceNames = module.services.map(service => service.name)
  if (
    extensionRelease.trim() !== 'ID=_any' ||
    module.name !== MODULE_ID ||
    module.ui.name !== MODULE_ID ||
    serviceNames.length !== 1 ||
    serviceNames[0] !== SERVICE_NAME
  ) {
    throw new Error(
      `${LOG_PREFIX}: inconsistent package identity in staged RAW root ${stagedRoot}.`,
    )
  }
}

/**
 * Reject the first symbolic link found under a staged application tree.
 * @param root - directory traversed without following links.
 */
export function assertNoSymlinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink())
      throw new Error(
        `${LOG_PREFIX}: symbolic link remains in staged application: ${path}.`,
      )
    if (metadata.isDirectory()) assertNoSymlinks(path)
  }
}

/**
 * Require every absolute systemd ExecStart executable below the staged root.
 * @param stagedRoot - root of the staged filesystem image.
 */
export function assertRequiredServicePaths(stagedRoot: string): void {
  assertRequiredModulePaths(stagedRoot)
  const servicePath = stagedPath(
    stagedRoot,
    `usr/lib/systemd/system/${SERVICE_NAME}.service`,
  )
  const service = readFileSync(servicePath, 'utf8')
  const execStart = /^ExecStart=(\/\S+)/mu.exec(service)?.[1]
  if (execStart === undefined)
    throw new Error(`${LOG_PREFIX}: ${servicePath} has no absolute ExecStart.`)
  const executable = stagedPath(stagedRoot, execStart)
  if (!existsSync(executable))
    throw new Error(
      `${LOG_PREFIX}: systemd ExecStart path is missing from staging: ${execStart}.`,
    )
}

/**
 * Require every CasaOS module entry and icon below its static module root.
 * @param stagedRoot - root of the staged filesystem image.
 */
export function assertRequiredModulePaths(stagedRoot: string): void {
  const module = parseCasaOsModule(
    readFileSync(
      stagedPath(stagedRoot, `usr/share/casaos/modules/${MODULE_ID}.json`),
      'utf8',
    ),
  )
  for (const modulePath of [module.ui.entry, module.ui.icon]) {
    const path = stagedPath(
      stagedRoot,
      join('usr/share/casaos/www', modulePath),
    )
    if (!existsSync(path))
      throw new Error(
        `${LOG_PREFIX}: CasaOS module path is missing from staging: ${modulePath}.`,
      )
  }
}

/** @returns HTTP paths exercised by the keyless Web runtime probe. */
export function webProbePaths(): readonly string[] {
  return ['/', '/api/host.describe']
}

/** Protected API route used to prove Host-authority rejection. */
export function untrustedHostProbePath(): string {
  return '/api/host.describe'
}

/**
 * Stable mksquashfs arguments after staged inode times are normalized.
 * @param root - staged filesystem root.
 * @param output - image path.
 * @param epoch - reproducible filesystem timestamp.
 * @returns complete mksquashfs argument vector.
 */
export function squashFsArgs(
  root: string,
  output: string,
  epoch: number,
): readonly string[] {
  return [
    root,
    output,
    '-noappend',
    '-no-xattrs',
    '-all-root',
    '-mkfs-time',
    String(epoch),
  ]
}

/**
 * Reject a staging root that equals or contains the source repository.
 * @param staging - proposed staging directory.
 */
export async function assertSafeStagingRoot(staging: string): Promise<void> {
  await assertSafeStagingPath(staging, repoRoot, LOG_PREFIX)
}

class ZimaOsRawBuild {
  private readonly rawRoot: string
  private readonly temporaryRoot: string | undefined

  private constructor(
    private readonly options: BuildOptions,
    rawRoot: string,
    temporaryRoot?: string,
  ) {
    this.rawRoot = rawRoot
    this.temporaryRoot = temporaryRoot
  }

  /** Create a pipeline with a retained or temporary staging root. */
  static async create(options: BuildOptions): Promise<ZimaOsRawBuild> {
    if (options.dryRun) {
      const rawRoot = resolve(
        options.staging ?? join(repoRoot, '.dsh-build/zimaos-raw/root'),
      )
      await assertSafeStagingRoot(rawRoot)
      return new ZimaOsRawBuild(options, rawRoot)
    }
    if (options.staging !== undefined) {
      const rawRoot = resolve(options.staging)
      await assertSafeStagingRoot(rawRoot)
      await removePathSafely(rawRoot)
      await mkdir(rawRoot, { recursive: true })
      return new ZimaOsRawBuild(options, rawRoot)
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-zimaos-raw-'))
    return new ZimaOsRawBuild(
      options,
      join(temporaryRoot, 'root'),
      temporaryRoot,
    )
  }

  /** Assemble, validate, probe, and package the image. */
  async run(): Promise<void> {
    try {
      this.printConfiguration()
      await this.buildArtifacts()
      await this.stageSkeleton()
      await this.stageRuntimeClosure()
      await this.stageNode()
      if (!this.options.dryRun) this.validateStagedRoot()
      await this.probeRuntime()
      await this.createSquashFs()
    } finally {
      if (this.temporaryRoot !== undefined)
        await rm(this.temporaryRoot, { recursive: true, force: true })
    }
  }

  private printConfiguration(): void {
    console.log(`${LOG_PREFIX}: Node.js: ${NODE_BASE_URL}/${NODE_ARCHIVE}`)
    console.log(`${LOG_PREFIX}: checksums: ${NODE_BASE_URL}/SHASUMS256.txt`)
    console.log(`${LOG_PREFIX}: staging: ${this.rawRoot}`)
    console.log(`${LOG_PREFIX}: output: ${this.options.output}`)
  }

  private async buildArtifacts(): Promise<void> {
    if (this.options.skipBuild) {
      console.log(
        `${LOG_PREFIX}: skip official build; existing artifacts are required`,
      )
      return
    }
    await this.runCommand('official build', pnpmBin(), [
      'run',
      'build:official',
    ])
    if (
      this.options.dryRun ||
      (process.platform === 'linux' && process.arch === 'x64')
    ) {
      await this.runCommand('Linux x64 Landlock build', pnpmBin(), [
        '--dir',
        'native/landlock-run',
        'run',
        'build:native',
      ])
    }
  }

  private async stageSkeleton(): Promise<void> {
    const source = join(repoRoot, 'zimaos/raw/usr')
    const destination = join(this.rawRoot, 'usr')
    if (this.options.dryRun) {
      console.log(`${LOG_PREFIX}: [dry-run] cp -R ${source} ${destination}`)
      return
    }
    await cp(source, destination, { recursive: true })
    await chmod(stagedPath(this.rawRoot, `usr/bin/${SERVICE_NAME}`), 0o755)
  }

  private async stageRuntimeClosure(): Promise<void> {
    const appRoot = stagedPath(this.rawRoot, APP_ROOT)
    await deployRuntimeClosure({
      deployRootPackage: 'dsh-zimaos-runtime',
      staging: appRoot,
      sourceNodeModules: join(repoRoot, 'zimaos/runtime/node_modules'),
      runDeploy: async args =>
        this.runCommand('runtime deploy', pnpmBin(), [...args]),
      logPrefix: LOG_PREFIX,
      removeNames: ['README.md', 'README.zh.md', 'README.i18n.yaml'],
      dryRun: this.options.dryRun,
    })
    await this.stageLinuxNativePackage(appRoot)
    await this.stageVendoredRuntimePackages(appRoot)
    await this.materializeRuntimeManifest(appRoot)
    if (!this.options.dryRun) normalizeWorkspaceDependencySpecifiers(appRoot)
  }

  private async stageLinuxNativePackage(appRoot: string): Promise<void> {
    const source = join(repoRoot, 'native/landlock-run/packages/linux-x64')
    const destination = join(
      appRoot,
      'node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64',
    )
    if (this.options.dryRun) {
      console.log(`${LOG_PREFIX}: [dry-run] cp -R ${source} ${destination}`)
      return
    }
    await this.runCommand('Linux x64 Landlock verification', process.execPath, [
      'native/landlock-run/scripts/verify-launcher-binary.mjs',
      'packages/linux-x64',
    ])
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true })
    await chmod(join(destination, 'bin/landlock-run'), 0o755)
  }

  private async stageVendoredRuntimePackages(appRoot: string): Promise<void> {
    for (const [name, sourceRelative] of [
      ['cosmokit', 'vendor/cosmokit'],
      ['schemastery', 'vendor/schemastery'],
    ] as const) {
      const source = join(repoRoot, sourceRelative)
      const destination = join(appRoot, 'node_modules/@deepseek-ai', name)
      if (this.options.dryRun) {
        console.log(
          `${LOG_PREFIX}: [dry-run] copy built ${source} to ${destination} without nested node_modules`,
        )
        continue
      }
      const nestedNodeModules = join(source, 'node_modules')
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path =>
          path !== nestedNodeModules &&
          !path.startsWith(nestedNodeModules + sep),
      })
    }
  }

  private async materializeRuntimeManifest(appRoot: string): Promise<void> {
    const manifestPath = join(appRoot, 'package.json')
    const dshManifestPath = join(
      appRoot,
      'node_modules/@deepseek-ai/dsh/package.json',
    )
    if (this.options.dryRun) {
      console.log(
        `${LOG_PREFIX}: [dry-run] replace workspace dependency in ${manifestPath} with staged dsh version`,
      )
      return
    }
    const manifest = parseJsonRecord(
      await readFile(manifestPath, 'utf8'),
      manifestPath,
    )
    const dshManifest = parseJsonRecord(
      await readFile(dshManifestPath, 'utf8'),
      dshManifestPath,
    )
    if (typeof dshManifest.version !== 'string')
      throw new Error(`${LOG_PREFIX}: staged dsh manifest has no version.`)
    manifest.dependencies = { '@deepseek-ai/dsh': dshManifest.version }
    await replaceJsonFile(manifestPath, manifest)
  }

  private async stageNode(): Promise<void> {
    const nodeRoot = stagedPath(this.rawRoot, NODE_ROOT)
    if (this.options.dryRun) {
      console.log(
        `${LOG_PREFIX}: [dry-run] download and verify ${NODE_BASE_URL}/SHASUMS256.txt`,
      )
      console.log(
        `${LOG_PREFIX}: [dry-run] download and verify ${NODE_BASE_URL}/${NODE_ARCHIVE}`,
      )
      console.log(
        `${LOG_PREFIX}: [dry-run] tar -xJf ${NODE_ARCHIVE} -C ${nodeRoot} --strip-components=1`,
      )
      return
    }
    const sums = await fetchText(`${NODE_BASE_URL}/SHASUMS256.txt`)
    const digest = parseNodeChecksum(sums, NODE_ARCHIVE)
    const cacheDir = join(repoRoot, '.cache/zimaos-raw')
    const cachedArchive = join(cacheDir, `${NODE_ARCHIVE}.${digest}`)
    await mkdir(cacheDir, { recursive: true })
    if (
      existsSync(cachedArchive) &&
      (await sha256File(cachedArchive)) !== digest
    ) {
      await rm(cachedArchive, { force: true })
    }
    if (!existsSync(cachedArchive)) {
      const temporaryArchive = join(
        cacheDir,
        `.${NODE_ARCHIVE}.${process.pid}.tmp`,
      )
      await downloadFile(`${NODE_BASE_URL}/${NODE_ARCHIVE}`, temporaryArchive)
      const actual = await sha256File(temporaryArchive)
      if (actual !== digest) {
        await rm(temporaryArchive, { force: true })
        throw new Error(
          `${LOG_PREFIX}: Node.js archive checksum mismatch: expected ${digest}, got ${actual}.`,
        )
      }
      await rename(temporaryArchive, cachedArchive)
    }
    if ((await sha256File(cachedArchive)) !== digest) {
      throw new Error(
        `${LOG_PREFIX}: corrupt Node.js cache entry ${cachedArchive}.`,
      )
    }
    await mkdir(nodeRoot, { recursive: true })
    await this.runCommand('extract Node.js', 'tar', [
      '-xJf',
      cachedArchive,
      '-C',
      nodeRoot,
      '--strip-components=1',
    ])
    await chmod(join(nodeRoot, 'bin/node'), 0o755)
  }

  private validateStagedRoot(): void {
    assertPackageIdentity(this.rawRoot)
    assertRequiredServicePaths(this.rawRoot)
    const launcher = readFileSync(
      stagedPath(this.rawRoot, `usr/bin/${SERVICE_NAME}`),
      'utf8',
    )
    const overlay = readFileSync(
      stagedPath(this.rawRoot, 'usr/lib/deepseek-harness/zimaos.patch.yml'),
      'utf8',
    )
    if (
      launcher.includes('--host 0.0.0.0') ||
      !overlay.includes('host: 0.0.0.0')
    ) {
      throw new Error(
        `${LOG_PREFIX}: wildcard host must be selected only by the staged ZimaOS overlay.`,
      )
    }
    if (!launcher.includes('/var/lib/casaos/deepseek_harness')) {
      throw new Error(
        `${LOG_PREFIX}: launcher state must remain outside the read-only /usr tree.`,
      )
    }
    const appRoot = stagedPath(this.rawRoot, APP_ROOT)
    assertNoSymlinks(appRoot)
    assertNoWorkspaceSpecifiers(appRoot)
    for (const required of requiredAppPaths()) {
      const path = join(appRoot, required)
      if (!existsSync(path))
        throw new Error(
          `${LOG_PREFIX}: required runtime path is missing: ${required}.`,
        )
    }
    const node = stagedPath(this.rawRoot, `${NODE_ROOT}/bin/node`)
    if (!existsSync(node))
      throw new Error(
        `${LOG_PREFIX}: bundled Node.js executable is missing: ${node}.`,
      )
    assertElfX64(
      join(appRoot, 'node_modules/node-pty/prebuilds/linux-x64/pty.node'),
      'node-pty Linux x64 addon',
    )
  }

  private async probeRuntime(): Promise<void> {
    if (this.options.skipRuntimeProbe) {
      console.log(`${LOG_PREFIX}: skip Linux runtime probe`)
      return
    }
    const node = stagedPath(this.rawRoot, `${NODE_ROOT}/bin/node`)
    const cli = stagedPath(
      this.rawRoot,
      `${APP_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`,
    )
    if (this.options.dryRun) {
      console.log(`${LOG_PREFIX}: [dry-run] ${node} ${cli} --version`)
      console.log(
        `${LOG_PREFIX}: [dry-run] launch staged /usr/bin/${SERVICE_NAME} --staged-root ${this.rawRoot} with temporary DSH_HOME`,
      )
      for (const path of webProbePaths())
        console.log(
          `${LOG_PREFIX}: [dry-run] probe http://127.0.0.1:3080${path}`,
        )
      console.log(
        `${LOG_PREFIX}: [dry-run] reject untrusted Host authority and require bounded shutdown`,
      )
      return
    }
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      throw new Error(
        `${LOG_PREFIX}: runtime probes require Linux x64; pass --skip-runtime-probe for local assembly.`,
      )
    }
    await this.runCommand('CLI version probe', node, [cli, '--version'])
    const home = await mkdtemp(join(tmpdir(), 'dsh-zimaos-home-'))
    const launcher = stagedPath(this.rawRoot, `usr/bin/${SERVICE_NAME}`)
    const child = spawn(launcher, ['--staged-root', this.rawRoot], {
      cwd: stagedPath(this.rawRoot, APP_ROOT),
      env: {
        ...buildSubprocessEnvironment(process.env),
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    try {
      await waitForHttp(
        '/',
        '127.0.0.1:3080',
        response =>
          response.status >= 200 &&
          response.status < 400 &&
          /DeepSeek Harness|id=["']root["']/u.test(response.body),
      )
      const hostDescription = await httpGet(
        '/api/host.describe',
        '127.0.0.1:3080',
      )
      if (hostDescription.status >= 500)
        throw new Error(
          `${LOG_PREFIX}: host description probe returned ${hostDescription.status}.`,
        )
      const untrusted = await httpGet(
        untrustedHostProbePath(),
        'untrusted.invalid',
      )
      if (untrusted.status !== 403) {
        throw new Error(
          `${LOG_PREFIX}: browser trust fence returned ${untrusted.status} for untrusted Host authority.`,
        )
      }
    } catch (error) {
      throw new Error(`${LOG_PREFIX}: Web runtime probe failed.\n${output}`, {
        cause: error,
      })
    } finally {
      await stopChild(child)
      await rm(home, { recursive: true, force: true })
    }
  }

  private async createSquashFs(): Promise<void> {
    if (this.options.dryRun) {
      console.log(
        `${LOG_PREFIX}: [dry-run] normalize inode times and run mksquashfs ${this.rawRoot} ${this.options.output} -noappend -no-xattrs -all-root -mkfs-time <SOURCE_DATE_EPOCH|commit-time>`,
      )
      console.log(
        `${LOG_PREFIX}: [dry-run] write ${this.options.output}.sha256`,
      )
      return
    }
    await requireCommand('mksquashfs')
    const epoch = await reproducibleEpoch()
    await normalizeTreeTimestamps(this.rawRoot, epoch)
    await mkdir(dirname(this.options.output), { recursive: true })
    await rm(this.options.output, { force: true })
    await this.runCommand(
      'SquashFS assembly',
      'mksquashfs',
      squashFsArgs(this.rawRoot, this.options.output, epoch),
    )
    if (await commandExists('unsquashfs')) {
      const listing = await captureCommand('unsquashfs', [
        '-ll',
        this.options.output,
      ])
      for (const path of mandatoryImagePaths()) {
        if (!listing.includes(path))
          throw new Error(
            `${LOG_PREFIX}: SquashFS listing is missing ${path}.`,
          )
      }
    }
    const digest = await sha256File(this.options.output)
    await writeFile(
      `${this.options.output}.sha256`,
      `${digest}  ${basename(this.options.output)}\n`,
    )
  }

  private async runCommand(
    label: string,
    command: string,
    args: readonly string[],
  ): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.options.dryRun) {
      console.log(`${LOG_PREFIX}: [dry-run] ${printable}`)
      return
    }
    console.log(`${LOG_PREFIX}: ${label}: ${printable}`)
    await runCommand(command, args, repoRoot)
  }
}

function parseCli(argv: readonly string[]): BuildOptions {
  const values = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string' },
      staging: { type: 'string' },
      'skip-build': { type: 'boolean', default: false },
      'skip-runtime-probe': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  }).values
  if (values.help) {
    console.log(
      [
        'Usage: pnpm run build:zimaos-raw -- [flags]',
        '',
        '  --out <path>          output image (default: deepseek_harness.raw)',
        '  --staging <path>      retain the staged filesystem root',
        '  --skip-build          require existing official build artifacts',
        '  --skip-runtime-probe  skip Linux x64 startup and HTTP probes',
        '  --dry-run             print commands and paths without mutation',
      ].join('\n'),
    )
    process.exit(0)
  }
  if (
    !values['skip-runtime-probe'] &&
    process.platform !== 'linux' &&
    !values['dry-run']
  ) {
    throw new Error(
      `${LOG_PREFIX}: non-Linux hosts require --skip-runtime-probe.`,
    )
  }
  return {
    output: resolve(values.out ?? DEFAULT_OUTPUT),
    ...(values.staging === undefined
      ? {}
      : { staging: resolve(values.staging) }),
    skipBuild: values['skip-build'],
    skipRuntimeProbe: values['skip-runtime-probe'],
    dryRun: values['dry-run'],
  }
}

function parseCasaOsModule(contents: string): CasaOsModule {
  const value = parseJsonRecord(contents, 'CasaOS module JSON')
  if (
    typeof value.name !== 'string' ||
    !isRecord(value.ui) ||
    !Array.isArray(value.services)
  ) {
    throw new Error(`${LOG_PREFIX}: malformed CasaOS module JSON fields.`)
  }
  const { ui } = value
  if (
    typeof ui.name !== 'string' ||
    typeof ui.entry !== 'string' ||
    typeof ui.icon !== 'string'
  ) {
    throw new Error(`${LOG_PREFIX}: malformed CasaOS module UI fields.`)
  }
  const services = value.services.map((service) => {
    if (!isRecord(service) || typeof service.name !== 'string')
      throw new Error(`${LOG_PREFIX}: malformed CasaOS module service.`)
    return { name: service.name }
  })
  return {
    name: value.name,
    ui: { name: ui.name, entry: ui.entry, icon: ui.icon },
    services,
  }
}

function parseJsonRecord(
  contents: string,
  source: string,
): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw new Error(`${LOG_PREFIX}: malformed JSON in ${source}.`, {
      cause: error,
    })
  }
  if (!isRecord(value))
    throw new Error(`${LOG_PREFIX}: JSON root in ${source} must be an object.`)
  return value
}

/**
 * Replace workspace dependency ranges with staged package versions.
 * @param root - materialized production application root.
 */
export function normalizeWorkspaceDependencySpecifiers(root: string): void {
  const manifests = findPackageManifests(root)
  const versions = new Map<string, string>()
  for (const path of manifests) {
    const manifest = parseJsonRecord(readFileSync(path, 'utf8'), path)
    if (
      typeof manifest.name === 'string' &&
      typeof manifest.version === 'string'
    )
      versions.set(manifest.name, manifest.version)
  }
  for (const path of manifests) {
    const manifest = parseJsonRecord(readFileSync(path, 'utf8'), path)
    let changed = false
    if ('devDependencies' in manifest) {
      delete manifest.devDependencies
      changed = true
    }
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ] as const) {
      const dependencies = manifest[field]
      if (!isRecord(dependencies)) continue
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (
          typeof specifier !== 'string' ||
          !specifier.startsWith('workspace:')
        )
          continue
        const version = versions.get(name)
        if (version === undefined && field === 'dependencies') {
          throw new Error(
            `${LOG_PREFIX}: staged workspace dependency ${name} has no package version.`,
          )
        }
        if (version === undefined && typeof manifest.version !== 'string') {
          throw new Error(
            `${LOG_PREFIX}: staged manifest has no version: ${path}.`,
          )
        }
        dependencies[name] = version ?? manifest.version
        changed = true
      }
    }
    if (changed) replaceJsonFileSync(path, manifest)
  }
}

function replaceJsonFileSync(
  path: string,
  value: Record<string, unknown>,
): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSyncExclusive(temporary, `${JSON.stringify(value, undefined, 2)}\n`)
  renameSyncExclusive(temporary, path)
}

function writeFileSyncExclusive(path: string, contents: string): void {
  writeFileSync(path, contents, { flag: 'wx', mode: 0o644 })
}

function renameSyncExclusive(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    rmSync(source, { force: true })
    throw error
  }
}

async function replaceJsonFile(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  })
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function findPackageManifests(root: string): string[] {
  const manifests: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const metadata = lstatSync(path)
    if (metadata.isDirectory()) manifests.push(...findPackageManifests(path))
    else if (entry.name === 'package.json') manifests.push(path)
  }
  return manifests
}

function assertNoWorkspaceSpecifiers(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const metadata = lstatSync(path)
    if (metadata.isDirectory()) assertNoWorkspaceSpecifiers(path)
    else if (
      entry.name === 'package.json' &&
      readFileSync(path, 'utf8').includes('workspace:')
    ) {
      throw new Error(
        `${LOG_PREFIX}: workspace dependency specifier remains in ${path}.`,
      )
    }
  }
}

function requiredAppPaths(): readonly string[] {
  return [
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    'node_modules/@deepseek-ai/cosmokit/lib/index.js',
    'node_modules/@deepseek-ai/schemastery/lib/index.mjs',
    'node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64/bin/landlock-run',
    'node_modules/node-pty/prebuilds/linux-x64/pty.node',
  ]
}

function mandatoryImagePaths(): readonly string[] {
  return [
    `usr/bin/${SERVICE_NAME}`,
    `usr/lib/systemd/system/${SERVICE_NAME}.service`,
    `usr/share/casaos/modules/${MODULE_ID}.json`,
    `${NODE_ROOT}/bin/node`,
    `${APP_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`,
  ]
}

/**
 * Require a Linux x64 ELF file.
 * @param path - native binary path.
 * @param description - diagnostic subject.
 */
export function assertElfX64(path: string, description: string): void {
  const header = readFileSync(path).subarray(0, 20)
  if (
    header.length < 20 ||
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header.readUInt16LE(18) !== ELF_X64_MACHINE
  ) {
    throw new Error(
      `${LOG_PREFIX}: ${description} is not a Linux x64 ELF binary: ${path}.`,
    )
  }
}

async function normalizeTreeTimestamps(root: string, epoch: number): Promise<void> {
  const timestamp = new Date(epoch * 1000)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await normalizeTreeTimestamps(path, epoch)
    await utimes(path, timestamp, timestamp)
  }
  await utimes(root, timestamp, timestamp)
}

async function reproducibleEpoch(): Promise<number> {
  const configured = process.env.SOURCE_DATE_EPOCH
  if (configured !== undefined) {
    const epoch = Number(configured)
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0xffffffff) {
      throw new Error(
        `${LOG_PREFIX}: SOURCE_DATE_EPOCH must be an unsigned 32-bit integer.`,
      )
    }
    return epoch
  }
  const value = (
    await captureCommand('git', ['show', '-s', '--format=%ct', 'HEAD'])
  ).trim()
  const epoch = Number(value)
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0xffffffff) {
    throw new Error(
      `${LOG_PREFIX}: git commit timestamp is not an unsigned 32-bit integer: ${value}.`,
    )
  }
  return epoch
}

function stagedPath(root: string, absoluteOrRelative: string): string {
  const path = absoluteOrRelative.startsWith('/')
    ? absoluteOrRelative.slice(1)
    : absoluteOrRelative
  const destination = resolve(root, path)
  if (
    destination !== resolve(root) &&
    !destination.startsWith(resolve(root) + sep)
  ) {
    throw new Error(
      `${LOG_PREFIX}: staged path escapes root: ${absoluteOrRelative}.`,
    )
  }
  return destination
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(
      `${LOG_PREFIX}: download failed (${response.status}): ${url}.`,
    )
  return response.text()
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(
      `${LOG_PREFIX}: download failed (${response.status}): ${url}.`,
    )
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()))
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

interface HttpResponse {
  readonly status: number
  readonly body: string
}

async function httpGet(path: string, host: string): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const client = request(
      {
        hostname: '127.0.0.1',
        port: 3080,
        path,
        headers: { Host: host },
        method: 'GET',
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.once('end', () => {
          resolvePromise({ status: response.statusCode ?? 0, body })
        })
      },
    )
    client.setTimeout(2_000, () => {
      client.destroy(
        new Error(`${LOG_PREFIX}: HTTP request timed out for ${path}.`),
      )
    })
    client.once('error', reject)
    client.end()
  })
}

async function waitForHttp(
  path: string,
  host: string,
  accept: (response: HttpResponse) => boolean,
): Promise<void> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await httpGet(path, host)
      if (accept(response)) return
      lastError = new Error(`unexpected HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`${LOG_PREFIX}: HTTP probe timed out for ${path}.`, {
    cause: lastError,
  })
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const gracefulExit = waitForChildExit(child, 10_000)
  child.kill('SIGTERM')
  if (await gracefulExit) return
  const forcedExit = waitForChildExit(child, 10_000)
  child.kill('SIGKILL')
  if (!(await forcedExit))
    throw new Error(
      `${LOG_PREFIX}: staged Web process did not stop after SIGKILL.`,
    )
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolvePromise) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off('exit', onExit)
      clearTimeout(timer)
      resolvePromise(true)
    }
  })
}

async function requireCommand(command: string): Promise<void> {
  if (!(await commandExists(command)))
    throw new Error(`${LOG_PREFIX}: required command not found: ${command}.`)
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await captureCommand('sh', ['-c', `command -v ${command}`])
    return true
  } catch {
    return false
  }
}

async function captureCommand(
  command: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(stdout)
      else
        reject(
          new Error(
            `${formatCommand(command, args)} failed with exit code ${code ?? 'unknown'}: ${stderr}`,
          ),
        )
    })
  })
}

/**
 * Remove ambient credentials before invoking package lifecycle scripts.
 * @param environment - parent process environment.
 * @returns an environment without credential-bearing names.
 */
export function buildSubprocessEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !SENSITIVE_ENV_NAME.test(name),
    ),
  )
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: 'inherit',
      env: { ...buildSubprocessEnvironment(process.env), CI: 'true' },
    })
    child.once('error', (error) => {
      reject(
        new Error(
          `${LOG_PREFIX}: failed to spawn ${formatCommand(command, args)}: ${error.message}`,
        ),
      )
    })
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else
        reject(
          new Error(
            `${LOG_PREFIX}: ${formatCommand(command, args)} failed with ${code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`}.`,
          ),
        )
    })
  })
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map(part => (/[\s"']/u.test(part) ? JSON.stringify(part) : part))
    .join(' ')
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2))
  const build = await ZimaOsRawBuild.create(options)
  await build.run()
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await main()
