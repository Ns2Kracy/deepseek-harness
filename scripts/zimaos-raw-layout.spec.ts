import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rawRoot = resolve(import.meta.dirname, '../zimaos/raw')
const launcherPath = 'usr/bin/deepseek-harness'
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
    expect(service).toContain('ExecStart=/usr/bin/deepseek-harness')
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
    expect(launcher).toContain('state=${DSH_HOME:-/var/lib/casaos/deepseek_harness}')
    expect(launcher).toContain('install -d -m 0700 "$state"')
    expect(launcher).toContain('= "--staged-root" ]')
    expect(launcher).toContain('exec "$root/usr/lib/deepseek-harness/node/bin/node"')
    expect(launcher).toContain('"$root/usr/lib/deepseek-harness/app/node_modules/@deepseek-ai/dsh/lib/bin.js"')
    expect(launcher).toContain('set -- web --patch "$root/usr/lib/deepseek-harness/zimaos.patch.yml" --port 3080 --no-open')
    expect(launcher).toContain('set -- "$@" --trusted-host "$DSH_ZIMAOS_TRUSTED_HOST"')
    expect(launcher).toContain('"$@"')
    expect(launcher).not.toContain('--host 0.0.0.0')
    expect(overlay).toContain('- id: webserver')
    expect(overlay).toContain('host: 0.0.0.0')
    expect(overlay).toContain('port: !!js ctx.webStartup.port ?? 3080')
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
