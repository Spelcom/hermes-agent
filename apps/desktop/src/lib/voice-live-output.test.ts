import { afterEach, describe, expect, it, vi } from 'vitest'

import { createVoiceLiveOutput, voiceOutputLimiterCurve } from './voice-live-output'

function audioContext() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  const source = node()
  const gain = { ...node(), gain: { value: 0, setTargetAtTime: vi.fn() } }

  const compressor = {
    ...node(),
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 }
  }

  const limiter = { ...node(), curve: null as Float32Array | null }
  const analyser = { ...node(), fftSize: 0 }

  const context = {
    createMediaStreamSource: vi.fn(() => source),
    createGain: () => gain,
    createDynamicsCompressor: () => compressor,
    createWaveShaper: () => limiter,
    createAnalyser: () => analyser,
    destination: {},
    currentTime: 12,
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

  return { context, source, gain, compressor, limiter, analyser }
}

afterEach(() => vi.unstubAllGlobals())

describe('received voice output amplification', () => {
  it('routes actual samples through bounded gain and a limiter, then disconnects every node once', async () => {
    const { context, source, gain, compressor, limiter, analyser } = audioContext()
    const stream = {} as MediaStream
    const output = createVoiceLiveOutput(stream, 2)
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream)
    expect(gain.gain.value).toBe(2)
    expect(source.connect).toHaveBeenCalledWith(gain)
    expect(gain.connect).toHaveBeenCalledWith(compressor)
    expect(compressor.connect).toHaveBeenCalledWith(limiter)
    expect(limiter.connect).toHaveBeenCalledWith(context.destination)
    expect(limiter.connect).toHaveBeenCalledWith(analyser)
    expect(compressor.ratio.value).toBe(20)
    await output.resume()
    expect(context.resume).toHaveBeenCalledOnce()
    output.setGain(900)
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(4, 12, 0.01)
    output.setGain(-2)
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 12, 0.01)
    output.close()
    output.close()
    output.setGain(3)
    expect(gain.gain.setTargetAtTime).toHaveBeenCalledTimes(2)

    for (const node of [source, gain, compressor, limiter, analyser]) {
      expect(node.disconnect).toHaveBeenCalledOnce()
    }

    expect(context.close).toHaveBeenCalledOnce()
  })

  it('keeps quiet samples linear and overload below full scale with a symmetric monotone soft knee', () => {
    const curve = voiceOutputLimiterCurve()
    expect(curve[2048]).toBe(0)
    expect(curve[2560]).toBeCloseTo(0.25)

    for (let index = 0; index < curve.length; index += 1) {
      expect(Math.abs(curve[index])).toBeLessThan(0.98)
      expect(curve[index]).toBeCloseTo(-curve[curve.length - 1 - index])

      if (index) {
        expect(curve[index]).toBeGreaterThanOrEqual(curve[index - 1])
      }
    }
  })

  it('closes a partially constructed context when a device rejects graph setup', () => {
    const { context } = audioContext()
    context.createMediaStreamSource.mockImplementation(() => {
      throw new Error('device unavailable')
    })
    expect(() => createVoiceLiveOutput({} as MediaStream, 2)).toThrow('device unavailable')
    expect(context.close).toHaveBeenCalledOnce()
  })
})
