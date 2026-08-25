// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://192.0.2.20/" }
// Assembled trusted-LAN management snapshot: boots the real built client graph
// over the keyless fixture transport while the Host-injected connection
// capability marks a non-loopback page as management-enabled. The Models page
// must load Host-backed settings instead of the remote memory-mode error.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import {
  installAssembledBootEnv,
  mountAssembledApp,
  REFRESHING_GOLDEN,
} from './assembled-boot.ts'

const EXPECTED = join(
  process.cwd(),
  'apps/web/tests/snapshots/remote-management/models.expected.txt',
)

installAssembledBootEnv()

it('keeps provider settings unavailable on a remote page without Host opt-in', async () => {
  mountAssembledApp('?fixture')
  fireEvent.click(
    await screen.findByRole(
      'button',
      { name: 'Settings' },
      { timeout: 10_000 },
    ),
  )
  const dialog = await screen.findByRole(
    'dialog',
    { name: 'Settings' },
    { timeout: 10_000 },
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Models' }))
  await within(dialog).findByText(
    /settings are unavailable in this browser/,
    {},
    { timeout: 10_000 },
  )
})

it('opens Host-backed provider settings from a trusted-LAN page', async () => {
  mountAssembledApp('?fixture', true)
  fireEvent.click(
    await screen.findByRole(
      'button',
      { name: 'Settings' },
      { timeout: 10_000 },
    ),
  )
  const dialog = await screen.findByRole(
    'dialog',
    { name: 'Settings' },
    { timeout: 10_000 },
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Models' }))
  const output = [
    within(dialog).getByRole('heading', { name: 'Models' }).textContent,
    within(dialog).getByText(
      'Enter your API keys to use models from the following providers.',
    ).textContent,
    within(dialog).getByRole('button', { name: 'Add provider' }).textContent,
  ].join('\n')
  if (REFRESHING_GOLDEN) {
    mkdirSync(dirname(EXPECTED), { recursive: true })
    writeFileSync(EXPECTED, output)
  }
  await expect(output).toMatchFileSnapshot(EXPECTED)
})
