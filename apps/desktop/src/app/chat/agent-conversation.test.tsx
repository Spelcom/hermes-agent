import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useEmbeddedVoiceStart } from './composer/hooks/use-embedded-voice-start'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  release: vi.fn(),
  activate: vi.fn(),
  end: vi.fn(async () => undefined),
  tile: vi.fn()
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: { common: { loading: 'Loading', retry: 'Retry', close: 'Close' } } })
}))
vi.mock('./agent-conversation-session', () => ({
  captureAgentConversationRoute: (route: object) => Object.freeze({ ...route }),
  openAgentConversationSession: mocks.open
}))
vi.mock('./session-tile', () => ({
  buildTileView: () => ({}),
  TileChat: (props: { voiceStartToken?: string | number; embedded: boolean }) => {
    mocks.tile(props)
    useEmbeddedVoiceStart({
      active: false,
      activate: mocks.activate,
      end: mocks.end,
      disabled: false,
      embedded: props.embedded,
      token: props.voiceStartToken
    })

    return <div>Native thread and composer</div>
  }
}))

import AgentConversation from './agent-conversation'

const route = { connectionId: 'office', mode: 'remote' as const, profile: 'alias', targetProfile: 'developer' }
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('keeps a native exact-owner chat inside the plugin and starts voice only from its explicit token', async () => {
  mocks.open.mockResolvedValue({
    route,
    storedSessionId: 'stored',
    runtimeId: 'runtime',
    voiceLiveStatus: { mode: 'chained', available: false },
    release: mocks.release
  })
  const panel = render(<AgentConversation route={route} />)
  await waitFor(() => expect(mocks.tile).toHaveBeenCalled())
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.tile.mock.calls.at(-1)?.[0]).toMatchObject({
    ownerRoute: route,
    storedSessionId: 'stored',
    embedded: true
  })
  panel.rerender(<AgentConversation route={{ ...route }} voiceStartToken="mic-click-1" />)
  await waitFor(() => expect(mocks.activate).toHaveBeenCalledOnce())
  panel.rerender(<AgentConversation route={{ ...route }} voiceStartToken="mic-click-1" />)
  expect(mocks.activate).toHaveBeenCalledOnce()
  panel.unmount()
  expect(mocks.end).toHaveBeenCalledOnce()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('a panel closed before hydration never mounts a composer or starts its microphone', async () => {
  let resolve!: (value: object) => void
  mocks.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const panel = render(<AgentConversation route={route} voiceStartToken="pending-click" />)
  const signal = mocks.open.mock.calls[0][1] as AbortSignal
  panel.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => {
    resolve({ route, storedSessionId: 'stored', runtimeId: 'runtime', release: mocks.release })
  })
  expect(mocks.tile).not.toHaveBeenCalled()
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})


it('offers the microphone-free voice check for the backend canonical Codex subscription lane', async () => {
  mocks.open.mockResolvedValue({ route, storedSessionId: 'stored', runtimeId: 'runtime', voiceLiveStatus: { mode: 'gpt-live', available: true, auth: 'codex-subscription', wire_protocol: 'codex-v3' }, release: mocks.release })
  const panel = render(<AgentConversation route={route} />)
  expect(await panel.findByRole('button', { name: 'Проверить голос' })).toBeTruthy()
  expect(mocks.activate).not.toHaveBeenCalled()
})
