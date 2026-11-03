import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/hermes'
import { applyVoiceOutputGain } from '@/store/voice-output'

import { VoiceLiveSession } from './voice-live'
vi.mock('@/lib/voice-live-call-url', () => ({
  resolveVoiceLiveCallUrl: vi.fn(
    async () => 'ws://owner/api/audio/voice-live/calls/c1?native_dial=1&ticket=private-once'
  )
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setApiRequestConnection(null)
  setApiRequestProfile(null)
  Lease.created = []
})

function setup() {
  const channel = new Channel()
  const peers: EventTarget[] = []
  const transceiver = vi.fn()
  const addTrack = vi.fn()
  const silentTrack = { stop: vi.fn() }
  const silentStream = { getAudioTracks: () => [silentTrack], getTracks: () => [silentTrack] }
  const silentSource = { offset: { value: 1 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() }

  const silentContext = {
    createConstantSource: () => silentSource,
    createMediaStreamDestination: () => ({ stream: silentStream }),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  }

  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return silentContext
      }
    }
  )
  const track = { enabled: true, stop: vi.fn() }
  const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }))
  vi.stubGlobal(
    'RTCPeerConnection',
    class extends EventTarget {
      constructor() {
        super()
        peers.push(this)
      }
      iceGatheringState = 'complete'
      localDescription = { sdp: 'offer' }
      createDataChannel = () => channel
      createOffer = async () => ({})
      setLocalDescription = async () => undefined
      setRemoteDescription = async () => undefined
      addTrack = addTrack
      addTransceiver = transceiver
      close = vi.fn()
    }
  )
  vi.stubGlobal('WebSocket', Lease)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })

  const api = vi.fn(async (_request: unknown) => ({
    ok: true,
    wire_protocol: 'codex-v3',
    output_gain: 2,
    call_id: 'c1',
    call_token: 'call-secret',
    session_id: 'runtime-owner',
    session: { id: 'native' },
    transport: { sdp: 'answer' }
  }))

  const requestMicrophoneAccess = vi.fn(async () => true)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api, requestMicrophoneAccess } })

  return {
    peers,
    channel,
    api,
    getUserMedia,
    transceiver,
    track,
    addTrack,
    silentTrack,
    silentStream,
    silentSource,
    silentContext,
    requestMicrophoneAccess
  }
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
  it('honors mute selected while capture is pending before attaching any microphone track', async () => {
    const { getUserMedia, track, addTrack } = setup()
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
    let resolveCapture: (value: typeof stream) => void = () => undefined
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveCapture = resolve
        })
    )

    const attachedEnabled: boolean[] = []
    addTrack.mockImplementation((attached: typeof track) => {
      attachedEnabled.push(attached.enabled)
    })

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    try {
      const pending = session.start([], 'runtime-owner')
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
      session.setMuted(true)
      resolveCapture(stream)
      await pending
      expect(addTrack).toHaveBeenCalledWith(track, stream)
      expect(attachedEnabled).toEqual([false])
      expect(track.enabled).toBe(false)
      session.setMuted(false)
      expect(track.enabled).toBe(true)
      session.setMuted(true)
      expect(track.enabled).toBe(false)
    } finally {
      session.close()
    }
  })

  it('reports only the numeric close code when the native lease is refused', async () => {
    setup()
    vi.spyOn(Lease.prototype, 'send').mockImplementation(function (this: Lease) {
      queueMicrotask(() =>
        this.dispatchEvent(new CloseEvent('close', { code: 4403, reason: 'private details must not escape' }))
      )
    })

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    await expect(session.start([], 'runtime-owner')).rejects.toThrow('Codex voice connection closed (code 4403)')
    session.close()
  })

  it('honors native microphone denial before browser capture or broker startup', async () => {
    const { requestMicrophoneAccess, getUserMedia, api } = setup()
    requestMicrophoneAccess.mockResolvedValueOnce(false)

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    await expect(session.start([], 'runtime-owner')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
    session.close()
  })

  it('does not open browser capture if the owned call closes while native permission is pending', async () => {
    const { requestMicrophoneAccess, getUserMedia, api } = setup()
    let allow: (permitted: boolean) => void = () => undefined
    requestMicrophoneAccess.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          allow = resolve
        })
    )

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    const pending = session.start([], 'runtime-owner')
    session.close()
    allow(true)
    await pending
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('distinguishes a pending native permission response from a pending browser capture', async () => {
    vi.useFakeTimers()
    const { requestMicrophoneAccess, getUserMedia, api } = setup()
    requestMicrophoneAccess.mockImplementationOnce(() => new Promise(() => undefined))

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    const failed = expect(session.start([], 'runtime-owner')).rejects.toThrow(
      'Система не ответила на запрос доступа к микрофону за 60 секунд'
    )

    await vi.advanceTimersByTimeAsync(60_000)
    await failed
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('bounds a pending microphone request and stops a late track without creating a broker call', async () => {
    vi.useFakeTimers()
    const { getUserMedia, api, track } = setup()

    let permit: (stream: { getAudioTracks: () => (typeof track)[]; getTracks: () => (typeof track)[] }) => void = () =>
      undefined

    getUserMedia.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          permit = resolve
        })
    )

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    const pending = session.start([], 'runtime-owner')
    const failed = expect(pending).rejects.toThrow('Запрос записи с микрофона не завершился за 60 секунд')
    await vi.advanceTimersByTimeAsync(60_000)
    await failed
    permit({ getAudioTracks: () => [track], getTracks: () => [track] })
    await Promise.resolve()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(api).not.toHaveBeenCalled()
  })

  it('sends synthetic zero audio for the check and releases its own source, track and context', async () => {
    const {
      getUserMedia,
      transceiver,
      addTrack,
      silentTrack,
      silentStream,
      silentSource,
      silentContext,
      requestMicrophoneAccess
    } = setup()

    const session = new VoiceLiveSession(
      { onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() },
      { connectionId: 'office', profile: 'worker' }
    )

    await session.start([], 'runtime-owner', { microphone: false })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(requestMicrophoneAccess).not.toHaveBeenCalled()
    expect(transceiver).not.toHaveBeenCalled()
    expect(addTrack).toHaveBeenCalledWith(silentTrack, silentStream)
    expect(silentSource.offset.value).toBe(0)
    expect(silentSource.start).toHaveBeenCalledOnce()
    expect(silentContext.resume).toHaveBeenCalledOnce()
    session.close()
    expect(silentSource.stop).toHaveBeenCalledOnce()
    expect(silentSource.disconnect).toHaveBeenCalledOnce()
    expect(silentTrack.stop).toHaveBeenCalledOnce()
    expect(silentContext.close).toHaveBeenCalledOnce()
  })
})

