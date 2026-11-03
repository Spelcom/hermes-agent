import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { checkLiveVoice } from '@/lib/voice-live-check'
import type { PluginProfileRoute } from '@/sdk/profile-request'

export function AgentVoiceCheck({ route, sessionId }: { route: PluginProfileRoute; sessionId: string }) {
  const [state, setState] = useState('')
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs">
      <Button
        disabled={Boolean(running.current)}
        onClick={() => {
          const controller = new AbortController()
          running.current = controller
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
              running.current = null
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
