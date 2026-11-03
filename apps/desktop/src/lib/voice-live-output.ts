import { normalizeVoiceOutputGain } from '@/store/voice-output'

/** Soft knee at the top of the waveform; even overload stays below full scale. */
export function voiceOutputLimiterCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(4097)

  for (let index = 0; index < curve.length; index += 1) {
    const sample = (index / (curve.length - 1)) * 2 - 1
    const magnitude = Math.abs(sample)
    const limited = magnitude <= 0.85 ? magnitude : 0.85 + 0.13 * Math.tanh((magnitude - 0.85) / 0.13)
    curve[index] = Math.sign(sample) * limited
  }

  return curve
}

/** One audible path for the received WebRTC track, also used by voice previews. */
export function createVoiceLiveOutput(stream: MediaStream, initialGain: number) {
  const context = new AudioContext()

  try {
    const source = context.createMediaStreamSource(stream)
    const gain = context.createGain()
    const compressor = context.createDynamicsCompressor()
    const limiter = context.createWaveShaper()
    const analyser = context.createAnalyser()
    gain.gain.value = normalizeVoiceOutputGain(initialGain)
    compressor.threshold.value = -3
    compressor.knee.value = 6
    compressor.ratio.value = 20
    compressor.attack.value = 0.003
    compressor.release.value = 0.1
    limiter.curve = voiceOutputLimiterCurve()
    analyser.fftSize = 512
    source.connect(gain)
    gain.connect(compressor)
    compressor.connect(limiter)
    limiter.connect(analyser)
    limiter.connect(context.destination)
    let closed = false

    return {
      analyser,
      resume: () => context.resume(),
      setGain: (value: number) => {
        if (!closed) {
          gain.gain.setTargetAtTime(normalizeVoiceOutputGain(value), context.currentTime, 0.01)
        }
      },
      close: () => {
        if (closed) {
          return
        }

        closed = true
        source.disconnect()
        gain.disconnect()
        compressor.disconnect()
        limiter.disconnect()
        analyser.disconnect()
        void context.close().catch(() => undefined)
      }
    }
  } catch (error) {
    void context.close().catch(() => undefined)
    throw error
  }
}
