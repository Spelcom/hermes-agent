import { atom, type ReadableAtom } from 'nanostores'

import { hermesApiAs } from '@/api/client'
import { blobToDataUrl } from '@/app/session/hooks/use-prompt-actions/utils'
import { type CanvasVoiceAgentId, matchCanvasVoiceCommand } from '@/lib/canvas-voice-match'
import { backgroundVoiceOwnership } from '@/lib/canvas-voice-ownership'
import { createCanvasUtterances } from '@/lib/canvas-voice-pcm'
import { type ClientWakeCaptureHandle, startClientWakeCapture } from '@/lib/wake-client-capture'
import type { PluginProfileRoute } from '@/sdk/profile-request'
import { requestGatewayForAgent } from '@/store/gateway'
import { $voicePlayback } from '@/store/voice-playback'
import { $wakeWord, stopClientCapture } from '@/store/wake-word'

export interface CanvasVoiceState {
  enabled: boolean
  listening: boolean
  phase: 'off' | 'starting' | 'listening' | 'transcribing' | 'paused' | 'error'
  error: string | null
}
export interface CanvasVoiceOptions {
  listenerRoute: PluginProfileRoute
  targets: Array<{ id: CanvasVoiceAgentId; route: PluginProfileRoute }>
}
export interface CanvasVoiceCommand {
  route: Readonly<PluginProfileRoute>
  text: string
  sequence: number
}

const state = atom<CanvasVoiceState>({ enabled: false, listening: false, phase: 'off', error: null })
let options: CanvasVoiceOptions | null = null
let capture: ClientWakeCaptureHandle | null = null
let utterances: ReturnType<typeof createCanvasUtterances> | null = null
let epoch = 0
let ready = false
let holds = 0
let sequence = 0
const handoffs = new Set<() => void>()
const listeners = new Set<(command: CanvasVoiceCommand) => void>()

function routeCopy(route: PluginProfileRoute): PluginProfileRoute {
  if (
    !route?.connectionId?.trim() ||
    !route.profile?.trim() ||
    !route.targetProfile?.trim() ||
    !['local', 'remote'].includes(route.mode)
  ) {
    throw new Error('Voice standby requires an exact owner route')
  }

  return Object.freeze({ ...route })
}

function publish(phase: CanvasVoiceState['phase'], error: string | null = null) {
  state.set({ enabled: options !== null, listening: phase === 'listening', phase, error })
}

function stopCapture() {
  capture?.stop()
  capture = null
  utterances?.stop()
  utterances = null
}

function fail(error: unknown) {
  epoch++
  ready = false
  stopCapture()
  publish('error', error instanceof Error ? error.message : String(error))
}

async function assertLocalReady(route: PluginProfileRoute) {
  const routes = await window.hermesDesktop?.getProfileRoutes?.([route.profile])

  if (
    !routes?.some(
      candidate =>
        candidate.connectionId === route.connectionId &&
        candidate.profile === route.profile &&
        candidate.targetProfile === route.targetProfile &&
        candidate.mode === 'local'
    )
  ) {
    throw new Error('Background voice requires an authoritative local connection')
  }

  const config = await hermesApiAs<{
    stt?: { enabled?: boolean; provider?: string; providers?: Record<string, { type?: string }> }
  }>({ connectionId: route.connectionId, profile: route.targetProfile }, { path: '/api/config' })

  if (
    config.stt?.enabled !== true ||
    config.stt.provider !== 'whisper_cpp_local' ||
    config.stt.providers?.whisper_cpp_local?.type !== 'command'
  ) {
    throw new Error('Background voice requires the configured offline whisper_cpp_local provider')
  }
}

