import { expect, test, vi } from 'vitest'

import { createLocalGatewayDials, type GatewayEndpoint } from './local-gateway'
import { createVoiceLiveCallWsUrlHandler, voiceLiveCallPath } from './voice-live-call-ws'

const endpoint = { api_origin: 'http://127.0.0.1:9', control_home: null, profile_id: '/home/u/.hermes' } as unknown as GatewayEndpoint

test('native voice lease grant strips Origin only on its exact path, origin, window and profile, once', () => {
  const dials = createLocalGatewayDials()
  const dial = new URL(dials.prepareVoiceCall('http://127.0.0.1:9', 'call_1-a', 'private-ticket', 7, 'worker'))
  expect(dial.pathname).toBe('/api/audio/voice-live/calls/call_1-a')
  expect(dial.searchParams.get('profile')).toBe('worker')
  dial.searchParams.delete('ticket')
  const url = dial.toString()
  const details = { url, webContentsId: 7, resourceType: 'webSocket', requestHeaders: { Origin: 'file://', 'Sec-WebSocket-Protocol': 'hermes-gateway-v1, hermes-gateway-ticket.private-ticket' } }
  expect(dials.headers({ ...details, webContentsId: 8 })).toBeNull()
  expect(dials.headers({ ...details, url: url.replace('call_1-a', 'another') })).toBeNull()
  expect(dials.headers({ ...details, url: url.replace('profile=worker', 'profile=other') })).toBeNull()
  expect(dials.headers({ ...details, url: url.replace('127.0.0.1:9', '127.0.0.1:10') })).toBeNull()
  expect(dials.headers({ ...details, url: url.replace('ws://', 'wss://') })).toBeNull()
  const headers = dials.headers(details)!
  expect(headers).not.toHaveProperty('Origin')
  expect(headers['Sec-WebSocket-Protocol']).toContain('hermes-gateway-ticket.private-ticket')
  expect(dials.headers(details)).toBeNull()
})

test('voice call identity cannot select another core path or inject a query', () => {
  expect(voiceLiveCallPath('abc_123-Z')).toBe('/api/audio/voice-live/calls/abc_123-Z')

  for (const value of ['', '../ws', 'a/b', '%2f', 'a?profile=other', 'a#x', null, 'a'.repeat(129)]) {
    expect(() => voiceLiveCallPath(value)).toThrow('Invalid voice call identity')
  }
})

test('mints the interactive ticket for the exact registry owner and native lease path', async () => {
  const mint = vi.fn(async () => 'private-ticket')
  const dials = createLocalGatewayDials()
  const ensureBackend = vi.fn()
  const ensureRegistryBackend = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9', gatewayEndpoint: endpoint }))
  const handler = createVoiceLiveCallWsUrlHandler({ ensureBackend, ensureRegistryBackend, forgetLocalGatewayDescriptor: vi.fn(), forgetRegistryLocalGatewayDescriptor: vi.fn(), launchHome: '/home/u/.hermes', mint, prepare: dials.prepareVoiceCall })
  const result = new URL((await handler({ connectionId: 'office', profile: 'default', callId: 'call-1' }, 7))!)
  expect(ensureRegistryBackend).toHaveBeenCalledWith('office', 'default')
  expect(ensureBackend).not.toHaveBeenCalled()
  expect(mint).toHaveBeenCalledWith(expect.objectContaining({ profile_id: '/home/u/.hermes' }), 'interactive')
  expect(result.pathname).toBe('/api/audio/voice-live/calls/call-1')
  expect(result.searchParams.get('profile')).toBe('default')
})

test('remote routes keep remote auth and a registry failure never launches a local backend', async () => {
  const ensureBackend = vi.fn()
  const ensureRegistryBackend = vi.fn(async () => ({ baseUrl: 'https://remote.example' }))
  const mint = vi.fn()
  const handler = createVoiceLiveCallWsUrlHandler({ ensureBackend, ensureRegistryBackend, forgetLocalGatewayDescriptor: vi.fn(), forgetRegistryLocalGatewayDescriptor: vi.fn(), launchHome: '/home/u/.hermes', mint, prepare: vi.fn() })
  await expect(handler({ connectionId: 'remote', profile: 'worker', callId: 'call-2' }, 7)).resolves.toBeNull()
  ensureRegistryBackend.mockRejectedValueOnce(new Error('Remote unavailable'))
  await expect(handler({ connectionId: 'remote', profile: 'worker', callId: 'call-2' }, 7)).rejects.toThrow('Remote unavailable')
  expect(ensureBackend).not.toHaveBeenCalled()
  expect(mint).not.toHaveBeenCalled()
})
