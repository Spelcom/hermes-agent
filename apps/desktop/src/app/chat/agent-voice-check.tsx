import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { checkLiveVoice } from '@/lib/voice-live-check'
import type { PluginProfileRoute } from '@/sdk/profile-request'

import { openAgentConversationSession } from './agent-conversation-session'

export function AgentVoiceCheck({
  route,
  className,
  sessionId,
  disabled,
  onCheckingChange
}: {
  route: PluginProfileRoute
  className?: string
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
    <div className={cn('flex min-w-0 max-w-full flex-wrap items-start gap-x-2 gap-y-1 text-xs', className)}>
      <Button
        className="min-w-0 max-w-full"
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
        <span className="min-w-0 truncate">{t.composer.voicePreview}</span>
      </Button>
      <span
        className="max-h-24 min-w-0 w-full overflow-y-auto whitespace-normal [overflow-wrap:anywhere]"
        role="status"
      >
        {state}
      </span>
    </div>
  )
}
