interface MicrophonePermissions {
  getMediaAccessStatus?: (mediaType: 'microphone') => string
  askForMediaAccess?: (mediaType: 'microphone') => Promise<boolean>
}

/** Reuse a decided macOS permission; only an undecided permission opens the system prompt. */
export async function requestNativeMicrophoneAccess(isMac: boolean, permissions: MicrophonePermissions): Promise<boolean> {
  if (!isMac) { return true }
  const status = permissions.getMediaAccessStatus?.('microphone')

  if (status === 'granted') { return true }

  if (status !== 'not-determined') { return false }

  return permissions.askForMediaAccess?.('microphone') ?? false
}
