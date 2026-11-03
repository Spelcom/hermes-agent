import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  api: vi.fn(),
  start: vi.fn(),
  utterance: undefined as undefined | ((audio: Blob) => void),
  stops: [] as ReturnType<typeof vi.fn>[]
}))

vi.mock('@/api/client', () => ({ hermesApiAs: fake.api }))
vi.mock('@/app/session/hooks/use-prompt-actions/utils', () => ({
  blobToDataUrl: async () => 'data:audio/wav;base64,AA=='
}))
vi.mock('@/lib/wake-client-capture', () => ({ startClientWakeCapture: fake.start }))
vi.mock('@/lib/canvas-voice-pcm', () => ({
  createCanvasUtterances: (callback: (audio: Blob) => void) => {
    fake.utterance = callback

    return { feed: vi.fn(), stop: vi.fn() }
  }
}))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: vi.fn() }))
vi.mock('@/store/wake-word', () => ({ $wakeWord: { get: () => ({ listening: false }) }, stopClientCapture: vi.fn() }))

import { canvasVoice } from './canvas-voice'
import { $voicePlayback } from './voice-playback'

const route = { connectionId: 'local-a', profile: 'default', targetProfile: 'default', mode: 'local' as const }
const target = { ...route, profile: 'analyst', targetProfile: 'analyst' }

const config = {
  stt: { enabled: true, provider: 'whisper_cpp_local', providers: { whisper_cpp_local: { type: 'command' } } }
}

const options = { listenerRoute: route, targets: [{ id: 'ren' as const, route: target }] }

const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  fake.api.mockReset().mockResolvedValue(config)
  fake.start.mockReset().mockImplementation(async () => {
    const stop = vi.fn()
    fake.stops.push(stop)

    return { active: true, stop }
  })
  fake.stops = []
  Object.assign(window, {
    hermesDesktop: { getProfileRoutes: vi.fn(async () => [route]), requestMicrophoneAccess: vi.fn(async () => true) }
  })
})
afterEach(() => {
  canvasVoice.disable()
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('is off by default and validates local ownership/provider before opening a microphone', async () => {
  expect(canvasVoice.state.get().enabled).toBe(false)
  expect(fake.start).not.toHaveBeenCalled()
  fake.api.mockResolvedValueOnce({ stt: { enabled: true, provider: 'openai' } })
  await canvasVoice.enable(options)
  expect(canvasVoice.state.get().phase).toBe('error')
  expect(fake.start).not.toHaveBeenCalled()
  await expect(canvasVoice.enable({ ...options, listenerRoute: { ...route, mode: 'remote' } })).rejects.toThrow(
    'never uploads'
  )
})
it('OFF during permission opening closes a late stream and never reports listening', async () => {
  let opened!: (value: { active: boolean; stop: ReturnType<typeof vi.fn> }) => void
  fake.start.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        opened = resolve
      })
  )
  const pending = canvasVoice.enable(options)
  await tick()
  await tick()
  expect(canvasVoice.state.get().enabled).toBe(true)
  canvasVoice.disable()
  const stop = vi.fn()
  opened({ active: true, stop })
  await pending
  expect(stop).toHaveBeenCalledOnce()
  expect(canvasVoice.state.get().phase).toBe('off')
})
it('drops ambient transcripts and emits a matched exact route once; sequence survives OFF/ON', async () => {
  const listener = vi.fn()
  const unsubscribe = canvasVoice.onCommand(listener)
  await canvasVoice.enable(options)
  fake.api.mockResolvedValueOnce({ transcript: 'a private ambient sentence' })
  fake.utterance!(new Blob(['pcm']))
  await tick()
  expect(listener).not.toHaveBeenCalled()
  fake.api.mockResolvedValueOnce({ transcript: 'Рен, проверь задачу' })
  fake.utterance!(new Blob(['pcm']))
  await tick()
  expect(listener).toHaveBeenCalledOnce()
  const first = listener.mock.calls[0][0]
  expect(first).toMatchObject({ route: target, text: 'проверь задачу' })
  expect(fake.api.mock.calls.at(-1)).toMatchObject([
    { connectionId: 'local-a', profile: 'default' },
    { body: { local_only: true } }
  ])
  await vi.advanceTimersByTimeAsync(3000)
  canvasVoice.disable()
  await canvasVoice.enable(options)
  fake.api.mockResolvedValueOnce({ transcript: 'Ren' })
  fake.utterance!(new Blob(['pcm']))
  await tick()
  expect(listener.mock.calls[1][0].sequence).toBeGreaterThan(first.sequence)
  expect(listener.mock.calls[1][0].text).toBe('')
  unsubscribe()
})
it('pauses for native ownership and TTS; releases are idempotent, OFF prevents a late rearm', async () => {
  await canvasVoice.enable(options)
  const release = canvasVoice.pause()
  expect(fake.stops[0]).toHaveBeenCalledOnce()
  expect(canvasVoice.state.get().phase).toBe('paused')
  release()
  release()
  await tick()
  expect(fake.start).toHaveBeenCalledTimes(2)
  $voicePlayback.set({ ...$voicePlayback.get(), status: 'speaking' })
  expect(canvasVoice.state.get().phase).toBe('paused')
  canvasVoice.disable()
  $voicePlayback.set({ ...$voicePlayback.get(), status: 'idle' })
  await tick()
  expect(fake.start).toHaveBeenCalledTimes(2)
})
it('discard a late transcription after OFF without command or model request', async () => {
  await canvasVoice.enable(options)
  let resolve!: (value: { transcript: string }) => void
  fake.api.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const listener = vi.fn()
  const unsubscribe = canvasVoice.onCommand(listener)
  fake.utterance!(new Blob(['pcm']))
  await tick()
  canvasVoice.disable()
  resolve({ transcript: 'Ren secret' })
  await tick()
  expect(listener).not.toHaveBeenCalled()
  expect(canvasVoice.state.get().phase).toBe('off')
  unsubscribe()
})

it('fails closed on an unregistered local source before any microphone request', async () => {
  vi.mocked(window.hermesDesktop.getProfileRoutes).mockResolvedValueOnce([{ ...route, mode: 'remote' }])
  await canvasVoice.enable(options)
  expect(canvasVoice.state.get().phase).toBe('error')
  expect(fake.start).not.toHaveBeenCalled()
  expect(fake.api).not.toHaveBeenCalled()
})
it('OFF cancels an in-flight readiness check; native pause cannot bypass provider validation', async () => {
  let resolve!: (value: typeof config) => void
  fake.api.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const pending = canvasVoice.enable(options)
  await tick()
  const release = canvasVoice.pause()
  release()
  expect(fake.start).not.toHaveBeenCalled()
  canvasVoice.disable()
  resolve(config)
  await pending
  expect(fake.start).not.toHaveBeenCalled()
  expect(canvasVoice.state.get().phase).toBe('off')
})
