import type { OwnerScope } from '@/api/client'
import { VoiceLiveSession } from '@/lib/voice-live'

/** Explicit setup check: no input device, one phrase, bounded call lifetime. */
export async function checkLiveVoice(owner: OwnerScope, sessionId: string, signal: AbortSignal): Promise<void> {
  let heard = false
  let playing = false
  let transcribed = false
  let resolveResult: () => void = () => undefined
  let rejectResult: (error: Error) => void = () => undefined

  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  // Start can still be negotiating while a termination arrives.
  void result.catch(() => undefined)

  const accept = () => {
    if (heard && transcribed && !playing) {
      resolveResult()
    }
  }

  const session = new VoiceLiveSession(
    {
      onClosed: () => rejectResult(new Error('Проверка голоса завершилась до получения звука и текста')),
      onDelegation: id => session.speak(id, 'Голосовой разговор работает.'),
      onError: () => rejectResult(new Error('Не удалось проверить голос. Проверьте вход в Codex.')),
      onSpeakingChange: speaking => {
        heard ||= speaking
        playing = speaking
        accept()
      },
      onTranscript: fragment => {
        transcribed ||= fragment.speaker === 'assistant' && Boolean(fragment.text.trim())
        accept()
      }
    },
    owner
  )

  const abort = () => {
    session.close()
    rejectResult(new Error('Проверка отменена'))
  }

  signal.addEventListener('abort', abort, { once: true })

  const timeout = window.setTimeout(() => {
    rejectResult(new Error('За время проверки не получены звук и текст'))
    session.close()
  }, 25_000)

  try {
    signal.throwIfAborted()
    await Promise.race([session.start([], sessionId, { microphone: false }), result])
    await Promise.race([session.waitUntilConnected(), result])
    signal.throwIfAborted()
    session.speak(
      null,
      'Скажи по-русски: «Голосовой разговор работает». Это проверка звука, отвечай только этой фразой.'
    )
    await result
  } finally {
    window.clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    session.close()
  }
}
