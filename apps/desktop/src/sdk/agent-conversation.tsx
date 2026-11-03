import { lazy, Suspense } from 'react'

import type { PluginProfileRoute } from './profile-request'

export interface AgentVoiceState {
  active: boolean
  connecting: boolean
  muted: boolean
  status: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'
}

export interface AgentConversationProps {
  route: PluginProfileRoute
  /** Voice controls without mounting a transcript, editor, or full chat surface. */
  presentation?: 'chat' | 'voice-only'
  onVoiceStateChange?: (state: AgentVoiceState) => void
  /** New token only on an explicit microphone click; omission mounts text chat. */
  voiceStartToken?: string | number
  /** A name-wake suffix delivered once to the connected voice session. */
  initialVoiceText?: { token: string | number; text: string }
  /** One locally matched name-prefixed command, consumed once after exact-owner hydration. */
  initialCommand?: { token: string | number; text: string }
  onClose?: () => void
  className?: string
  title?: string
}

const NativeAgentConversation = lazy(() => import('@/app/chat/agent-conversation'))

/** Native canonical agent chat inside the caller's container, without navigation. */
export function AgentConversation(props: AgentConversationProps) {
  return (
    <Suspense
      fallback={
        <div className="p-4" role="status">
          …
        </div>
      }
    >
      <NativeAgentConversation {...props} />
    </Suspense>
  )
}
