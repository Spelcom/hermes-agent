import { atom } from 'nanostores'

/** Mounted chat surfaces outside the persisted layout retain their transcript. */
export const $retainedSessionViews = atom<ReadonlyMap<symbol, { storedSessionId: string; runtimeId?: string }>>(
  new Map()
)

export function isSessionViewRetained(runtimeId: string, storedSessionId: null | string): boolean {
  return [...$retainedSessionViews.get().values()].some(
    view => view.runtimeId === runtimeId || (storedSessionId !== null && view.storedSessionId === storedSessionId)
  )
}

/** Hold before resume publishes; independent tokens allow two views of one chat. */
export function retainSessionView(storedSessionId: string, runtimeId?: string): () => void {
  const token = Symbol(storedSessionId)
  $retainedSessionViews.set(new Map($retainedSessionViews.get()).set(token, { storedSessionId, runtimeId }))

  return () => {
    const next = new Map($retainedSessionViews.get())

    if (next.delete(token)) {
      $retainedSessionViews.set(next)
    }
  }
}
