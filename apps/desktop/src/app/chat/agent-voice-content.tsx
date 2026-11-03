import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { chatMessageText, collectUnspokenTurnSpeech } from '@/lib/chat-messages'
import { markAssistantIdSpoken, resolveSpokenReply } from '@/lib/spoken-reply'
import { toLiveHistory } from '@/lib/voice-live'
import type { AgentConversationProps, AgentVoiceState } from '@/sdk/agent-conversation'
import { createComposerAttachmentScope } from '@/store/composer'
import { sessionAwaitingInput } from '@/store/prompts'
import { requestForSessionProfile } from '@/store/session-request-router'

import type { openAgentConversationSession } from './agent-conversation-session'
import { AgentVoicePicker } from './agent-voice-picker'
import { useEmbeddedVoiceStart } from './composer/hooks/use-embedded-voice-start'
import { useInitialAgentCommand } from './composer/hooks/use-initial-agent-command'
import { useVoiceLiveConversation } from './composer/hooks/use-voice-live-conversation'
import { type ComposerScope, ComposerScopeProvider } from './composer/scope'
import { useSessionTileActions } from './session-tile-actions'
import type { SessionView } from './session-view'

interface AgentVoiceContentProps {
  session: Awaited<ReturnType<typeof openAgentConversationSession>>
  view: SessionView
  target: string
  voiceStartToken?: AgentConversationProps['voiceStartToken']
  initialVoiceText?: AgentConversationProps['initialVoiceText']
  initialCommand?: AgentConversationProps['initialCommand']
  onVoiceStateChange?: AgentConversationProps['onVoiceStateChange']
}

/** Owns the same native submit path without constructing a transcript or editor. */
export function AgentVoiceContent(props: AgentVoiceContentProps) {
  const { session, view, target } = props
  const { requestGateway } = useGatewayRequest()

  const request = useCallback(
    <T,>(method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) =>
      requestForSessionProfile<T>(session.route, requestGateway, method, params, timeoutMs, signal),
    [requestGateway, session.route]
  )

  const scope = useMemo<ComposerScope>(
    () => ({
      $awaitingInput: sessionAwaitingInput(session.runtimeId),
      $messages: view.$messages,
      attachments: createComposerAttachmentScope(),
      connectionId: session.route.connectionId,
      profile: session.route.targetProfile,
      embedded: true,
      target,
      requestGateway: request
    }),
    [request, session, target, view.$messages]
  )

  const actions = useSessionTileActions({
    requestGateway: request,
    runtimeId: session.runtimeId,
    storedSessionId: session.storedSessionId,
    scope
  })

  const busy = useStore(view.$busy)
  useInitialAgentCommand(props.initialCommand, busy, actions.submitText)

  return (
    <ComposerScopeProvider value={scope}>
      <VoiceControls {...props} busy={busy} onInterrupt={actions.cancelRun} onSubmit={actions.submitText} />
    </ComposerScopeProvider>
  )
}

function VoiceControls({
  session,
  view,
  voiceStartToken,
  initialVoiceText,
  onVoiceStateChange,
  busy,
  onSubmit,
  onInterrupt
}: AgentVoiceContentProps & {
  busy: boolean
  onSubmit: ReturnType<typeof useSessionTileActions>['submitText']
  onInterrupt: ReturnType<typeof useSessionTileActions>['cancelRun']
}) {
  const { t } = useI18n()
  const [active, setActive] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  const ready =
    session.voiceLiveStatus?.mode === 'gpt-live' &&
    session.voiceLiveStatus.available &&
    session.voiceLiveStatus.auth === 'codex-subscription'

  const conversation = useVoiceLiveConversation({
    busy,
    enabled: active,
    sessionId: session.runtimeId,
    initialVoiceText,
    onFatalError: () => setActive(false),
    onStopWord: () => setActive(false),
    onInterrupt,
    onSubmit: async (text, voiceContext) => {
      await onSubmit(text, { surface: 'voice-live', voiceContext })
    },
    pendingResponse: () => {
      const messages = view.$messages.get()

      return collectUnspokenTurnSpeech(messages, resolveSpokenReply(session.runtimeId, messages)?.id ?? null)
    },
    consumePendingResponse: () => {
      const messages = view.$messages.get()
      const last = messages.findLast(message => message.role === 'assistant' && !message.hidden)

      if (last) {
        markAssistantIdSpoken(session.runtimeId, messages, last.id)
      }
    },
    seedHistory: () =>
      toLiveHistory(
        view.$messages
          .get()
          .filter(message => !message.hidden && (message.role === 'user' || message.role === 'assistant'))
          .map(message => ({
            role: message.role as 'user' | 'assistant',
            text: chatMessageText(message)
          }))
      ),
    activeToolLabel: () => {
      const last = view.$messages.get().findLast(message => message.role === 'assistant' && !message.hidden)
      const tool = last?.parts.findLast(part => part.type === 'tool-call' && part.result === undefined)

      return tool?.type === 'tool-call' ? tool.toolName : null
    }
  })

  const activate = useCallback(() => setActive(true), [])
  useEmbeddedVoiceStart({
    active,
    activate,
    disabled: !ready || previewing,
    embedded: true,
    end: conversation.end,
    token: voiceStartToken
  })

  const state = useMemo<AgentVoiceState>(
    () => ({ active, connecting: conversation.connecting, muted: conversation.muted, status: conversation.status }),
    [active, conversation.connecting, conversation.muted, conversation.status]
  )

  const listener = useRef(onVoiceStateChange)
  listener.current = onVoiceStateChange
  useEffect(() => {
    listener.current?.(state)
  }, [state])
  useEffect(() => () => listener.current?.({ active: false, connecting: false, muted: false, status: 'idle' }), [])

  const label = conversation.connecting
    ? t.common.connecting
    : conversation.muted
      ? t.composer.muted
      : active
        ? t.composer[conversation.status === 'idle' ? 'listening' : conversation.status]
        : t.composer.startVoice

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 p-2">
      <span
        className={active || !ready ? 'min-w-0 flex-1 truncate text-xs text-muted-foreground' : 'sr-only'}
        role="status"
      >
        {ready ? label : session.voiceLiveStatus?.reason || t.notifications.voice.unavailable}
      </span>
      {!active && (
        <AgentVoicePicker
          onPreviewChange={setPreviewing}
          route={session.route}
          sessionId={session.runtimeId}
        />
      )}
      {active ? (
        <>
          <Button
            aria-label={conversation.muted ? t.composer.unmuteMic : t.composer.muteMic}
            aria-pressed={conversation.muted}
            onClick={conversation.toggleMute}
            size="icon"
            variant="ghost"
          >
            <Codicon name={conversation.muted ? 'mic-off' : 'mic'} />
          </Button>
          <Button
            aria-label={t.composer.endConversation}
            onClick={() => {
              setActive(false)
              void conversation.end()
            }}
            size="icon"
            variant="ghost"
          >
            <Codicon name="debug-stop" />
          </Button>
        </>
      ) : (
        <Button
          aria-label={t.composer.startVoice}
          disabled={!ready || previewing}
          onClick={activate}
          size="icon"
          variant="ghost"
        >
          <Codicon name="mic" />
        </Button>
      )}
    </div>
  )
}
