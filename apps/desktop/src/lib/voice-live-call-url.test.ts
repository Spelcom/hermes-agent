import { afterEach, expect, test, vi } from 'vitest'

import { resolveVoiceLiveCallUrl } from './voice-live-call-url'
const fake = vi.hoisted(() => ({ sibling: vi.fn() }))
vi.mock('@/lib/sibling-ws-url', () => ({ resolveSiblingWsUrl: fake.sibling }))
afterEach(() => { Reflect.deleteProperty(window, 'hermesDesktop'); fake.sibling.mockReset() })
test('uses the exact-owner path-bound native bridge without rewriting a gateway dial', async () => {
  const getVoiceLiveCallWsUrl = vi.fn(async () => 'ws://owner/api/audio/voice-live/calls/c1?native_dial=n&profile=worker&ticket=t')
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { getVoiceLiveCallWsUrl } })
  const owner = { connectionId: 'office', profile: 'worker' }
  await expect(resolveVoiceLiveCallUrl(owner, 'c1')).resolves.toContain('/calls/c1?native_dial=n')
  expect(getVoiceLiveCallWsUrl).toHaveBeenCalledWith({ ...owner, callId: 'c1' })
  expect(fake.sibling).not.toHaveBeenCalled()
})
test('only a remote result may use the existing sibling URL auth route', async () => {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { getVoiceLiveCallWsUrl: vi.fn(async () => null) } })
  fake.sibling.mockResolvedValueOnce('wss://remote/api/audio/voice-live/calls/c1?ticket=fresh')
  await expect(resolveVoiceLiveCallUrl({ connectionId: 'remote', profile: 'worker' }, 'c1')).resolves.toContain('wss://remote/')
  fake.sibling.mockResolvedValueOnce('ws://local/api/audio/voice-live/calls/c1?native_dial=wrong-path-ticket')
  await expect(resolveVoiceLiveCallUrl({ connectionId: 'office', profile: 'worker' }, 'c1')).rejects.toThrow('cannot authorize')
})
