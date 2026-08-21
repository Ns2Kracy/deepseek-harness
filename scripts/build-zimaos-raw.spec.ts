import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertElfX64,
  assertNoSymlinks,
  assertPackageIdentity,
  assertRequiredModulePaths,
  assertRequiredServicePaths,
  assertSafeStagingRoot,
  buildSubprocessEnvironment,
  normalizeWorkspaceDependencySpecifiers,
  parseNodeChecksum,
  squashFsArgs,
  untrustedHostProbeRequest,
  waitForHttpRequest,
  webProbeRequests,
} from './build-zimaos-raw.ts'

const roots: string[] = []
const archive = 'node-v24.19.0-linux-x64.tar.xz'

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('ZimaOS RAW assembly helpers', () => {
  it('removes ambient credentials from build subprocesses', () => {
    expect(
      buildSubprocessEnvironment({
        PATH: '/bin',
        HTTPS_PROXY: 'http://proxy.invalid',
        DEEPSEEK_API_KEY: 'secret',
        NODE_AUTH_TOKEN: 'secret',
        AWS_ACCESS_KEY_ID: 'secret',
        DATABASE_PASSWORD: 'secret',
      }),
    ).toEqual({ PATH: '/bin', HTTPS_PROXY: 'http://proxy.invalid' })
  })

  it('accepts only Linux x64 ELF native artifacts', () => {
    const root = temporaryRoot()
    const binary = join(root, 'native.node')
    const header = Buffer.alloc(20)
    header.set([0x7f, 0x45, 0x4c, 0x46])
    header.writeUInt16LE(62, 18)
    writeFileSync(binary, header)

    expect(() => {
      assertElfX64(binary, 'test native addon')
    }).not.toThrow()
    header.writeUInt16LE(183, 18)
    writeFileSync(binary, header)
    expect(() => {
      assertElfX64(binary, 'test native addon')
    }).toThrow(/not a Linux x64 ELF binary/)
  })

  it('extracts the exact Node.js archive checksum', () => {
    const digest =
      '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647'
    expect(parseNodeChecksum(`${digest}  ${archive}\n`, archive)).toBe(digest)
    expect(() => parseNodeChecksum('', archive)).toThrow(
      `checksum entry missing for ${archive}`,
    )
    expect(() =>
      parseNodeChecksum(`${digest}  other.tar.xz\n`, archive),
    ).toThrow('checksum entry missing')
  })

  it('rejects inconsistent package identity', () => {
    const root = validStagedRoot()
    createFile(
      join(root, 'usr/share/casaos/modules/deepseek_harness.json'),
      JSON.stringify({
        name: 'wrong_name',
        ui: {
          name: 'deepseek_harness',
          entry: '/modules/deepseek_harness/index.html',
          icon: '/modules/deepseek_harness/appicon.svg',
        },
        services: [{ name: 'deepseek-harness' }],
      }),
    )

    expect(() => {
      assertPackageIdentity(root)
    }).toThrow(/inconsistent package identity/)
  })

  it('rejects any symbolic link in the staged application', () => {
    const root = temporaryRoot()
    createFile(join(root, 'target'), 'target')
    symlinkSync(join(root, 'target'), join(root, 'link'))

    expect(() => {
      assertNoSymlinks(root)
    }).toThrow(/symbolic link/)
  })

  it('rejects a CasaOS module entry absent from staging', () => {
    const root = validStagedRoot()
    rmSync(
      join(root, 'usr/share/casaos/www/modules/deepseek_harness/index.html'),
    )

    expect(() => {
      assertRequiredModulePaths(root)
    }).toThrow(/CasaOS module path is missing/)
  })

  it('rejects a systemd ExecStart path absent from staging', () => {
    const root = validStagedRoot()
    createFile(
      join(root, 'usr/lib/systemd/system/deepseek-harness.service'),
      ['[Service]', 'ExecStart=/usr/bin/missing-launcher', ''].join('\n'),
    )

    expect(() => {
      assertRequiredServicePaths(root)
    }).toThrow(/ExecStart path is missing/)
  })

  it('replaces workspace ranges with staged package versions', () => {
    const root = temporaryRoot()
    createFile(
      join(root, 'node_modules/example/package.json'),
      JSON.stringify({ name: 'example', version: '1.2.3' }),
    )
    const source = join(root, 'source-consumer.json')
    createFile(
      source,
      JSON.stringify({
        name: 'consumer',
        version: '4.5.6',
        dependencies: { example: 'workspace:^' },
        peerDependencies: { example: 'workspace:*' },
        devDependencies: { absent: 'workspace:^' },
      }),
    )
    const consumer = join(root, 'node_modules/consumer/package.json')
    mkdirSync(dirname(consumer), { recursive: true })
    linkSync(source, consumer)
    createFile(
      join(root, 'node_modules/untouched/package.json'),
      JSON.stringify({
        name: 'untouched',
        version: '7.8.9',
      }),
    )

    normalizeWorkspaceDependencySpecifiers(root)

    expect(readFileSync(source, 'utf8')).toContain('workspace:')
    expect(readFileSync(consumer, 'utf8')).not.toContain('workspace:')
    expect(JSON.parse(readFileSync(consumer, 'utf8'))).toMatchObject({
      dependencies: { example: '1.2.3' },
      peerDependencies: { example: '1.2.3' },
    })
    expect(JSON.parse(readFileSync(consumer, 'utf8'))).not.toHaveProperty(
      'devDependencies',
    )
  })

  it('rejects an unresolved runtime workspace dependency', () => {
    const root = temporaryRoot()
    createFile(
      join(root, 'node_modules/consumer/package.json'),
      JSON.stringify({
        name: 'consumer',
        version: '4.5.6',
        dependencies: { absent: 'workspace:^' },
      }),
    )

    expect(() => {
      normalizeWorkspaceDependencySpecifiers(root)
    }).toThrow('staged workspace dependency absent has no package version')
  })

  it('rejects a staging root that could clear the repository', async () => {
    await expect(
      assertSafeStagingRoot(join(import.meta.dirname, '..')),
    ).rejects.toThrow(/contains the repo root/)
    await expect(
      assertSafeStagingRoot(dirname(join(import.meta.dirname, '..'))),
    ).rejects.toThrow(/contains the repo root/)
  })

  it('probes the Web shell and protects a real API request from untrusted hosts', () => {
    expect(webProbeRequests()).toEqual([
      { path: '/', method: 'GET' },
      {
        path: '/api/host.describe',
        method: 'POST',
        body: {
          type: 'client-request',
          rpcId: 'zimaos-runtime-probe',
          method: 'host.describe',
          payload: {},
        },
      },
    ])
    expect(untrustedHostProbeRequest()).toEqual(webProbeRequests()[1])
    expect(untrustedHostProbeRequest().path).not.toBe('/')
  })

  it('retries a real HTTP request until its acceptance condition is met', async () => {
    let attempts = 0
    await waitForHttpRequest(
      { path: '/api/host.describe', method: 'POST', body: {} },
      '127.0.0.1:3080',
      response => response.status === 200,
      async () => ({ status: ++attempts === 2 ? 200 : 404, body: '' }),
    )
    expect(attempts).toBe(2)
  })

  it('pins SquashFS ownership and creation time', () => {
    expect(squashFsArgs('/staging', '/output.raw', 123)).toEqual([
      '/staging',
      '/output.raw',
      '-noappend',
      '-no-xattrs',
      '-all-root',
      '-mkfs-time',
      '123',
    ])
  })
})

