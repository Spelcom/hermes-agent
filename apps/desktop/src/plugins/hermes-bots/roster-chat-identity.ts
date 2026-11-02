/** Hydrate native chat chrome when a public action opens Bots without mounting its roster pane. */
import { host } from '@hermes/plugin-sdk'

import { $botMeta, $lastRoster, botRosterKey } from './data'
import { displayName } from './labels'
import { mergeServerMeta, rememberServerAvatar } from './profile-ops'
import { backendTargetProfile, botConnectionRoute, botRosterMeta, botWorkspaceOwnerKey, requestForBot } from './routing'
import type { RosterRow } from './types'

export async function hydrateRosterChatIdentity(owner: RosterRow): Promise<void> {
  const issuedAt = Date.now()
  const target = backendTargetProfile(botConnectionRoute(owner), owner.name)
  const snapshot = await requestForBot<{ profiles?: RosterRow[] }>(owner, 'profiles.list', { include_sessions: true })
  const profile = snapshot.profiles?.find(row => row.name === target)

  if (!profile?.canonical_session?.id) {
    throw new Error('Agent canonical chat metadata is unavailable after opening')
  }

  // The backend names its profile; the native workspace keys the captured Desktop route.
  const bot = { ...profile, ...owner, canonical_session: profile.canonical_session }
  mergeServerMeta([bot], issuedAt)
  $lastRoster.set([...$lastRoster.get().filter(row => botRosterKey(row) !== botRosterKey(bot)), bot])
  host.setWorkspaceOwnerLabel?.(botWorkspaceOwnerKey(bot), displayName(bot, botRosterMeta(bot, $botMeta.get())))

  if (bot.has_avatar && !botRosterMeta(bot, $botMeta.get())?.image) {
    const avatar = await requestForBot<{ found?: boolean; data?: string }>(bot, 'profiles.get_asset', {
      name: target,
      asset: 'avatar'
    })

    rememberServerAvatar(bot, avatar)
  }
}
