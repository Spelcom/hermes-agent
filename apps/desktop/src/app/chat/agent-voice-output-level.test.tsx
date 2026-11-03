import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { voiceOutputLevel } from '@/store/voice-output'

import { AgentVoiceOutputLevel } from './agent-voice-output-level'

const fake = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('@/api/config', () => ({ saveHermesConfigRecord: fake.save }))
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      composer: { voiceOutputLevel: 'Громкость голоса' },
      settings: { config: { autosaveFailed: 'Не удалось сохранить' } }
    }
  })
}))
afterEach(() => {
  cleanup()
  fake.save.mockReset()
})

it('adjusts playback immediately, persists only gain for the worker, and rolls back a rejected save', async () => {
  const route = { connectionId: 'output-ui', mode: 'remote' as const, profile: 'alias', targetProfile: 'yuki' }
  const level = voiceOutputLevel({ connectionId: route.connectionId, profile: route.targetProfile })
  level.set({ gain: 1 })
  let reject: (error: Error) => void = () => undefined
  fake.save.mockImplementationOnce(
    () =>
      new Promise((_yes, no) => {
        reject = no
      })
  )
  fake.save.mockResolvedValueOnce({ ok: true })
  render(<AgentVoiceOutputLevel route={route} />)
  const slider = screen.getByRole('slider', { name: /Громкость голоса/ }) as HTMLInputElement
  fireEvent.change(slider, { target: { value: '200' } })
  expect(level.get().gain).toBe(2)
  expect(fake.save).not.toHaveBeenCalled()
  fireEvent.pointerUp(slider)
  expect(fake.save).toHaveBeenCalledWith(
    { voice: { gpt_live: { output_gain: 2 } } },
    { connectionId: 'output-ui', profile: 'yuki' }
  )
  expect(slider.disabled).toBe(true)
  await act(async () => reject(new Error('Сеть недоступна')))
  await waitFor(() => expect(slider.disabled).toBe(false))
  expect(level.get().gain).toBe(1)
  expect(screen.getByRole('alert').textContent).toBe('Сеть недоступна')
  fireEvent.change(slider, { target: { value: '300' } })
  fireEvent.keyUp(slider, { key: 'ArrowRight' })
  await waitFor(() => expect(slider.disabled).toBe(false))
  expect(level.get().gain).toBe(3)
  expect(fake.save).toHaveBeenCalledTimes(2)
})
