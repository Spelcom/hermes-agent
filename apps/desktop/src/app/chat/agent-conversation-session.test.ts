import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  retain: vi.fn(),
  release: vi.fn(),
  canonical: vi.fn(),
  hint: vi.fn(),
  resume: vi.fn(),
  voice: vi.fn()
}))

vi.mock('@/store/gateway', () => ({ retainGatewayForAgent: mocks.retain }))
vi.mock('@/store/session', () => ({ setSessionOwnerHint: mocks.hint }))
vi.mock('@/store/session-states', () => ({ sessionTileDelegate: () => ({ resumeTile: mocks.resume }) }))
vi.mock('@/lib/voice-live', () => ({ fetchVoiceLiveStatus: mocks.voice }))
vi.mock('@/plugins/hermes-bots/canonical-chat', () => ({ resolveBotCanonicalSession: mocks.canonical }))

import { isSessionViewRetained } from '@/store/session-view-retention'

import { openAgentConversationSession } from './agent-conversation-session'

const route = { connectionId: 'office', mode: 'remote' as const, profile: 'alias', targetProfile: 'developer' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.retain.mockResolvedValue(mocks.release)
  mocks.canonical.mockResolvedValue('canonical-tip')
  mocks.resume.mockResolvedValue('runtime')
  mocks.voice.mockResolvedValue({ mode: 'chained', available: false })
})

it('captures the exact owner before awaits and binds native history without any foreground action', async () => {
  const input = { ...route }
  const opening = openAgentConversationSession(input, new AbortController().signal)
  input.connectionId = 'wrong-source'
  input.targetProfile = 'wrong-agent'
  const session = await opening
  expect(mocks.retain).toHaveBeenCalledWith('office', 'alias', { spawnPriority: 'foreground' })
  expect(mocks.canonical).toHaveBeenCalledWith(expect.objectContaining({ name: 'alias', route }))
  expect(isSessionViewRetained('runtime', 'canonical-tip')).toBe(true)
  expect(mocks.resume).toHaveBeenCalledWith('canonical-tip', { authoritativeSnapshot: true, ownerRoute: route })
  expect(mocks.hint.mock.calls).toEqual([
    ['canonical-tip', route],
    ['runtime', route]
  ])
  expect(mocks.voice).toHaveBeenCalledWith({ connectionId: 'office', profile: 'developer' })
  expect(Object.isFrozen(session.route)).toBe(true)
  expect(mocks.release).not.toHaveBeenCalled()
  session.release()
  expect(isSessionViewRetained('runtime', 'canonical-tip')).toBe(false)
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('releases a route closed while its retain was pending without resolving or resuming a chat', async () => {
  let retained!: () => void
  mocks.retain.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        retained = () => resolve(mocks.release)
      })
  )
  const controller = new AbortController()
  const opening = openAgentConversationSession(route, controller.signal)
  controller.abort()
  retained()
  await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(mocks.canonical).not.toHaveBeenCalled()
  expect(mocks.resume).not.toHaveBeenCalled()
})

it('refuses an incomplete owner and releases the exact route when canonical resolution fails', async () => {
  await expect(
    openAgentConversationSession({ ...route, connectionId: '' }, new AbortController().signal)
  ).rejects.toThrow('exact connection and profile route')
  expect(mocks.retain).not.toHaveBeenCalled()
  mocks.canonical.mockRejectedValueOnce(new Error('offline'))
  await expect(openAgentConversationSession(route, new AbortController().signal)).rejects.toThrow('offline')
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(mocks.resume).not.toHaveBeenCalled()
})

it('holds before resume can publish and releases both leases when close races hydration', async () => {
  const controller = new AbortController()
  mocks.resume.mockImplementationOnce(async () => {
    expect(isSessionViewRetained('not-bound-yet', 'canonical-tip')).toBe(true)
    controller.abort()

    return 'runtime'
  })
  await expect(openAgentConversationSession(route, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(isSessionViewRetained('runtime', 'canonical-tip')).toBe(false)
  expect(mocks.release).toHaveBeenCalledOnce()
})
