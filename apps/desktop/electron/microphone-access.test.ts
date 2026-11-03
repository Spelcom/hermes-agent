import { expect, test, vi } from 'vitest'

import { requestNativeMicrophoneAccess } from './microphone-access'

test.each([['granted', true], ['denied', false], ['restricted', false], ['unknown', false]] as const)('returns the decided macOS microphone state %s without asking again', async (status, expected) => {
  const permissions = { getMediaAccessStatus: vi.fn(() => status), askForMediaAccess: vi.fn(() => new Promise<boolean>(() => undefined)) }
  await expect(requestNativeMicrophoneAccess(true, permissions)).resolves.toBe(expected)
  expect(permissions.getMediaAccessStatus).toHaveBeenCalledWith('microphone')
  expect(permissions.askForMediaAccess).not.toHaveBeenCalled()
})

test('asks only for an undecided macOS microphone permission and preserves the answer', async () => {
  const permissions = { getMediaAccessStatus: vi.fn(() => 'not-determined'), askForMediaAccess: vi.fn(async () => false) }
  await expect(requestNativeMicrophoneAccess(true, permissions)).resolves.toBe(false)
  expect(permissions.askForMediaAccess).toHaveBeenCalledExactlyOnceWith('microphone')
})

test('other platforms keep browser capture permission and never call the macOS APIs', async () => {
  const permissions = { getMediaAccessStatus: vi.fn(), askForMediaAccess: vi.fn() }
  await expect(requestNativeMicrophoneAccess(false, permissions)).resolves.toBe(true)
  expect(permissions.getMediaAccessStatus).not.toHaveBeenCalled()
  expect(permissions.askForMediaAccess).not.toHaveBeenCalled()
})
