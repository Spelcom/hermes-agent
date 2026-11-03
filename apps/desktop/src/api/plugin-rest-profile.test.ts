import { afterEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/hermes'

import { pluginRestProfile } from './plugins'

const route = { connectionId: 'office', mode: 'remote' as const, profile: 'worker-alias', targetProfile: 'worker' }
afterEach(() => {
  setApiRequestConnection(null)
  setApiRequestProfile(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

it('pins the backend owner and plugin namespace even while the active profile changes', async () => {
  const api = vi.fn(async () => ({ ok: true }))
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })
  setApiRequestConnection('unrelated')
  setApiRequestProfile('other-worker')
  await pluginRestProfile('kontora', route, '/objects', { method: 'POST', body: { kind: 'document' } })
  expect(api).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: 'office',
      profile: 'worker',
      path: '/api/plugins/kontora/objects',
      method: 'POST',
      body: { kind: 'document' }
    })
  )
})

it('rejects namespace escapes and incomplete routes before any native request', async () => {
  const api = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })

  for (const path of ['/../audio/voice-live/session', '/%2e%2e/audio', '/%2e%2e%2faudio']) {
    await expect(pluginRestProfile('kontora', route, path)).rejects.toThrow('path traversal')
  }

  await expect(pluginRestProfile('kontora', { ...route, connectionId: '' }, '/objects')).rejects.toThrow(
    'exact connection'
  )
  expect(api).not.toHaveBeenCalled()
})
