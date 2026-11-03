import { fetchVoiceLiveStatus } from '@/lib/voice-live'
import type { PluginProfileRoute } from '@/sdk/profile-request'
import { retainGatewayForAgent } from '@/store/gateway'
import { setSessionOwnerHint } from '@/store/session'
import { sessionTileDelegate } from '@/store/session-states'
import { retainSessionView } from '@/store/session-view-retention'

export function captureAgentConversationRoute(route: PluginProfileRoute): Readonly<PluginProfileRoute> {
  if (
    !route?.connectionId?.trim() ||
    !route.profile?.trim() ||
    !route.targetProfile?.trim() ||
    !['local', 'remote'].includes(route.mode)
  ) {
    throw new Error('Agent conversation requires an exact connection and profile route')
  }

  return Object.freeze({ ...route })
}

/** Bind the native cache while leaving route, workspace and foreground profile alone. */
export async function openAgentConversationSession(
  input: PluginProfileRoute,
  signal: AbortSignal,
  presentation: 'chat' | 'voice-only' = 'chat'
) {
  const route = captureAgentConversationRoute(input)
  const releaseGateway = await retainGatewayForAgent(route.connectionId, route.profile, { spawnPriority: 'foreground' })
  let releaseRuntime: (() => void) | undefined
  let releaseView: (() => void) | undefined
  let released = false

  const release = () => {
    if (released) {
      return
    }

    released = true
    releaseRuntime?.()
    releaseView?.()
    releaseGateway()
  }

  try {
    signal.throwIfAborted()
    const { resolveBotCanonicalSession } = await import('@/plugins/hermes-bots/canonical-chat')

    const storedSessionId = await resolveBotCanonicalSession({
      name: route.profile,
      connectionId: route.connectionId,
      connectionKind: route.mode,
      targetProfile: route.targetProfile,
      sourceScoped: true,
      remoteSource: route.mode === 'remote',
      route
    })

    signal.throwIfAborted()
    releaseView = retainSessionView(storedSessionId)
    setSessionOwnerHint(storedSessionId, route)
    const delegate = sessionTileDelegate()

    if (!delegate) {
      throw new Error('Native session surface is not ready')
    }

    const runtimeId = await delegate.resumeTile(
      storedSessionId,
      presentation === 'voice-only'
        ? { deferTranscript: true, ownerRoute: route }
        : { authoritativeSnapshot: true, ownerRoute: route }
    )

    signal.throwIfAborted()
    releaseRuntime = retainSessionView(storedSessionId, runtimeId)
    setSessionOwnerHint(runtimeId, route)

    const voiceLiveStatus = await fetchVoiceLiveStatus({
      connectionId: route.connectionId,
      profile: route.targetProfile
    })

    signal.throwIfAborted()

    return { route, storedSessionId, runtimeId, voiceLiveStatus, release }
  } catch (error) {
    release()
    throw error
  }
}
