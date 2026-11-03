import { useStore } from '@nanostores/react'

import { Codicon } from '@/components/ui/codicon'
import type { CanvasVoiceAgentId } from '@/lib/canvas-voice-match'
import type { PluginProfileRoute } from '@/sdk/profile-request'
import { canvasVoice } from '@/store/canvas-voice'
import { notifyError } from '@/store/notifications'

import type { StatusbarItem } from './statusbar-controls'

const labels = {
  off: 'Голос OFF',
  starting: 'Микрофон…',
  listening: 'Слушаю имена',
  transcribing: 'Распознаю локально…',
  paused: 'Голос: разговор',
  error: 'Голос: ошибка'
}

const profiles: Array<[CanvasVoiceAgentId, string]> = [
  ['ciel', 'default'],
  ['kai', 'developer'],
  ['ren', 'analyst'],
  ['mio', 'editor'],
  ['yuki', 'qwen-local']
]

async function enableLocalStandby() {
  const routes = (await window.hermesDesktop?.getProfileRoutes?.(profiles.map(([, profile]) => profile))) ?? []
  const local = routes.filter(route => route.mode === 'local' && route.targetProfile === 'default')
  const primary = local.filter(route => route.primary)
  const listener = primary.length === 1 ? primary[0] : local.length === 1 ? local[0] : undefined

  if (!listener) {
    throw new Error('Не найден однозначный локальный профиль Ciel. Включите голос на канвасе.')
  }

  const targets = profiles.flatMap(([id, profile]) => {
    const matches = routes.filter(
      route => route.connectionId === listener.connectionId && route.targetProfile === profile
    )

    return matches.length === 1 ? [{ id, route: matches[0] as PluginProfileRoute }] : []
  })

  await canvasVoice.enable({ listenerRoute: listener, targets })
}

function CanvasVoiceStatusbar() {
  const state = useStore(canvasVoice.state)

  const toggle = () => {
    if (state.enabled) {
      canvasVoice.disable()
    } else {
      void enableLocalStandby().catch(error => notifyError(error, 'Не удалось включить локальное слушание'))
    }
  }

  return (
    <button
      aria-label="Фоновое локальное слушание: включить или выключить"
      aria-pressed={state.enabled}
      className="inline-flex h-full items-center gap-1 px-2 text-[0.6875rem] hover:bg-accent"
      onClick={toggle}
      title={
        state.error ?? 'Только локальный Whisper. Команды отправляются сотруднику после имени. OFF закрывает фоновый микрофон.'
      }
    >
      <Codicon name={state.enabled ? 'mic' : 'mute'} />
      <span>{labels[state.phase]}</span>
    </button>
  )
}

export const canvasVoiceStatusbarItem: StatusbarItem = {
  id: 'canvas-local-voice',
  lockedVisible: true,
  render: () => <CanvasVoiceStatusbar />
}
