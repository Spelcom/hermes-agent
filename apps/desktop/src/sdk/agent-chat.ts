import type { PluginProfileRoute } from './profile-request'

/** Explicit user navigation to one agent's canonical chat, including its first open. */
export async function openAgentChat(route: PluginProfileRoute): Promise<boolean> {
  if (
    !route ||
    !route.connectionId?.trim() ||
    !route.profile?.trim() ||
    !route.targetProfile?.trim() ||
    !['local', 'remote'].includes(route.mode)
  ) {
    throw new Error('Agent chat requires an exact connection and profile route')
  }

  // Capture before the lazy import: another click or a caller mutating its descriptor cannot
  // redirect this action. The native Bots path owns registry lookup, creation and lineage tips.
  const captured = Object.freeze({ ...route })
  const { openRosterBot } = await import('@/plugins/hermes-bots/roster-actions')

  return openRosterBot({
    name: captured.profile,
    connectionId: captured.connectionId,
    connectionKind: captured.mode,
    targetProfile: captured.targetProfile,
    sourceScoped: true,
    remoteSource: captured.mode === 'remote',
    route: captured
  })
}
