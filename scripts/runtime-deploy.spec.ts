import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deployRuntimeClosure } from './runtime-deploy.ts'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('deployRuntimeClosure', () => {
  it('deploys with fixed flags and restores omitted direct dependencies without nested node_modules', async () => {
    const root = temporaryRoot()
    const staging = join(root, 'staging')
    const sourceNodeModules = join(root, 'source', 'node_modules')
    createFile(join(staging, 'stale.txt'), 'stale')
    createFile(join(sourceNodeModules, 'restored', 'index.js'), 'restored')
    createFile(join(sourceNodeModules, 'restored', 'node_modules', 'nested', 'index.js'), 'nested')
    const runDeploy = vi.fn(async (args: readonly string[]) => {
      expect(existsSync(join(staging, 'stale.txt'))).toBe(false)
      createFile(join(staging, 'package.json'), JSON.stringify({
        dependencies: { present: '1.0.0', restored: '1.0.0' },
      }))
      createFile(join(staging, 'node_modules', 'present', 'index.js'), 'present')
      createFile(join(staging, 'README.md'), 'deploy-only')
      expect(args).toEqual([
        '--filter', 'runtime-root', 'deploy', '--legacy', '--prod',
        '--config.node-linker=hoisted', '--config.auto-install-peers=false',
        '--config.link-workspace-packages=true', staging,
      ])
    })

    await deployRuntimeClosure({
      deployRootPackage: 'runtime-root',
      staging,
      sourceNodeModules,
      runDeploy,
      logPrefix: 'runtime-test',
      removeNames: ['README.md'],
    })

    expect(readFileSync(join(staging, 'node_modules', 'restored', 'index.js'), 'utf8')).toBe('restored')
    expect(existsSync(join(staging, 'node_modules', 'restored', 'node_modules'))).toBe(false)
    expect(existsSync(join(staging, 'README.md'))).toBe(false)
    expect(runDeploy).toHaveBeenCalledOnce()
  })

  it('materializes package links, omits their nested node_modules, and safely removes .bin links', async () => {
    const root = temporaryRoot()
    const staging = join(root, 'staging')
    const sourceNodeModules = join(root, 'source', 'node_modules')
    const linkedSource = join(root, 'linked-package')
    const binTarget = join(root, 'bin-target')
    createFile(join(linkedSource, 'index.js'), 'linked')
    createFile(join(linkedSource, 'node_modules', 'nested', 'index.js'), 'nested')
    createFile(join(binTarget, 'keep.txt'), 'keep')

    await deployRuntimeClosure({
      deployRootPackage: 'runtime-root',
      staging,
      sourceNodeModules,
      runDeploy: async () => {
        createFile(join(staging, 'package.json'), JSON.stringify({ dependencies: { linked: '1.0.0' } }))
        mkdirSync(join(staging, 'node_modules'), { recursive: true })
        symlinkSync(linkedSource, join(staging, 'node_modules', 'linked'), 'dir')
        symlinkSync(binTarget, join(staging, 'node_modules', '.bin'), 'dir')
      },
      logPrefix: 'runtime-test',
    })

    const linked = join(staging, 'node_modules', 'linked')
    expect(lstatSync(linked).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(linked, 'index.js'), 'utf8')).toBe('linked')
    expect(existsSync(join(linked, 'node_modules'))).toBe(false)
    expect(existsSync(join(staging, 'node_modules', '.bin'))).toBe(false)
    expect(readFileSync(join(binTarget, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('rejects a direct dependency absent from deployment and source node_modules', async () => {
    const root = temporaryRoot()
    const staging = join(root, 'staging')
    const sourceNodeModules = join(root, 'source', 'node_modules')

    await expect(deployRuntimeClosure({
      deployRootPackage: 'runtime-root',
      staging,
      sourceNodeModules,
      runDeploy: async () => {
        createFile(join(staging, 'package.json'), JSON.stringify({ dependencies: { absent: '1.0.0' } }))
      },
      logPrefix: 'runtime-test',
    })).rejects.toThrow(
      `runtime-test: deployed dependency absent is absent from both ${join(staging, 'node_modules', 'absent')} and ${join(sourceNodeModules, 'absent')}.`,
    )
  })

  it.each([
    resolve(import.meta.dirname, '..'),
    dirname(resolve(import.meta.dirname, '..')),
  ])('rejects unsafe staging %s before clearing or deployment', async (staging) => {
    const runDeploy = vi.fn(async () => {})

    await expect(deployRuntimeClosure({
      deployRootPackage: 'runtime-root',
      staging,
      sourceNodeModules: join(temporaryRoot(), 'source', 'node_modules'),
      runDeploy,
      logPrefix: 'runtime-test',
    })).rejects.toThrow('runtime-test: refusing to clear staging dir')
    expect(runDeploy).not.toHaveBeenCalled()
  })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-deploy-'))
  roots.push(root)
  return root
}

function createFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}
