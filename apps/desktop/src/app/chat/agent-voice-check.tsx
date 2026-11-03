import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { checkLiveVoice } from '@/lib/voice-live-check'
import type { PluginProfileRoute } from '@/sdk/profile-request'

export function AgentVoiceCheck({ route, sessionId }: { route: PluginProfileRoute; sessionId: string }) {
  const [state, setState] = useState('')
  const [checking, setChecking] = useState(false)
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => {
    running.current?.abort()
    running.current = null
  }, [])

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs">
      <Button
        disabled={checking}
        onClick={() => {
          if (running.current) { return }
          const controller = new AbortController()
          running.current = controller
          setChecking(true)
          setState('Соединяюсь…')
          void checkLiveVoice(
            { connectionId: route.connectionId, profile: route.targetProfile },
            sessionId,
            controller.signal
          )
            .then(() => {
              if (!controller.signal.aborted) {
                setState('Голос работает: получены звук и текст')
              }
            })
            .catch(error => {
              if (!controller.signal.aborted) {
                setState(error instanceof Error ? error.message : String(error))
              }
            })
            .finally(() => {
              if (running.current === controller) {
                running.current = null
                setChecking(false)
              }
            })
        }}
        size="sm"
        variant="ghost"
      >
        Проверить голос
      </Button>
      <span role="status">{state}</span>
    </div>
  )
}
