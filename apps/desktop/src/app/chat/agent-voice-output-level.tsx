import { useStore } from '@nanostores/react'
import { useId, useRef, useState } from 'react'

import { saveHermesConfigRecord } from '@/api/config'
import { Slider } from '@/components/ui/slider'
import { useI18n } from '@/i18n'
import type { PluginProfileRoute } from '@/sdk/profile-request'
import { applyVoiceOutputGain, MAX_VOICE_OUTPUT_GAIN, voiceOutputLevel } from '@/store/voice-output'

export function AgentVoiceOutputLevel({ route }: { route: PluginProfileRoute }) {
  const { t } = useI18n()
  const id = useId()
  const owner = { connectionId: route.connectionId, profile: route.targetProfile }
  const level = voiceOutputLevel(owner)
  const { gain } = useStore(level)
  const beforeAdjustment = useRef<ReturnType<typeof level.get> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const commit = () => {
    const previous = beforeAdjustment.current

    if (!previous || saving) {
      return
    }

    beforeAdjustment.current = null
    const chosen = level.get()
    setSaving(true)
    setError('')
    void saveHermesConfigRecord({ voice: { gpt_live: { output_gain: chosen.gain } } }, owner)
      .then(result => {
        if (!result.ok) {
          throw new Error(t.settings.config.autosaveFailed)
        }
      })
      .catch(reason => {
        applyVoiceOutputGain(owner, previous.gain, chosen)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="min-w-0 w-full text-xs">
      <label className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" htmlFor={id}>
        <span className="min-w-0 [overflow-wrap:anywhere]">{t.composer.voiceOutputLevel}</span>
        <Slider
          className="min-w-0 flex-1 basis-16"
          disabled={saving}
          id={id}
          max={MAX_VOICE_OUTPUT_GAIN * 100}
          min={0}
          onBlur={commit}
          onChange={event => {
            beforeAdjustment.current ??= level.get()
            applyVoiceOutputGain(owner, Number(event.target.value) / 100)
          }}
          onKeyUp={commit}
          onPointerUp={commit}
          step={10}
          value={Math.round(gain * 100)}
        />
        <output className="shrink-0 tabular-nums" htmlFor={id}>
          {Math.round(gain * 100)}%
        </output>
      </label>
      {error && (
        <p className="mt-1 [overflow-wrap:anywhere] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
