import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VoiceLiveHandlers } from './voice-live'
import { checkLiveVoice } from './voice-live-check'

const fake = vi.hoisted(() => ({ handlers: null as VoiceLiveHandlers | null, start: vi.fn(async () => undefined), close: vi.fn(), speak: vi.fn() }))
vi.mock('./voice-live', () => ({ VoiceLiveSession: class {
  constructor(handlers: VoiceLiveHandlers) { fake.handlers = handlers }
  start = fake.start
  close = fake.close
  speak = fake.speak
  waitUntilConnected = async () => undefined
} }))

afterEach(() => vi.clearAllMocks())

describe('explicit native voice check', () => {
  it('requires assistant text and measured speech before success and closes the microphone-free call', async () => {
    const controller = new AbortController()
    let succeeded = false
    const run = checkLiveVoice({ connectionId: 'office', profile: 'worker' }, 'runtime-owner', controller.signal).then(() => { succeeded = true })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(fake.start).toHaveBeenCalledWith([], 'runtime-owner', { microphone: false })
    fake.handlers!.onTranscript!({ speaker: 'assistant', text: 'Голос работает', startMs: 0, endMs: 1 })
    await Promise.resolve()
    expect(succeeded).toBe(false)
    fake.handlers!.onSpeakingChange!(false)
    await Promise.resolve()
    expect(succeeded).toBe(false)
    fake.handlers!.onSpeakingChange!(true)
    await Promise.resolve()
    expect(succeeded).toBe(false)
    fake.handlers!.onSpeakingChange!(false)
    await run
    expect(succeeded).toBe(true)
    expect(fake.close).toHaveBeenCalled()
  })
  it('preserves a safe numeric lease close code instead of masking it with the generic check failure', async () => {
    const controller = new AbortController()
    const run = checkLiveVoice({ connectionId: 'office', profile: 'worker' }, 'runtime-owner', controller.signal)
    fake.handlers!.onClosed('Codex voice connection closed (code 4401)', null)
    await expect(run).rejects.toThrow('Codex voice connection closed (code 4401)')
    expect(fake.close).toHaveBeenCalled()
  })

})
