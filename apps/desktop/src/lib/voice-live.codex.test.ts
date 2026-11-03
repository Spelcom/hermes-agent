import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/hermes'

import { VoiceLiveSession } from './voice-live'
vi.mock('@/lib/sibling-ws-url', () => ({
  resolveSiblingWsUrl: vi.fn(async () => 'ws://owner/api/audio/voice-live/calls/c1?native_dial=1&ticket=private-once')
}))

class Channel extends EventTarget {
  readyState = 'open'
  sent: unknown[] = []
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close = vi.fn()
  receive(event: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
}

class Lease extends EventTarget {
  static OPEN = 1
  readyState = 1
  static created: Lease[] = []
  sent: unknown[] = []
  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    super()
    Lease.created.push(this)
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }
  send(data: string) {
    const event = JSON.parse(data)
    this.sent.push(event)

    if (event.type === 'authenticate') {
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'lease.ready' }) }))
      )
    }
  }
  close = vi.fn()
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setApiRequestConnection(null)
  setApiRequestProfile(null)
  Lease.created = []
})

function setup() {
  const channel = new Channel()
  const transceiver = vi.fn()
  const track = { enabled: true, stop: vi.fn() }
  const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }))
  vi.stubGlobal(
    'RTCPeerConnection',
    class extends EventTarget {
      iceGatheringState = 'complete'
      localDescription = { sdp: 'offer' }
      createDataChannel = () => channel
      createOffer = async () => ({})
      setLocalDescription = async () => undefined
      setRemoteDescription = async () => undefined
      addTrack = vi.fn()
      addTransceiver = transceiver
      close = vi.fn()
    }
  )
  vi.stubGlobal('WebSocket', Lease)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })

  const api = vi.fn(async (_request: unknown) => ({
    ok: true,
    wire_protocol: 'codex-v3',
    call_id: 'c1',
    call_token: 'call-secret',
    session_id: 'runtime-owner',
    session: { id: 'native' },
    transport: { sdp: 'answer' }
  }))

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })

  return { channel, api, getUserMedia, transceiver, track }
}

describe('native Codex live conversation', () => {
  it('pins its owner/session, replies to the exact delegation, and releases mic and lease', async () => {
    const { channel, api, track } = setup()
    const onDelegation = vi.fn()

    const session = new VoiceLiveSession(
      { onDelegation, onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    await session.start([], 'runtime-owner')
    expect(api.mock.calls[0]).toEqual([
      expect.objectContaining({
        connectionId: 'office',
        profile: 'worker',
        body: { history: [], sdp: 'offer', session_id: 'runtime-owner' }
      })
    ])
    const lease = Lease.created[0]
    expect(lease.url).not.toContain('ticket=')
    expect(lease.url).not.toContain('call-secret')
    expect(lease.protocols).toContain('hermes-gateway-ticket.private-once')
    expect(lease.sent[0]).toEqual({ type: 'authenticate', call_token: 'call-secret', session_id: 'runtime-owner' })
    channel.receive({
      type: 'delegation.created',
      item: { id: 'd1', content: [{ type: 'input_text', text: 'Проверь сервер' }] }
    })
    channel.receive({ type: 'delegation.created', item: { id: 'd1' } })
    expect(onDelegation).toHaveBeenCalledTimes(1)
    expect(onDelegation).toHaveBeenCalledWith('d1', [], 'Проверь сервер')
    session.speak('d1', 'Сервер работает.')
    expect(channel.sent.at(-1)).toEqual({
      type: 'delegation.context.append',
      delegation_item_id: 'd1',
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'Сервер работает.' }]
    })
    setApiRequestConnection('unrelated')
    setApiRequestProfile('other')
    session.setMuted(true)
    expect(track.enabled).toBe(false)
    session.close()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(lease.close).toHaveBeenCalledOnce()
    expect(api.mock.calls.at(-1)).toEqual([
      expect.objectContaining({
        connectionId: 'office',
        profile: 'worker',
        path: '/api/audio/voice-live/calls/c1/close',
        body: { call_token: 'call-secret', session_id: 'runtime-owner' }
      })
    ])
    channel.receive({ type: 'delegation.created', item: { id: 'late' } })
    expect(onDelegation).toHaveBeenCalledTimes(1)
  })
  it('negotiates receive-only audio for the check without opening the microphone', async () => {
    const { getUserMedia, transceiver } = setup()

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    await session.start([], 'runtime-owner', { microphone: false })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(transceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' })
    session.close()
  })
})
