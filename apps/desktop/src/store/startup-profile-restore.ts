import type { DesktopAgentRoster } from '@/global'
import type { ProfileInfo } from '@/types/hermes'

/** The roster has reported the launch target down: the window has fallen back
 *  to the source already in front. Connect-on-demand SSH counts as reachable. */
export function launchTargetUnreachable(roster: DesktopAgentRoster | null, connectionId: string): boolean {
  return roster?.sources.some(source => source.connectionId === connectionId && !source.reachable) === true
}

/** A profile remembered globally is not necessarily on the selected gateway. */
export function startupProfileForConnection(
  active: string,
  remembered: string | undefined,
  profiles: Pick<ProfileInfo, 'name'>[]
): string | null {
  const names = new Set(profiles.map(profile => profile.name))

  if (names.has(active)) {
    return null
  }

  if (remembered && names.has(remembered)) {
    return remembered
  }

  if (names.has('default')) {
    return 'default'
  }

  return profiles[0]?.name ?? null
}
