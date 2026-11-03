import { atom } from 'nanostores'
import { useEffect, useId, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { AgentConversationProps } from '@/sdk/agent-conversation'

import { captureAgentConversationRoute, openAgentConversationSession } from './agent-conversation-session'
import { buildTileView, TileChat } from './session-tile'

type OpenedConversation = Awaited<ReturnType<typeof openAgentConversationSession>>

function ConversationContent({
  session,
  voiceStartToken,
  initialCommand
}: {
  session: OpenedConversation
  voiceStartToken?: string | number
  initialCommand?: AgentConversationProps['initialCommand']
}) {
  const id = useId()
  const view = useMemo(() => buildTileView(session.storedSessionId, atom<string | null>(session.runtimeId)), [session])

  return (
    <TileChat
      composerTarget={`agent-conversation:${id}`}
      embedded
      initialCommand={initialCommand}
      ownerRoute={session.route}
      runtimeId={session.runtimeId}
      storedSessionId={session.storedSessionId}
      view={view}
      voiceLiveStatus={session.voiceLiveStatus}
      voiceStartToken={voiceStartToken}
    />
  )
}

function OwnedConversation({
  route,
  voiceStartToken,
  initialCommand,
  onClose,
  title,
  className
}: AgentConversationProps) {
  const { t } = useI18n()
  const [session, setSession] = useState<OpenedConversation | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let release: (() => void) | undefined
    setError('')
    void openAgentConversationSession(route, controller.signal)
      .then(opened => {
        if (controller.signal.aborted) {
          opened.release()

          return
        }

        release = opened.release
        setSession(opened)
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })

    return () => {
      controller.abort()
      release?.()
    }
  }, [route, retry])

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden', className)}>
      {title && (
        <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {onClose && (
            <Button aria-label={t.common.close} onClick={onClose} size="icon" variant="ghost">
              <Codicon name="close" />
            </Button>
          )}
        </div>
      )}
      {error ? (
        <div className="p-4 text-sm" role="alert">
          <p>{error}</p>
          <Button onClick={() => setRetry(value => value + 1)}>{t.common.retry}</Button>
        </div>
      ) : session ? (
        <ConversationContent initialCommand={initialCommand} session={session} voiceStartToken={voiceStartToken} />
      ) : (
        <div className="p-4 text-sm" role="status">
          {t.common.loading}
        </div>
      )}
    </div>
  )
}

export default function AgentConversation(props: AgentConversationProps) {
  const { connectionId, mode, profile, targetProfile, primary } = props.route

  const route = useMemo(
    () => captureAgentConversationRoute({ connectionId, mode, profile, targetProfile, primary }),
    [connectionId, mode, primary, profile, targetProfile]
  )

  const key = JSON.stringify([connectionId, mode, profile, targetProfile])

  return <OwnedConversation key={key} {...props} route={route} />
}
