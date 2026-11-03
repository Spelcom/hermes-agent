import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { useInitialAgentCommand } from './use-initial-agent-command'

it('submits only a fresh matched command once after hydration; text mode never submits', () => {
  const submit = vi.fn(async () => true)
  const command = { token: 'wake:1', text: 'проверь файл' }

  const hook = renderHook(({ value, busy }) => useInitialAgentCommand(value, busy, submit), {
    initialProps: { value: undefined as typeof command | undefined, busy: false }
  })

  expect(submit).not.toHaveBeenCalled()
  hook.rerender({ value: command, busy: true })
  expect(submit).not.toHaveBeenCalled()
  hook.rerender({ value: command, busy: false })
  expect(submit).toHaveBeenCalledExactlyOnceWith('проверь файл')
  hook.rerender({ value: { ...command }, busy: false })
  expect(submit).toHaveBeenCalledOnce()
  hook.rerender({ value: { token: 'wake:2', text: '' }, busy: false })
  expect(submit).toHaveBeenCalledOnce()
  hook.unmount()
})
