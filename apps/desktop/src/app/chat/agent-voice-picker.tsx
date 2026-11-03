import { useEffect, useMemo, useState } from 'react'

import { saveHermesConfigRecord } from '@/api/config'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { fetchVoiceLiveStatus, type VoiceLiveStatus } from '@/lib/voice-live'
import type { PluginProfileRoute } from '@/sdk/profile-request'

import { captureAgentConversationRoute } from './agent-conversation-session'
import { AgentVoiceCheck } from './agent-voice-check'

export interface AgentVoicePickerProps {
  route: PluginProfileRoute
  disabled?: boolean
  className?: string
  sessionId?: string
  onPreviewChange?: (previewing: boolean) => void
}

/** Profile configuration is durable; a running call keeps the voice it started with. */
export function AgentVoicePicker(props: AgentVoicePickerProps) {
  const { connectionId, mode, primary, profile, targetProfile } = props.route

  const route = useMemo(
    () => captureAgentConversationRoute({ connectionId, mode, primary, profile, targetProfile }),
    [connectionId, mode, primary, profile, targetProfile]
  )

  return (
    <OwnedVoicePicker key={JSON.stringify([connectionId, mode, profile, targetProfile])} {...props} route={route} />
  )
}

function OwnedVoicePicker({ route, disabled, className, sessionId, onPreviewChange }: AgentVoicePickerProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<VoiceLiveStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState('')
  const { connectionId, targetProfile } = route
  useEffect(() => {
    let current = true
    setStatus(null)
    setError('')
    void fetchVoiceLiveStatus({ connectionId, profile: targetProfile }).then(next => {
      if (current) {
        setStatus(next)
      }
    })

    return () => {
      current = false
    }
  }, [connectionId, targetProfile])

  if (status?.auth !== 'codex-subscription' || !status.voices?.length) {
    return null
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <Select
          disabled={disabled || saving || previewing}
          onValueChange={voice => {
            setSaving(true)
            setError('')
            void saveHermesConfigRecord({ voice: { gpt_live: { voice } } }, { connectionId, profile: targetProfile })
              .then(result => {
                if (!result.ok) {
                  throw new Error(t.settings.config.autosaveFailed)
                }

                setStatus(previous => (previous ? { ...previous, voice } : previous))
              })
              .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => setSaving(false))
          }}
          value={status.voice}
        >
          <SelectTrigger aria-label={t.composer.voiceControls} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {status.voices.map(voice => (
              <SelectItem key={voice} value={voice}>
                {voice[0].toUpperCase() + voice.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AgentVoiceCheck
          disabled={disabled || saving}
          onCheckingChange={value => {
            setPreviewing(value)
            onPreviewChange?.(value)
          }}
          route={route}
          sessionId={sessionId}
        />
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
