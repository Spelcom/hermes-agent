import type { ResolvedOwner } from '@/api/client'
import { resolveSiblingWsUrl } from '@/lib/sibling-ws-url'

/** Native reservations must be minted for the final path, never rewritten. */
export async function resolveVoiceLiveCallUrl(owner: ResolvedOwner, callId: string): Promise<string> {
  const direct = await window.hermesDesktop.getVoiceLiveCallWsUrl?.({ ...owner, callId })

  if (direct) { return direct }
  const remote = await resolveSiblingWsUrl(owner, `/api/audio/voice-live/calls/${encodeURIComponent(callId)}`)

  if (new URL(remote).searchParams.has('native_dial')) {
    throw new Error('This desktop cannot authorize the native voice connection. Update Hermes Desktop.')
  }

  return remote
}