function validStagedRoot(): string {
  const root = temporaryRoot()
  createFile(
    join(
      root,
      'usr/lib/extension-release.d/extension-release.deepseek_harness',
    ),
    'ID=_any\n',
  )
  createFile(join(root, 'usr/bin/dsh'), '#!/bin/sh\n')
  createFile(
    join(root, 'usr/lib/systemd/system/deepseek-harness.service'),
    [
      '[Service]',
      'ExecStart=/usr/bin/dsh web --patch /usr/lib/deepseek-harness/zimaos.patch.yml --no-open',
      '',
    ].join('\n'),
  )
  createFile(
    join(root, 'usr/share/casaos/www/modules/deepseek_harness/index.html'),
    '<!doctype html>',
  )
  createFile(
    join(root, 'usr/share/casaos/www/modules/deepseek_harness/appicon.svg'),
    '<svg/>',
  )
  createFile(
    join(root, 'usr/share/casaos/modules/deepseek_harness.json'),
    JSON.stringify({
      name: 'deepseek_harness',
      ui: {
        name: 'deepseek_harness',
        entry: '/modules/deepseek_harness/index.html',
        icon: '/modules/deepseek_harness/appicon.svg',
      },
      services: [{ name: 'deepseek-harness' }],
    }),
  )
  return root
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-zimaos-raw-'))
  roots.push(root)
  return root
}

function createFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}
