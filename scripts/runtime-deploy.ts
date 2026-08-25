/** Assemble a symlink-free production runtime from pnpm's legacy deploy output. */

import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const sourceRoot = resolve(import.meta.dirname, '..')

/** Inputs and side effects used to assemble a deployed runtime closure. */
export interface RuntimeDeployOptions {
  /** Package selected as the root of the production deployment. */
  deployRootPackage: string
  /** Directory replaced by the deployed, symlink-free runtime. */
  staging: string
  /** Installed packages used to restore direct dependencies omitted by legacy deploy. */
  sourceNodeModules: string
  /** Invoke pnpm with the complete deploy argument list. */
  runDeploy: (args: readonly string[]) => Promise<void>
  /** Prefix included in progress and error messages. */
  logPrefix: string
  /** Staged top-level names removed after assembly. */
  removeNames?: readonly string[]
  /** Print filesystem operations without changing the staging directory. */
  dryRun?: boolean
}

/**
 * Replace a staging directory with a production deploy, restore omitted direct
 * dependencies, and materialize package links.
 * @param options - deployment paths, callback, logging, and dry-run settings.
 * @returns when the runtime closure is assembled or its dry run is complete.
 */
export async function deployRuntimeClosure(
  options: RuntimeDeployOptions,
): Promise<void> {
  const staging = resolve(options.staging)
  await assertSafeStagingPath(staging, sourceRoot, options.logPrefix)
  if (options.dryRun === true) {
    console.log(`${options.logPrefix}: [dry-run] rm -rf ${staging}`)
  } else {
    await removePathSafely(staging)
  }

  await options.runDeploy([
    '--filter',
    options.deployRootPackage,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    staging,
  ])

  if (options.dryRun === true) {
    console.log(
      `${options.logPrefix}: [dry-run] restore direct dependencies omitted by legacy deploy`,
    )
    console.log(
      `${options.logPrefix}: [dry-run] materialize staged package links`,
    )
    for (const name of options.removeNames ?? []) {
      console.log(
        `${options.logPrefix}: [dry-run] rm -f ${join(staging, name)}`,
      )
    }
    return
  }

  await restoreDirectDependencies(
    staging,
    resolve(options.sourceNodeModules),
    options.logPrefix,
  )
  await materializePackageLinks(staging)
  await Promise.all(
    (options.removeNames ?? []).map(name =>
      removePathSafely(join(staging, name)),
    ),
  )
}

/**
 * Reject a staging path that can remove the protected root through lexical or
 * symlinked ancestors.
 * @param staging - path that will be removed recursively.
 * @param protectedRoot - repository or other root that must survive removal.
 * @param logPrefix - diagnostic prefix.
 * @returns when the staging path is safe to remove.
 */
export async function assertSafeStagingPath(
  staging: string,
  protectedRoot: string,
  logPrefix: string,
): Promise<void> {
  const resolvedStaging = resolve(staging)
  const resolvedProtected = resolve(protectedRoot)
  const stagingFromProtected = relative(resolvedProtected, resolvedStaging)
  const protectedFromStaging = relative(resolvedStaging, resolvedProtected)
  const lexicalStagingIsInside = isInside(stagingFromProtected)
  if (protectedFromStaging === '' || isInside(protectedFromStaging)) {
    throw new Error(
      `${logPrefix}: refusing to clear staging dir ${resolvedStaging}: it contains the repo root.`,
    )
  }

  const [physicalStaging, physicalProtected] = await Promise.all([
    projectThroughExistingAncestor(resolvedStaging),
    realpath(resolvedProtected),
  ])
  const physicalStagingFromProtected = relative(
    physicalProtected,
    physicalStaging,
  )
  const physicalProtectedFromStaging = relative(
    physicalStaging,
    physicalProtected,
  )
  const expectedPhysicalStaging = lexicalStagingIsInside
    ? resolve(physicalProtected, stagingFromProtected)
    : undefined
  if (
    physicalProtectedFromStaging === '' ||
    isInside(physicalProtectedFromStaging) ||
    (expectedPhysicalStaging !== undefined &&
      physicalStaging !== expectedPhysicalStaging) ||
    (!lexicalStagingIsInside && isInside(physicalStagingFromProtected))
  ) {
    throw new Error(
      `${logPrefix}: refusing to clear staging dir ${resolvedStaging}: a symlinked ancestor reaches the repo root.`,
    )
  }
}

function isInside(relativePath: string): boolean {
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`)
  )
}

async function projectThroughExistingAncestor(path: string): Promise<string> {
  const remaining: string[] = []
  let ancestor = path
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...remaining.reverse())
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      remaining.push(
        ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
      )
      ancestor = parent
    }
  }
}

async function restoreDirectDependencies(
  staging: string,
  sourceNodeModules: string,
  logPrefix: string,
): Promise<void> {
  const manifestPath = join(staging, 'package.json')
  const manifest = parseManifest(
    await readFile(manifestPath, 'utf8'),
    manifestPath,
    logPrefix,
  )
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort(
    (left, right) => left.localeCompare(right),
  )
  const restored: string[] = []
  for (const dependency of dependencies) {
    const destination = join(staging, 'node_modules', dependency)
    if (await pathResolves(destination)) continue
    await removePathSafely(destination)
    const source = join(sourceNodeModules, dependency)
    if (!(await pathResolves(source))) {
      throw new Error(
        `${logPrefix}: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyPackageWithoutNestedDependencies(source, destination)
    restored.push(dependency)
  }
  const stillMissing: string[] = []
  for (const dependency of dependencies) {
    if (!(await pathResolves(join(staging, 'node_modules', dependency))))
      stillMissing.push(dependency)
  }
  if (stillMissing.length > 0) {
    throw new Error(
      `${logPrefix}: staged dependencies remain missing: ${stillMissing.join(', ')}.`,
    )
  }
  if (restored.length > 0)
    console.log(
      `${logPrefix}: restored legacy deploy hoists: ${restored.join(', ')}`,
    )
}

function parseManifest(
  contents: string,
  manifestPath: string,
  logPrefix: string,
): { dependencies?: Record<string, string> } {
  try {
    return JSON.parse(contents) as { dependencies?: Record<string, string> }
  } catch (error) {
    throw new Error(
      `${logPrefix}: cannot parse deployed manifest ${manifestPath}.`,
      { cause: error },
    )
  }
}

async function materializePackageLinks(staging: string): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await removePathSafely(
        join(nodeModules, ...segments.slice(0, binIndex + 1)),
      )
    } else {
      const source = await realpath(remaining)
      await unlink(remaining)
      await copyPackageWithoutNestedDependencies(source, remaining)
    }
    remaining = await findSymlink(nodeModules)
  }
}

async function copyPackageWithoutNestedDependencies(
  source: string,
  destination: string,
): Promise<void> {
  const nestedNodeModules = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path =>
      path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
  })
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function pathResolves(path: string): Promise<boolean> {
  try {
    await realpath(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * Unlink a link-shaped path or recursively remove a real directory.
 * @param path - path to remove without following a final symlink.
 * @returns when the path is absent.
 */
export async function removePathSafely(path: string): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  if (metadata.isSymbolicLink()) await unlink(path)
  else await rm(path, { recursive: true, force: true })
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
