import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'

import { signKontoraLocalMacApp } from './kontora-local-sign.mjs'
import { createMacSigner } from './mac-sign.mjs'

test('local signing is opt-in and refuses a competing certificate or later fuse mutation', async () => {
  const sign = vi.fn()
  const context = { electronPlatformName: 'darwin', appOutDir: '/local',
    packager: { appInfo: { productFilename: 'Hermes' }, config: { mac: { sign } } } }
  await signKontoraLocalMacApp(context, {})
  await signKontoraLocalMacApp({ ...context, electronPlatformName: 'linux' }, { KONTORA_ADHOC_SIGN: '1' })
  expect(sign).not.toHaveBeenCalled()
  await expect(signKontoraLocalMacApp(context, { KONTORA_ADHOC_SIGN: '1' }))
    .rejects.toThrow('CSC_IDENTITY_AUTO_DISCOVERY=false')
  context.packager.config.electronFuses = { runAsNode: false }
  await expect(signKontoraLocalMacApp(context, { KONTORA_ADHOC_SIGN: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }))
    .rejects.toThrow('after fuse changes')
  expect(sign).not.toHaveBeenCalled()
})

test('personal builds use the existing signer, hardened entitlements and strict ad-hoc verification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kontora-local-sign-'))
  try {
    const app = path.join(root, 'Ciel.app')
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true })
    const icon = path.join(app, 'Contents', 'Resources', 'icon.icns')
    fs.writeFileSync(icon, 'personal-icon')
    const policy = { entitlements: 'repo-app.plist', entitlementsInherit: 'repo-child.plist',
      hardenedRuntime: true, ignore: () => false }
    const nativeSign = vi.fn(async opts => {
      expect(opts.app).toBe(app)
      expect(opts.identity).toBe('-')
      expect(opts.strictVerify).toBe(true)
      expect(opts.preAutoEntitlements).toBe(false)
      expect(opts.preEmbedProvisioningProfile).toBe(false)
      expect(opts.optionsForFile(app)).toEqual({ entitlements: policy.entitlements,
        hardenedRuntime: true, timestamp: 'none' })
      expect(opts.optionsForFile(path.join(app, 'Contents', 'Frameworks', 'Helper.app')))
        .toEqual({ entitlements: policy.entitlementsInherit, hardenedRuntime: true, timestamp: 'none' })
    })
    const team = vi.fn()
    const signer = createMacSigner(policy, { sign: nativeSign, team,
      env: { HERMES_MAC_SIGNATURE_CACHE: '/must-not-use-release-cache' } })
    const packager = { appInfo: { productFilename: 'Ciel' }, config: { mac: { sign: signer } },
      helper: { getOptionsForFile: async (_app, _target, declared) => file => ({
        entitlements: file === app ? declared.entitlements : declared.entitlementsInherit,
        hardenedRuntime: declared.hardenedRuntime
      }) } }
    await signKontoraLocalMacApp({ electronPlatformName: 'darwin', appOutDir: root, packager },
      { KONTORA_ADHOC_SIGN: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    expect(nativeSign).toHaveBeenCalledOnce()
    expect(team).not.toHaveBeenCalled()
    expect(fs.readFileSync(icon, 'utf8')).toBe('personal-icon')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
