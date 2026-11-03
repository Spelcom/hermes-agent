import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { useEmbeddedVoiceStart } from './use-embedded-voice-start'

it('starts only from a fresh explicit token, once the exact composer is ready', () => {
  const activate = vi.fn()
  const end = vi.fn(async () => undefined)

  const initial = {
    active: false,
    activate,
    disabled: true,
    embedded: true,
    end,
    token: undefined as string | undefined
  }

  const hook = renderHook(props => useEmbeddedVoiceStart(props), { initialProps: initial })
  expect(activate).not.toHaveBeenCalled()
  hook.rerender({ ...initial, token: 'click-1' })
  expect(activate).not.toHaveBeenCalled()
  hook.rerender({ ...initial, disabled: false, token: 'click-1' })
  expect(activate).toHaveBeenCalledOnce()
  hook.rerender({ ...initial, disabled: false, token: 'click-1' })
  expect(activate).toHaveBeenCalledOnce()
  hook.unmount()
  expect(end).toHaveBeenCalledOnce()
})

it('does not start a late gesture after close and closes the current engine on unmount', () => {
  const activate = vi.fn()
  const firstEnd = vi.fn(async () => undefined)
  const lastEnd = vi.fn(async () => undefined)
  const initial = { active: false, activate, disabled: true, embedded: true, end: firstEnd, token: 'pending-click' }
  const hook = renderHook(props => useEmbeddedVoiceStart(props), { initialProps: initial })
  hook.rerender({ ...initial, end: lastEnd })
  act(() => hook.unmount())
  expect(activate).not.toHaveBeenCalled()
  expect(firstEnd).not.toHaveBeenCalled()
  expect(lastEnd).toHaveBeenCalledOnce()
})