it('applies worker gain to the remote audio path, keeps mic mute independent and releases output on close', async () => {
  const { peers, track } = setup()
  const nodes = Array.from({ length: 5 }, () => ({ connect: vi.fn(), disconnect: vi.fn() }))
  const [source, gainNode, compressorNode, limiterNode, analyserNode] = nodes
  const param = () => ({ value: 0 })
  const gain = { ...gainNode, gain: { value: 1, setTargetAtTime: vi.fn() } }

  const analyser = {
    ...analyserNode,
    frequencyBinCount: 256,
    getByteTimeDomainData: vi.fn((buffer: Uint8Array) => buffer.fill(128))
  }

  const context = {
    createMediaStreamSource: () => source,
    createGain: () => gain,
    createDynamicsCompressor: () => ({
      ...compressorNode,
      threshold: param(),
      knee: param(),
      ratio: param(),
      attack: param(),
      release: param()
    }),
    createWaveShaper: () => limiterNode,
    createAnalyser: () => analyser,
    destination: {},
    currentTime: 1,
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  }

  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context
      }
    }
  )
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    }
  )
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  const owner = { connectionId: 'gain-lifecycle', profile: 'yuki' }
  const session = new VoiceLiveSession({ onDelegation: vi.fn(), onClosed: vi.fn(), onError: vi.fn() }, owner)
  await session.start([], 'runtime-owner')
  peers[0].dispatchEvent(Object.assign(new Event('track'), { track: {} }))
  expect(session.audio.muted).toBe(true)
  expect(gain.gain.value).toBe(2)
  applyVoiceOutputGain(owner, 2)
  expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(2, 1, 0.01)
  session.setMuted(true)
  expect(track.enabled).toBe(false)
  expect(gain.gain.setTargetAtTime).toHaveBeenCalledTimes(1)
  session.close()
  session.close()
  expect(context.close).toHaveBeenCalledOnce()

  for (const node of nodes) {
    expect(node.disconnect).toHaveBeenCalledOnce()
  }

  expect(session.audio.srcObject).toBeNull()
  applyVoiceOutputGain(owner, 3)
  expect(gain.gain.setTargetAtTime).toHaveBeenCalledTimes(1)
  peers[0].dispatchEvent(Object.assign(new Event('track'), { track: {} }))
  expect(session.audio.srcObject).toBeNull()
})
