import { atom } from 'nanostores'

import type { ResolvedOwner } from '@/api/client'

export const MAX_VOICE_OUTPUT_GAIN = 4

export function normalizeVoiceOutputGain(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_VOICE_OUTPUT_GAIN, Math.max(0, value)) : 1
}

interface VoiceOutputLevel {
  gain: number
}

// A cache of profile config, shared by the inspector, compact controls and active
// playback. Persistence remains on the owning backend, never in localStorage.
const levels = new Map<string, ReturnType<typeof atom<VoiceOutputLevel>>>()

export function voiceOutputLevel(owner: ResolvedOwner) {
  const key = JSON.stringify([owner.connectionId, owner.profile])
  let level = levels.get(key)

  if (!level) {
    level = atom<VoiceOutputLevel>({ gain: 1 })
    levels.set(key, level)
  }

  return level
}

/** A fetch started before a local adjustment cannot replace that adjustment. */
export function applyVoiceOutputGain(owner: ResolvedOwner, value: unknown, expected?: VoiceOutputLevel) {
  const level = voiceOutputLevel(owner)

  if (!expected || level.get() === expected) {
    level.set({ gain: normalizeVoiceOutputGain(value) })
  }
}
