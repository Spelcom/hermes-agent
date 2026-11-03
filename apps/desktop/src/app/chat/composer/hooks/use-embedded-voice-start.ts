import { useEffect, useRef } from 'react'

interface EmbeddedVoiceStart {
  active: boolean
  activate: () => void
  disabled: boolean
  embedded?: boolean
  end: () => Promise<void>
  token?: string | number
}

/** A caller's user-gesture token starts this mounted composer once, never the active one. */
export function useEmbeddedVoiceStart({ active, activate, disabled, embedded, end, token }: EmbeddedVoiceStart) {
  const consumed = useRef<string | number | undefined>(undefined)
  const endRef = useRef(end)
  endRef.current = end

  // eslint-disable-next-line no-restricted-syntax -- consumed user-gesture token, not an atom mirror
  useEffect(() => {
    if (!embedded || disabled || token === undefined || consumed.current === token) {
      return
    }

    consumed.current = token

    if (!active) {
      activate()
    }
  }, [active, activate, disabled, embedded, token])

  useEffect(
    () => () => {
      if (embedded) {
        void endRef.current()
      }
    },
    [embedded]
  )
}
