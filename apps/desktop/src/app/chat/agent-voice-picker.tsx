import { useEffect, useMemo, useState } from 'react'

import { saveHermesConfigRecord } from '@/api/config'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { fetchVoiceLiveStatus, type VoiceLiveStatus } from '@/lib/voice-live'
import type { PluginProfileRoute } from '@/sdk/profile-request'
import { applyVoiceOutputGain, voiceOutputLevel } from '@/store/voice-output'

import { captureAgentConversationRoute } from './agent-conversation-session'
import { AgentVoiceCheck } from './agent-voice-check'
import { AgentVoiceOutputLevel } from './agent-voice-output-level'

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
    const owner = { connectionId, profile: targetProfile }
    const previousOutput = voiceOutputLevel(owner).get()
    void fetchVoiceLiveStatus(owner).then(next => {
      if (current) {
        setStatus(next)

        if (next) {
          applyVoiceOutputGain(owner, next.output_gain, previousOutput)
        }
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
    <div className={cn('flex min-w-0 max-w-full flex-col gap-2', className)}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
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
          <SelectTrigger aria-label={t.composer.voiceControls} className="flex-1 basis-20" size="sm">
            <SelectValue className="truncate" />
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
          className="flex-1 basis-36"
          disabled={disabled || saving}
          onCheckingChange={value => {
            setPreviewing(value)
            onPreviewChange?.(value)
          }}
          route={route}
          sessionId={sessionId}
        />
      </div>
      <AgentVoiceOutputLevel route={route} />
      {error && (
        <p className="text-xs [overflow-wrap:anywhere] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
