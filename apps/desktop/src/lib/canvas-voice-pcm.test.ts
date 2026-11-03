import { afterEach, expect, it, vi } from 'vitest'

import { createCanvasUtterances } from './canvas-voice-pcm'

function pcm(value: number, count = 1600) {
  const frame = new Int16Array(count).fill(value)

  return btoa(String.fromCharCode(...new Uint8Array(frame.buffer)))
}

afterEach(() => {
  vi.useRealTimers()
})
it('keeps silence private, emits bounded PCM WAV only after local speech and a pause', async () => {
  vi.useFakeTimers()
  const receive = vi.fn()
  const gate = createCanvasUtterances(receive)
  gate.feed(pcm(0))
  await vi.advanceTimersByTimeAsync(1000)
  expect(receive).not.toHaveBeenCalled()

  for (let i = 0; i < 4; i++) {
    gate.feed(pcm(2000))
  }

  await vi.advanceTimersByTimeAsync(799)
  expect(receive).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(receive).toHaveBeenCalledOnce()
  expect(receive.mock.calls[0][0].type).toBe('audio/wav')
  expect(receive.mock.calls[0][0].size).toBeLessThan(16_000 * 12 * 2 + 4000)
  gate.stop()
})
it('OFF discards a buffered utterance and cancels late callbacks', async () => {
  vi.useFakeTimers()
  const receive = vi.fn()
  const gate = createCanvasUtterances(receive)

  for (let i = 0; i < 4; i++) {
    gate.feed(pcm(2000))
  }

  gate.stop()
  gate.feed(pcm(2000))
  await vi.runAllTimersAsync()
  expect(receive).not.toHaveBeenCalled()
})
