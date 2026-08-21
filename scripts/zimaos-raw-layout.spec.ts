import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyRuntimeClosure } from './verify-runtime-closure.ts'

const rawRoot = resolve(import.meta.dirname, '../zimaos/raw')
const launcherPath = 'usr/bin/dsh'
const overlayPath = 'usr/lib/deepseek-harness/zimaos.patch.yml'
const extensionReleasePath = 'usr/lib/extension-release.d/extension-release.deepseek_harness'
const servicePath = 'usr/lib/systemd/system/deepseek-harness.service'
const modulePath = 'usr/share/casaos/modules/deepseek_harness.json'
const pagePath = 'usr/share/casaos/www/modules/deepseek_harness/index.html'
const iconPath = 'usr/share/casaos/www/modules/deepseek_harness/appicon.svg'

interface CasaOsModule {
  name: string
  services: Array<{ name: string }>
  ui: {
    entry: string
    icon: string
    name: string
  }
}

describe('ZimaOS RAW source layout', () => {
  it('declares a closed production workspace-peer graph', async () => {
    const result = await verifyRuntimeClosure(
      resolve(import.meta.dirname, '..'),
      'zimaos/runtime/package.json',
      {
        checkPresetPlugins: false,
        requireExplicitWorkspacePeers: false,
      },
    )

    expect(result.failures).toEqual([])
    expect(result.workspacePackageCount).toBeGreaterThan(1)
  })

  it('declares one consistent extension, service, and CasaOS module identity', async () => {
    const extensionRelease = await fixture(extensionReleasePath)
    const service = await fixture(servicePath)
    const module = JSON.parse(await fixture(modulePath)) as CasaOsModule

    expect(extensionRelease.trim()).toBe('ID=_any')
    expect(module.name).toBe('deepseek_harness')
    expect(module.services).toEqual([{ name: 'deepseek-harness' }])
    expect(module.ui.name).toBe('deepseek_harness')
    expect(module.ui.entry).toBe('/modules/deepseek_harness/index.html')
    expect(module.ui.icon).toBe('/modules/deepseek_harness/appicon.svg')
    expect(service).toContain(
      'ExecStart=/usr/bin/dsh web --patch /usr/lib/deepseek-harness/zimaos.patch.yml --no-open',
    )
    expect(service).toContain('Environment=DSH_HOME=/var/lib/casaos/deepseek_harness')
    expect(service).toContain('EnvironmentFile=-/var/lib/casaos/deepseek_harness/.env')
    expect(service).toContain('After=network-online.target')
    expect(service).toContain('Wants=network-online.target')
    expect(service).toContain('Restart=on-failure')
  })

  it('launches the bundled Web profile with only the ZimaOS overlay exposing it', async () => {
    const launcher = await fixture(launcherPath)
    const overlay = await fixture(overlayPath)

    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true)
    expect(launcher).toContain('root=${DSH_ZIMAOS_STAGED_ROOT:-}')
    expect(launcher).toContain(
      'exec "$root/usr/lib/deepseek-harness/node/bin/node"',
    )
    expect(launcher).toContain(
      '"$root/usr/lib/deepseek-harness/app/node_modules/@deepseek-ai/dsh/lib/bin.js"',
    )
    expect(launcher).toContain('"$@"')
    expect(launcher).not.toContain('DSH_HOME')
    expect(launcher).not.toContain('zimaos.patch.yml')
    expect(launcher).not.toContain('--no-open')
    expect(launcher).not.toContain('--host 0.0.0.0')
    expect(overlay).toContain('- id: webserver')
    expect(overlay).toContain('host: 0.0.0.0')
    expect(overlay).toContain('port: !!js ctx.webStartup.port ?? 3080')
    expect(overlay).toContain('- id: web-runtime')
    expect(overlay).toContain('openBrowser: !!js ctx.webStartup.openBrowser')
    expect(overlay).toContain('DSH_ZIMAOS_TRUSTED_HOST')
    expect(overlay).toContain('...ctx.webStartup.trustedHosts')
  })

  it('provides a no-cache launcher page and SVG icon', async () => {
    const page = await fixture(pagePath)
    const icon = await fixture(iconPath)

    expect(page).toContain('http-equiv="Cache-Control"')
    expect(page).toContain('no-store')
    expect(page).toContain('location.hostname')
    expect(page).toContain(':3080/')
    expect(page).toContain('location.replace(')
    expect(icon).toContain('<svg')
  })

  it('does not register a CasaOS Gateway route or depend on its message bus', async () => {
    const contents = await Promise.all([
      launcherPath,
      overlayPath,
      servicePath,
      modulePath,
      pagePath,
    ].map(fixture))

    for (const content of contents) {
      expect(content).not.toMatch(/casaos-(?:gateway|message-bus)|gateway\/route|register.*gateway/i)
    }
  })
})

async function fixture(path: string): Promise<string> {
  return readFile(resolve(rawRoot, path), 'utf8')
}
