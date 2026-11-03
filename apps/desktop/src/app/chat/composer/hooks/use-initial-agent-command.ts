import { useEffect, useRef } from 'react'

/** Consumes only an explicitly supplied command after exact-owner hydration. */
export function useInitialAgentCommand(
  command: { token: string | number; text: string } | undefined,
  busy: boolean,
  submit: (text: string) => Promise<unknown>
) {
  const consumed = useRef<string | number | undefined>(undefined)
  // eslint-disable-next-line no-restricted-syntax -- one-shot intent identity, not a mirrored atom
  useEffect(() => {
    if (!command || busy || consumed.current === command.token || !command.text.trim()) {
      return
    }

    consumed.current = command.token
    void submit(command.text).catch(() => undefined)
  }, [busy, command, submit])
}
