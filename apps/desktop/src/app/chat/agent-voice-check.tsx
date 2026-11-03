import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { checkLiveVoice } from '@/lib/voice-live-check'
import type { PluginProfileRoute } from '@/sdk/profile-request'

import { openAgentConversationSession } from './agent-conversation-session'

export function AgentVoiceCheck({
  route,
  sessionId,
  disabled,
  onCheckingChange
}: {
  route: PluginProfileRoute
  sessionId?: string
  disabled?: boolean
  onCheckingChange?: (checking: boolean) => void
}) {
  const { t } = useI18n()
  const [state, setState] = useState('')
  const [checking, setChecking] = useState(false)
  const running = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      running.current?.abort()
      running.current = null
    },
    []
  )

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs">
      <Button
        disabled={checking || disabled}
        onClick={() => {
          if (running.current) {
            return
          }

          const controller = new AbortController()
          running.current = controller
          setChecking(true)
          onCheckingChange?.(true)
          setState(t.common.connecting)

          const run = async () => {
            const opened = sessionId ? null : await openAgentConversationSession(route, controller.signal, 'voice-only')

            try {
              await checkLiveVoice(
                { connectionId: route.connectionId, profile: route.targetProfile },
                sessionId ?? opened!.runtimeId,
                controller.signal
              )
            } finally {
              opened?.release()
            }
          }

          void run()
            .then(() => {
              if (!controller.signal.aborted) {
                setState(t.composer.voicePreviewReady)
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
                onCheckingChange?.(false)
              }
            })
        }}
        size="sm"
        variant="ghost"
      >
        {t.composer.voicePreview}
      </Button>
      <span role="status">{state}</span>
    </div>
  )
}
