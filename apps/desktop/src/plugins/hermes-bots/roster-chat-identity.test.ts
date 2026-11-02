import { beforeEach, expect, it, vi } from 'vitest'

import type { RosterRow } from './types'

const { mergeServerMeta, rememberServerAvatar, requestForBot, setWorkspaceOwnerLabel } = vi.hoisted(() => ({
  mergeServerMeta: vi.fn(),
  rememberServerAvatar: vi.fn(),
  requestForBot: vi.fn(),
  setWorkspaceOwnerLabel: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', () => ({ host: { setWorkspaceOwnerLabel } }))
vi.mock('./profile-ops', () => ({ mergeServerMeta, rememberServerAvatar }))
vi.mock('./data', async () => {
  const { atom } = await import('nanostores')

  return {
    $botMeta: atom({}),
    $lastRoster: atom([]),
    botRosterKey: (row: RosterRow) => `${row.connectionId}::${row.name}`
  }
})
vi.mock('./routing', () => ({
  aliasIdentityFor: () => null,
  backendTargetProfile: (route: { targetProfile: string }) => route.targetProfile,
  botConnectionRoute: (row: RosterRow) => row.route,
  botRosterMeta: (row: RosterRow) => row.ui_meta?.['hermes-bots'],
  botWorkspaceOwnerKey: (row: RosterRow) => `bot:${row.connectionId}::${row.name}`,
  requestForBot
}))

import { $lastRoster } from './data'
import { hydrateRosterChatIdentity } from './roster-chat-identity'

const owner: RosterRow = {
  name: 'desktop-alias',
  connectionId: 'office',
  sourceScoped: true,
  route: { connectionId: 'office', mode: 'remote', profile: 'desktop-alias', targetProfile: 'analyst' }
}

beforeEach(() => {
  vi.clearAllMocks()
  $lastRoster.set([])
})

it('hydrates canonical identity, label and avatar without a mounted Bots pane or ambient RPC', async () => {
  const other = { name: 'desktop-alias', connectionId: 'elsewhere' }
  $lastRoster.set([other])
  requestForBot
    .mockResolvedValueOnce({
      profiles: [
        {
          name: 'analyst',
          has_avatar: true,
          display_name: 'REN',
          canonical_session: { id: 'registry-root', resolved_id: 'compressed-tip' },
          ui_meta: { 'hermes-bots': { title: 'REN' } }
        }
      ]
    })
    .mockResolvedValueOnce({ found: true, data: 'data:image/png;base64,cGhvdG8=' })

  await hydrateRosterChatIdentity(owner)

  const bot = $lastRoster.get()[1]!
  expect($lastRoster.get()[0]).toBe(other)
  expect(bot.name).toBe('desktop-alias')
  expect(bot.route).toBe(owner.route)
  expect(bot.canonical_session).toEqual({ id: 'registry-root', resolved_id: 'compressed-tip' })
  expect(mergeServerMeta).toHaveBeenCalledWith([bot], expect.any(Number))
  expect(setWorkspaceOwnerLabel).toHaveBeenCalledWith('bot:office::desktop-alias', 'REN')
  expect(requestForBot).toHaveBeenNthCalledWith(2, bot, 'profiles.get_asset', { name: 'analyst', asset: 'avatar' })
  expect(rememberServerAvatar).toHaveBeenCalledWith(bot, { found: true, data: 'data:image/png;base64,cGhvdG8=' })
})

it('refuses missing authoritative canonical metadata without publishing a fake roster identity', async () => {
  requestForBot.mockResolvedValue({ profiles: [{ name: 'analyst', display_name: 'REN' }] })
  await expect(hydrateRosterChatIdentity(owner)).rejects.toThrow(/canonical chat metadata/)
  expect($lastRoster.get()).toEqual([])
  expect(setWorkspaceOwnerLabel).not.toHaveBeenCalled()
})

it('uses the backend display name for the local default owner label', async () => {
  requestForBot.mockResolvedValue({
    profiles: [
      {
        name: 'default',
        display_name: 'Ciel',
        canonical_session: { id: 'new-canonical' }
      }
    ]
  })

  await hydrateRosterChatIdentity({
    name: 'default',
    connectionId: 'local',
    sourceScoped: true,
    route: { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' }
  })

  expect(setWorkspaceOwnerLabel).toHaveBeenCalledWith('bot:local::default', 'Ciel')
})
