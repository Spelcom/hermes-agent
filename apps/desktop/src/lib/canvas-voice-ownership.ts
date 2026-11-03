let reserved = false
let owner: (() => () => void) | undefined
const pending = new Set<{ release?: () => void }>()

/** Synchronous mic/audio interlock; callers do not load the standby service. */
export function pauseBackgroundVoice(): () => void {
  const token = { release: owner?.() }
  pending.add(token)

  return () => {
    if (pending.delete(token)) {
      token.release?.()
    }
  }
}

export const backgroundVoiceOwnership = {
  isReserved: () => reserved,
  setReserved: (value: boolean) => {
    reserved = value
  },
  register(pause: () => () => void) {
    owner = pause

    for (const token of pending) {
      token.release = pause()
    }
  }
}