async function transcribe(audio: Blob, generation: number, current: CanvasVoiceOptions) {
  if (generation !== epoch || !options || state.get().phase === 'transcribing') {
    return
  }

  publish('transcribing')

  try {
    const data = await blobToDataUrl(audio)

    if (generation !== epoch || !options) {
      return
    }

    const result = await hermesApiAs<{ transcript?: string }>(
      { connectionId: current.listenerRoute.connectionId, profile: current.listenerRoute.targetProfile },
      {
        path: '/api/audio/transcribe-local',
        method: 'POST',
        body: { data_url: data, mime_type: 'audio/wav', local_only: true },
        timeoutMs: 60_000
      }
    )

    if (generation !== epoch || !options) {
      return
    }

    const command = matchCanvasVoiceCommand(result.transcript || '')
    const target = command && current.targets.find(item => item.id === command.id)

    if (target && command && listeners.size) {
      const releaseOwner = pause()

      const release = () => {
        handoffs.delete(release)
        releaseOwner()
      }

      handoffs.add(release)
      const event = { route: target.route, text: command.text, sequence: ++sequence }

      try {
        for (const listener of listeners) {
          listener(event)
        }
      } finally {
        window.setTimeout(release, 3000)
      }
    }
  } catch (error) {
    if (generation === epoch && options) {
      fail(error)
    }
  } finally {
    if (generation === epoch && options) {
      publish('listening')
    }
  }
}

async function arm() {
  const current = options

  if (!current || !ready) {
    return
  }

  const generation = ++epoch
  stopCapture()

  if (holds) {
    publish('paused')

    return
  }

  publish('starting')

  try {
    const granted = await window.hermesDesktop?.requestMicrophoneAccess?.()

    if (generation !== epoch || !options) {
      return
    }

    if (granted === false) {
      throw new Error('Microphone access was denied')
    }

    utterances = createCanvasUtterances(audio => {
      void transcribe(audio, generation, current)
    })

    const opened = await startClientWakeCapture({
      silenceFramesThreshold: Number.MAX_SAFE_INTEGER,
      request: async (_method, params) => {
        if (generation === epoch && options && state.get().phase !== 'transcribing') {
          utterances?.feed(String(params?.pcm || ''))
        }

        return { fed: true }
      },
      onError: error => {
        if (generation === epoch && options) {
          fail(error)
        }
      }
    })

    if (generation !== epoch || !options) {
      opened.stop()

      return
    }

    capture = opened
    publish('listening')
  } catch (error) {
    if (generation === epoch && options) {
      fail(error)
    }
  }
}

function pause(): () => void {
  holds++
  epoch++
  stopCapture()

  if (options) {
    publish('paused')
  }

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    holds = Math.max(0, holds - 1)

    if (!holds && options && ready) {
      void arm()
    }
  }
}

async function enable(input: CanvasVoiceOptions): Promise<void> {
  const listenerRoute = routeCopy(input.listenerRoute)

  if (listenerRoute.mode !== 'local') {
    throw new Error('Background voice never uploads audio to remote STT')
  }

  const targets = input.targets.map(item => ({ id: item.id, route: routeCopy(item.route) }))

  if (!targets.length || new Set(targets.map(item => item.id)).size !== targets.length) {
    throw new Error('Background voice targets must be unique exact agent routes')
  }

  disable()
  const current = { listenerRoute, targets }
  options = current
  backgroundVoiceOwnership.setReserved(true)
  publish('starting')

  try {
    await assertLocalReady(listenerRoute)

    if (options !== current) {
      return
    }

    const legacyActive = $wakeWord.get().listening
    stopClientCapture()

    if (legacyActive) {
      await requestGatewayForAgent(listenerRoute.connectionId, listenerRoute.profile, 'wake.pause', {})
    }

    if (options !== current) {
      return
    }

    ready = true
    await arm()
  } catch (error) {
    if (options === current) {
      fail(error)
    }
  }
}

function disable(): void {
  options = null
  backgroundVoiceOwnership.setReserved(false)
  ready = false
  epoch++

  for (const release of handoffs) {
    release()
  }

  stopCapture()
  publish('off')
}

/** One local standby owner, off until a manual ON gesture; no transcript persistence. */
export const canvasVoice = {
  state: state as ReadableAtom<CanvasVoiceState>,
  enable,
  disable,
  pause,
  onCommand(handler: (command: CanvasVoiceCommand) => void) {
    listeners.add(handler)

    return () => {
      listeners.delete(handler)
    }
  }
}

backgroundVoiceOwnership.register(pause)
let releasePlayback: (() => void) | undefined
$voicePlayback.subscribe(playback => {
  if (playback.status !== 'idle') {
    releasePlayback ??= pause()
  } else {
    releasePlayback?.()
    releasePlayback = undefined
  }
})
