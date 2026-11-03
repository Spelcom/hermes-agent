import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { backgroundVoiceOwnership } from '@/lib/canvas-voice-ownership'

import { type MicRecorderErrorCopy, useMicRecorder } from './use-mic-recorder'

// The level meter behind continuous voice mode is an AudioContext on the
// capture stream. #75329: a torn-down context was still closing when the next
// take opened another, the device errored, and the dead meter silently
// dropped every later utterance.

const copy: MicRecorderErrorCopy = {
  microphoneAccessDenied: 'denied',
  microphoneConstraintsUnsupported: 'constraints',
  microphoneInUse: 'in use',
  microphonePermissionDenied: 'permission',
  microphoneStartFailed: 'start failed',
  microphoneUnsupported: 'unsupported',
  noMicrophone: 'no mic'
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => (resolve = done))

  return { promise, resolve }
}

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = []
  static throwOnConstruct = false
  state: AudioContextState = 'running'
  closing = deferred()

  constructor() {
    super()

    if (FakeAudioContext.throwOnConstruct) {
      throw new DOMException('too many contexts', 'NotSupportedError')
    }

    FakeAudioContext.instances.push(this)
  }

  createAnalyser() {
    return { fftSize: 0, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }
  }

  createMediaStreamSource() {
    return { connect: vi.fn() }
  }

  resume = vi.fn(async () => undefined)

  close() {
    return this.closing.promise.then(() => {
      this.state = 'closed'
      this.dispatchEvent(new Event('statechange'))
    })
  }
}

class FakeMediaRecorder {
  static isTypeSupported = () => true
  mimeType = 'audio/webm'
  state: RecordingState = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['clip'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

const flush = () => act(async () => new Promise<void>(resolve => window.setTimeout(resolve, 0)))

beforeEach(() => {
  FakeAudioContext.instances = []
  FakeAudioContext.throwOnConstruct = false
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) }
  })
})

afterEach(() => {
  cleanup()
  FakeAudioContext.instances.forEach(context => context.closing.resolve())
  vi.unstubAllGlobals()
})

describe('useMicRecorder level meter', () => {
  it('opens only one stream when start is repeated while permission is pending', async () => {
    const permission = deferred()
    const requestMicrophoneAccess = vi.fn(() => permission.promise.then(() => true))
    vi.stubGlobal('hermesDesktop', { requestMicrophoneAccess })
    const { result } = renderHook(() => useMicRecorder(copy))
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.handle.start()
      second = result.current.handle.start()
    })
    await act(async () => {
      permission.resolve()
      await Promise.all([first, second])
    })
    expect(requestMicrophoneAccess).toHaveBeenCalledOnce()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
    await act(async () => {
      await result.current.handle.stop()
    })
  })

  it('does not open a microphone when permission settles after unmount', async () => {
    const permission = deferred()
    vi.stubGlobal('hermesDesktop', { requestMicrophoneAccess: () => permission.promise.then(() => true) })
    const hook = renderHook(() => useMicRecorder(copy))
    let opening!: Promise<void>
    act(() => {
      opening = hook.result.current.handle.start()
    })
    hook.unmount()
    await act(async () => {
      permission.resolve()
      await opening
    })
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
  })

  it('stops a stream delivered after the pending recorder was cancelled', async () => {
    const device = deferred()
    const stopTrack = vi.fn()
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async () => {
      await device.promise

      return { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    })
    const hook = renderHook(() => useMicRecorder(copy))
    let opening!: Promise<void>
    act(() => {
      opening = hook.result.current.handle.start()
    })
    await flush()
    hook.unmount()
    await act(async () => {
      device.resolve()
      await opening
    })
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  it('waits for the previous take’s meter to finish closing before opening the next', async () => {
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start()
    })
    await act(async () => {
      await result.current.handle.stop()
    })

    const first = FakeAudioContext.instances[0]
    let secondStart: Promise<void> | undefined

    act(() => {
      secondStart = result.current.handle.start()
    })
    await flush()

    // Still closing: no second context on top of it.
    expect(FakeAudioContext.instances).toHaveLength(1)

    await act(async () => {
      first.closing.resolve()
      await secondStart
    })

    expect(FakeAudioContext.instances).toHaveLength(2)
    expect(first.state).toBe('closed')
  })

  it('reports a device error on the meter and marks the take meterFailed', async () => {
    const onMeterFailure = vi.fn()
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ onMeterFailure, onSilence: vi.fn(), silenceLevel: 0.075, silenceMs: 1_250 })
    })

    FakeAudioContext.instances[0].dispatchEvent(new Event('error'))
    await flush()

    expect(onMeterFailure).toHaveBeenCalledOnce()

    let recording: Awaited<ReturnType<typeof result.current.handle.stop>> = null

    await act(async () => {
      recording = await result.current.handle.stop()
    })

    expect(recording).toMatchObject({ heardSpeech: false, meterFailed: true })
  })

  it('treats a meter that cannot be built as failed instead of silently deaf', async () => {
    FakeAudioContext.throwOnConstruct = true
    const onMeterFailure = vi.fn()
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ onMeterFailure })
    })
    await flush()

    expect(onMeterFailure).toHaveBeenCalledOnce()
  })

  it('does not report its own close at the end of a take as a failure', async () => {
    const onMeterFailure = vi.fn()
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ onMeterFailure })
    })

    let recording: Awaited<ReturnType<typeof result.current.handle.stop>> = null

    await act(async () => {
      recording = await result.current.handle.stop()
      FakeAudioContext.instances[0].closing.resolve()
    })
    await flush()

    expect(onMeterFailure).not.toHaveBeenCalled()
    expect(recording).toMatchObject({ meterFailed: false })
  })
})

it('takes standby ownership before permission and releases it once on close, including late permission', async () => {
  const release = vi.fn()
  const pause = vi.fn(() => release)
  backgroundVoiceOwnership.register(pause)
  const permission = deferred()
  vi.stubGlobal('hermesDesktop', { requestMicrophoneAccess: () => permission.promise.then(() => true) })
  const hook = renderHook(() => useMicRecorder(copy))
  let opening!: Promise<void>
  act(() => {
    opening = hook.result.current.handle.start()
  })
  expect(pause).toHaveBeenCalledOnce()
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
  hook.unmount()
  expect(release).toHaveBeenCalledOnce()
  await act(async () => {
    permission.resolve()
    await opening
  })
  expect(release).toHaveBeenCalledOnce()
  backgroundVoiceOwnership.register(() => () => undefined)
})
