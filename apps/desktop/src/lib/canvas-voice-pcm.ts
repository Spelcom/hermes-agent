const RATE = 16_000
const MAX_SAMPLES = RATE * 12
const PRE_ROLL = RATE / 4

function pcmWave(chunks: Int16Array[]): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(44 + length * 2)
  const view = new DataView(bytes.buffer)

  const word = (offset: number, value: string) =>
    [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))

  word(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  word(8, 'WAVE')
  word(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  word(36, 'data')
  view.setUint32(40, length * 2, true)
  let offset = 44

  for (const chunk of chunks) {
    for (const sample of chunk) {
      view.setInt16(offset, sample, true)
      offset += 2
    }
  }

  return new Blob([bytes], { type: 'audio/wav' })
}

/** Bounded in-memory VAD utterances over the existing 16 kHz capture engine. */
export function createCanvasUtterances(onUtterance: (audio: Blob) => void) {
  let chunks: Int16Array[] = []
  let preRoll = new Int16Array(0)
  let samples = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const flush = () => {
    clearTimeout(timer)
    const audio = chunks
    const size = samples
    chunks = []
    samples = 0

    if (!stopped && size >= RATE / 4) {
      onUtterance(pcmWave(audio))
    }
  }

  return {
    feed(encoded: string) {
      if (stopped) {
        return
      }

      const binary = atob(encoded)
      const frame = new Int16Array(Math.floor(binary.length / 2))
      let power = 0

      for (let i = 0; i < frame.length; i++) {
        const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8)
        frame[i] = value > 32767 ? value - 65536 : value
        power += frame[i] * frame[i]
      }

      const speech = Math.sqrt(power / Math.max(1, frame.length)) >= 280

      if (speech && !chunks.length) {
        chunks = [preRoll]
        samples = preRoll.length
      }

      if (chunks.length) {
        chunks.push(frame)
        samples += frame.length
      }

      const tail = new Int16Array(preRoll.length + frame.length)
      tail.set(preRoll)
      tail.set(frame, preRoll.length)
      preRoll = tail.slice(-PRE_ROLL)

      if (speech) {
        clearTimeout(timer)
        timer = setTimeout(flush, 800)
      }

      if (samples >= MAX_SAMPLES) {
        flush()
      }
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      chunks = []
      preRoll = new Int16Array(0)
      samples = 0
    }
  }
}
