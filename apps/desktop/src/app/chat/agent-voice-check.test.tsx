import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentVoiceCheck } from './agent-voice-check'

const fake = vi.hoisted(() => ({ check: vi.fn(), open: vi.fn(), release: vi.fn() }))
vi.mock('@/lib/voice-live-check', () => ({ checkLiveVoice: fake.check }))
vi.mock('./agent-conversation-session', () => ({ openAgentConversationSession: fake.open }))
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { connecting: 'Connecting' },
      composer: { voicePreview: 'Preview voice', voicePreviewReady: 'Voice works' }
    }
  })
}))
const route = { connectionId: 'office', mode: 'remote' as const, profile: 'alias', targetProfile: 'worker' }
afterEach(() => {
  cleanup()
  fake.check.mockReset()
  fake.open.mockReset()
  fake.release.mockReset()
})

describe('native voice setup check', () => {
  it.each(['success', 'failure'] as const)('re-enables the button after %s and permits a retry', async outcome => {
    let resolve: () => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    fake.check.mockImplementationOnce(
      () =>
        new Promise<void>((yes, no) => {
          resolve = yes
          reject = no
        })
    )
    fake.check.mockResolvedValueOnce(undefined)
    render(<AgentVoiceCheck route={route} sessionId="runtime-owner" />)
    const button = screen.getByRole('button', { name: 'Preview voice' }) as HTMLButtonElement
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    expect(fake.check).toHaveBeenCalledWith(
      { connectionId: 'office', profile: 'worker' },
      'runtime-owner',
      expect.any(AbortSignal)
    )
    await act(async () => {
      if (outcome === 'success') {
        resolve()
      } else {
        reject(new Error('Проверка прервана'))
      }
    })
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(screen.getByRole('status').textContent).toContain(
      outcome === 'success' ? 'Voice works' : 'Проверка прервана'
    )
    fireEvent.click(button)
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(fake.check).toHaveBeenCalledTimes(2)
  })
  it('aborts its owned check when the worker bubble closes', () => {
    let signal: AbortSignal | undefined
    fake.check.mockImplementation((_owner, _session, abort: AbortSignal) => {
      signal = abort

      return new Promise(() => undefined)
    })
    const view = render(<AgentVoiceCheck route={route} sessionId="runtime-owner" />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview voice' }))
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})

it('previews a saved voice on its canonical owner only after a click, then releases the lazy attachment', async () => {
  fake.open.mockResolvedValue({ runtimeId: 'canonical-runtime', release: fake.release })
  fake.check.mockResolvedValue(undefined)
  render(<AgentVoiceCheck route={route} />)
  expect(fake.open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Preview voice' }))
  await waitFor(() => expect(fake.release).toHaveBeenCalledOnce())
  expect(fake.open).toHaveBeenCalledWith(route, expect.any(AbortSignal), 'voice-only')
  expect(fake.check).toHaveBeenCalledWith(
    { connectionId: 'office', profile: 'worker' },
    'canonical-runtime',
    expect.any(AbortSignal)
  )
})
