import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PluginProfileRoute } from './profile-request'

const { openRosterBot } = vi.hoisted(() => ({ openRosterBot: vi.fn() }))

vi.mock('@/plugins/hermes-bots/roster-actions', () => ({ openRosterBot }))

import { openAgentChat } from './agent-chat'

beforeEach(() => {
  openRosterBot.mockReset().mockResolvedValue(true)
})

describe('the public agent chat action uses the native canonical open', () => {
  it('captures the exact source before async work and leaves canonical identity to the native resolver', async () => {
    const route: PluginProfileRoute = {
      connectionId: 'office',
      mode: 'remote',
      profile: 'desktop-alias',
      targetProfile: 'developer'
    }

    const opening = openAgentChat(route)

    route.connectionId = 'other-device'
    route.profile = 'analyst'
    route.targetProfile = 'analyst'

    await expect(opening).resolves.toBe(true)
    expect(openRosterBot).toHaveBeenCalledWith({
      name: 'desktop-alias',
      connectionId: 'office',
      connectionKind: 'remote',
      targetProfile: 'developer',
      sourceScoped: true,
      remoteSource: true,
      route: { connectionId: 'office', mode: 'remote', profile: 'desktop-alias', targetProfile: 'developer' }
    })
    const [bot] = openRosterBot.mock.calls[0]!
    expect(Object.isFrozen(bot.route)).toBe(true)
    expect(bot.canonical_session).toBeUndefined()
  })

  it('preserves native failure and refuses an incomplete owner instead of using the active profile', async () => {
    openRosterBot.mockResolvedValue(false)
    await expect(
      openAgentChat({ connectionId: 'local', mode: 'local', profile: 'editor', targetProfile: 'editor' })
    ).resolves.toBe(false)
    openRosterBot.mockClear()
    await expect(
      openAgentChat({ connectionId: '', mode: 'local', profile: 'editor', targetProfile: 'editor' })
    ).rejects.toThrow(/exact connection and profile route/)
    expect(openRosterBot).not.toHaveBeenCalled()
  })
})
