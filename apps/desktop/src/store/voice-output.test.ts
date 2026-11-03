import { expect, it } from 'vitest'

import { applyVoiceOutputGain, normalizeVoiceOutputGain, voiceOutputLevel } from './voice-output'

it('isolates worker/connection levels and rejects stale reads after a user adjustment', () => {
  const yuki = { connectionId: 'volume-test-office', profile: 'yuki' }
  const ciel = { connectionId: 'volume-test-office', profile: 'ciel' }
  const elsewhere = { connectionId: 'volume-test-lab', profile: 'yuki' }
  const initial = voiceOutputLevel(yuki).get()
  applyVoiceOutputGain(yuki, 2)
  applyVoiceOutputGain(yuki, 1, initial)
  expect(voiceOutputLevel(yuki).get().gain).toBe(2)
  expect(voiceOutputLevel(ciel).get().gain).toBe(1)
  expect(voiceOutputLevel(elsewhere).get().gain).toBe(1)
  expect([-10, 0, 2, 99, NaN, Infinity, '2', null].map(normalizeVoiceOutputGain)).toEqual([0, 0, 2, 4, 1, 1, 1, 1])
})
