import { CANONICAL_GATEWAY_PROTOCOL } from '@/api/canonical-protocol'
import { hermesApiAs, type OwnerScope, profileScoped, type ResolvedOwner, resolveOwnerNow } from '@/api/client'
import { hermesApi } from '@/hermes'
import { pauseBackgroundVoice } from '@/lib/canvas-voice-ownership'
import { resolveVoiceLiveCallUrl } from '@/lib/voice-live-call-url'
import { createVoiceLiveOutput } from '@/lib/voice-live-output'
import { delegationRequest, LiveTranscriptAccumulator, liveWireEvent } from '@/lib/voice-live-protocol'
import { withTimeout } from '@/lib/with-timeout'
import { applyVoiceOutputGain, voiceOutputLevel } from '@/store/voice-output'

/**
 * GPT-Live voice chat: the full-duplex voice frontend that DELEGATES to Hermes.
 *
 * `voice.voice_chat_mode: gpt-live` swaps the chained mic → STT → turn → TTS
 * loop for one OpenAI voice model (`gpt-live-1`) that listens and speaks at
 * the same time over WebRTC and has no tools of its own. Whenever the user
 * asks for real work it emits `session.delegation.created`; the desktop turns
 * that into an ordinary Hermes turn on the open session and streams the reply
 * back with `session.commentary.append`, which the voice paraphrases aloud.
 * Hermes keeps every capability — model choice, tools, memory, approvals.
 *
 * This module owns the transport only: session creation via the gateway
 * (the OpenAI key never reaches the renderer), the RTCPeerConnection, the
 * `oai-events` data channel, transcript accumulation and the command
 * surface the conversation hook drives. Vendor contract:
 * https://developers.openai.com/api/docs/guides/live-delegation
 */

export type VoiceChatMode = 'chained' | 'gpt-live'

export interface VoiceLiveStatus {
  mode: VoiceChatMode
  available: boolean
  reason: null | string
  model: string
  voice: string
  /** Native Codex choices, separate from the direct API voice catalog. */
  voices?: string[]
  auth?: 'codex-subscription' | 'api-key'
  wire_protocol?: 'codex-v3' | 'live-api'
  output_gain?: number
}

export interface LiveHistoryMessage {
  type: 'message'
  role: 'assistant' | 'developer' | 'user'
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>
}

export interface LiveTranscriptFragment {
  speaker: 'assistant' | 'user'
  text: string
  startMs: number
  endMs: number
}

export interface VoiceLiveHandlers {
  /** GPT-Live asked the backend (Hermes) for help. `context` is the recent
   *  transcript window, newest last — the delegation itself carries no text. */
  onDelegation: (delegationId: string, context: LiveTranscriptFragment[], prompt?: string) => void
  /** Vendor-side error. `fatal` when the session is gone. */
  onError: (message: string, fatal: boolean) => void
  /** `session.closed` arrived (or the transport dropped without it). */
  onClosed: (reason: string, usageSeconds: null | number) => void
  /** Transcript deltas, for captions / live UI. */
  onTranscript?: (fragment: LiveTranscriptFragment) => void
  /** Assistant audio output level hint: the remote track is speaking. */
  onSpeakingChange?: (speaking: boolean) => void
}

const CLOSE_TIMEOUT_MS = 15_000
const ICE_GATHER_TIMEOUT_MS = 10_000
// Vendor cap: 500 tokens per append. ~4 chars/token, keep headroom.
const APPEND_CHAR_LIMIT = 1_400

// How much conversation the backend receives per delegation.
const STARTUP_FAILURE_MESSAGE = {
  permission:
    'Система не ответила на запрос доступа к микрофону за 60 секунд. Проверьте настройки микрофона и повторите.',
  capture: 'Запрос записи с микрофона не завершился за 60 секунд. Проверьте выбранный микрофон и доступ к нему.',
  voice: 'Не удалось соединиться с голосом за 60 секунд. Попробуйте ещё раз.'
}

const CONTEXT_WINDOW_MS = 5 * 60_000
const CONTEXT_MAX_FRAGMENTS = 80

export async function fetchVoiceLiveStatus(owner?: ResolvedOwner): Promise<null | VoiceLiveStatus> {
  try {
    const request = { path: '/api/audio/voice-live/status' }

    const response = owner
      ? await hermesApiAs<{ ok: boolean } & VoiceLiveStatus>(owner, request)
      : await hermesApi<{ ok: boolean } & VoiceLiveStatus>({ ...profileScoped(), ...request })

    if (!response?.ok) {
      return null
    }

    return {
      available: Boolean(response.available),
      mode: response.mode === 'gpt-live' ? 'gpt-live' : 'chained',
      model: response.model,
      reason: response.reason ?? null,
      voice: response.voice,
      voices: response.voices,
      auth: response.auth,
      wire_protocol: response.wire_protocol,
      output_gain: response.output_gain
    }
  } catch {
    // Older backend without the endpoint → chained.
    return null
  }
}

/** Split a reply into append-sized chunks on sentence boundaries. */
export function chunkForCommentary(text: string, limit = APPEND_CHAR_LIMIT): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()

  if (!clean) {
    return []
  }

  if (clean.length <= limit) {
    return [clean]
  }

  const chunks: string[] = []
  let current = ''

  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > limit) {
      if (current) {
        chunks.push(current)
        current = ''
      }

      for (let index = 0; index < sentence.length; index += limit) {
        chunks.push(sentence.slice(index, index + limit))
      }

      continue
    }

    const candidate = current ? `${current} ${sentence}` : sentence

    if (candidate.length > limit) {
      chunks.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

/** Seed history for a new Live session from the chat transcript (text turns only). */
export function toLiveHistory(
  turns: Array<{ role: 'assistant' | 'user'; text: string }>,
  maxMessages = 24,
  maxChars = 6_000
): LiveHistoryMessage[] {
  const out: LiveHistoryMessage[] = []
  let budget = maxChars

  for (const turn of [...turns].reverse()) {
    const text = turn.text.replace(/\s+/g, ' ').trim().slice(0, 1_200)

    if (!text) {
      continue
    }

    if (out.length >= maxMessages || budget - text.length < 0) {
      break
    }

    budget -= text.length
    out.unshift({
      content: [{ text, type: turn.role === 'assistant' ? 'output_text' : 'input_text' }],
      role: turn.role,
      type: 'message'
    })
  }

  return out
}

async function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', onState)
      // Trickle is fine: the vendor answers with the candidates it has.
      resolve()
    }, ICE_GATHER_TIMEOUT_MS)

    function onState() {
      if (connection.iceGatheringState !== 'complete') {
        return
      }

      window.clearTimeout(timeout)
      connection.removeEventListener('icegatheringstatechange', onState)
      resolve()
    }

    connection.addEventListener('icegatheringstatechange', onState)
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') {
        window.clearTimeout(timeout)
        reject(new Error('WebRTC connection failed'))
      }
    })
  })
}

export class VoiceLiveSession {
  private releaseStandby: (() => void) | undefined
  readonly audio: HTMLAudioElement
  /** Whose (connection, profile) this session dials; null → the active scope.
   *  A Bot chat runs its GPT-Live session on the Bot's own profile, so the
   *  voice configured there is the voice that answers. */
  private readonly owner: null | OwnerScope
  private readonly handlers: VoiceLiveHandlers
  private peer: null | RTCPeerConnection = null
  private events: null | RTCDataChannel = null
  private microphone: null | MediaStream = null
  private muted = false
  private silentInputContext: null | AudioContext = null
  private silentInputSource: null | ConstantSourceNode = null
  private silentInputStream: null | MediaStream = null
  private closeTimer: null | number = null
  private finalized = false
  private started = false
  private startupStage: 'permission' | 'capture' | 'voice' = 'permission'
  private eventCounter = 0
  private readonly transcript = new LiveTranscriptAccumulator()
  private readonly delegations = new Set<string>()
  private wireProtocol: 'live-api' | 'codex-v3' = 'live-api'
  private lease: WebSocket | null = null
  private leasePing: number | null = null
  private call: { id: string; token: string; sessionId: string } | null = null
  private callOwner: ResolvedOwner | null = null
  private speakingProbe: null | number = null
  private output: ReturnType<typeof createVoiceLiveOutput> | null = null
  private releaseOutputLevel: (() => void) | null = null
  private lastSpeaking = false
  sessionId: null | string = null
  /** The delegation currently being answered by Hermes; late results for an
   *  older id are dropped by the conversation hook. */
  activeDelegationId: null | string = null

  constructor(handlers: VoiceLiveHandlers, owner: null | OwnerScope = null) {
    this.handlers = handlers
    this.owner = owner
    this.audio = new Audio()
    this.audio.autoplay = true
  }

  get connected(): boolean {
    return this.started && this.events?.readyState === 'open'
  }

  private nextEventId(prefix: string): string {
    this.eventCounter += 1

    return `${prefix}_${this.eventCounter}`
  }

  private send(event: Record<string, unknown>): boolean {
    if (!this.events || this.events.readyState !== 'open') {
      return false
    }

    this.events.send(JSON.stringify(event))

    return true
  }

  /** Recent conversation, oldest first, bounded by time and count. */
  contextWindow(): LiveTranscriptFragment[] {
    const last = this.transcript.fragments.at(-1)

    if (!last) {
      return []
    }

    const floor = last.endMs - CONTEXT_WINDOW_MS

    return this.transcript.fragments.filter(fragment => fragment.endMs >= floor).slice(-CONTEXT_MAX_FRAGMENTS)
  }

  async start(
    history: LiveHistoryMessage[],
    ownerSessionId?: string | null,
    options: { microphone?: boolean } = {}
  ): Promise<void> {
    await withTimeout(
      this.openConnection(history, ownerSessionId, options),
      60_000,
      'Не удалось соединиться с голосом за 60 секунд. Попробуйте ещё раз.',
      error => {
        error.message = STARTUP_FAILURE_MESSAGE[this.startupStage]

        this.finish('close_requested', null)
      }
    )
  }

  private async openConnection(
    history: LiveHistoryMessage[],
    ownerSessionId?: string | null,
    options: { microphone?: boolean } = {}
  ): Promise<void> {
    if (this.peer) {
      throw new Error('GPT-Live session already started')
    }

    this.callOwner = resolveOwnerNow(this.owner ?? undefined)
    const outputLevel = voiceOutputLevel(this.callOwner)
    const initialOutputLevel = outputLevel.get()
    this.releaseOutputLevel = outputLevel.listen(({ gain }) => {
      this.output?.setGain(gain)

      if (!this.output) {
        this.audio.volume = Math.min(1, gain)
      }
    })
    this.releaseStandby = pauseBackgroundVoice()
    const connection = new RTCPeerConnection()
    this.peer = connection

    connection.addEventListener('track', event => {
      const stream = new MediaStream([event.track])

      if (this.finalized) {
        return
      }

      this.audio.srcObject = stream
      this.armSpeakingProbe(stream)
      void this.audio.play().catch(() => undefined)
    })
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
        this.finish('connection_lost', null)
      }
    })

    if (options.microphone === false) {
      this.startupStage = 'voice'
      await this.openSilentInput(connection)
    } else {
      await this.openMicrophone(connection)
    }

    if (this.finalized) {
      return
    }

    this.startupStage = 'voice'

    // Register the data channel before the offer so its m-line is negotiated.
    const events = connection.createDataChannel('oai-events')
    this.events = events
    events.addEventListener('message', ({ data }) => this.handleEvent(String(data)))
    events.addEventListener('close', () => {
      if (!this.finalized) {
        this.finish('connection_lost', null)
      }
    })

    const offer = await connection.createOffer()
    await connection.setLocalDescription(offer)
    await waitForIceGathering(connection)

    const sdp = connection.localDescription?.sdp

    if (!sdp) {
      throw new Error('Missing local SDP offer')
    }

    if (this.finalized) {
      return
    }

    const response = await hermesApiAs<{
      ok: boolean
      session?: { id: string }
      transport?: { sdp: string; type: string }
      wire_protocol?: 'live-api' | 'codex-v3'
      call_id?: string
      call_token?: string
      session_id?: string
      output_gain?: number
    }>(this.callOwner, {
      body: { history, sdp, session_id: ownerSessionId },
      method: 'POST',
      path: '/api/audio/voice-live/session',
      timeoutMs: 45_000
    })

    if (!response?.ok || !response.transport?.sdp) {
      throw new Error('GPT-Live session creation failed')
    }

    applyVoiceOutputGain(this.callOwner, response.output_gain, initialOutputLevel)
    this.wireProtocol = response.wire_protocol ?? 'live-api'
    this.sessionId = response.session?.id ?? null

    if (this.wireProtocol === 'codex-v3') {
      if (!response.call_id || !response.call_token || !ownerSessionId) {
        throw new Error('Codex voice did not return a conversation lease')
      }

      this.call = { id: response.call_id, token: response.call_token, sessionId: ownerSessionId }

      if (this.finalized) {
        this.releaseCall()

        return
      }

      await this.attachLease()
    }

    if (this.finalized) {
      return
    }

    await connection.setRemoteDescription({ sdp: response.transport.sdp, type: 'answer' })
    await this.waitUntilConnected()
    this.started = !this.finalized
  }

  private async openMicrophone(connection: RTCPeerConnection): Promise<void> {
    this.startupStage = 'permission'
    const permitted = await window.hermesDesktop?.requestMicrophoneAccess?.()

    if (this.finalized) {
      return
    }

    if (permitted === false) {
      throw new DOMException('Microphone access denied', 'NotAllowedError')
    }

    this.startupStage = 'capture'

    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true }
    })

    if (this.finalized) {
      microphone.getTracks().forEach(track => track.stop())

      return
    }

    this.microphone = microphone

    for (const track of microphone.getAudioTracks()) {
      track.enabled = !this.muted
      connection.addTrack(track, microphone)
    }
  }

  /** Match Codex native send/receive negotiation without opening an input device. */
  private async openSilentInput(connection: RTCPeerConnection): Promise<void> {
    const context = new AudioContext()
    this.silentInputContext = context
    const destination = context.createMediaStreamDestination()
    this.silentInputStream = destination.stream
    const source = context.createConstantSource()
    source.offset.value = 0
    source.connect(destination)
    source.start()
    this.silentInputSource = source

    for (const track of destination.stream.getAudioTracks()) {
      connection.addTrack(track, destination.stream)
    }

    await context.resume()
  }

  private armSpeakingProbe(stream: MediaStream): void {
    try {
      this.clearOutput()
      const output = createVoiceLiveOutput(stream, voiceOutputLevel(this.callOwner!).get().gain)
      this.output = output
      const analyser = output.analyser
      // Keep the media element alive for WebRTC, but never play the track twice.
      this.audio.muted = true
      void output.resume().catch(() => {
        if (this.output === output) {
          this.clearOutput()
          this.audio.muted = false
          this.audio.volume = Math.min(1, voiceOutputLevel(this.callOwner!).get().gain)
        }
      })
      const buffer = new Uint8Array(analyser.frequencyBinCount)
      let quietFrames = 0

      this.speakingProbe = window.setInterval(() => {
        analyser.getByteTimeDomainData(buffer)
        let peak = 0
        let sumSquares = 0

        for (const sample of buffer) {
          peak = Math.max(peak, Math.abs(sample - 128))
          sumSquares += (sample - 128) ** 2
        }

        const loud = peak > 6 && Math.sqrt(sumSquares / buffer.length) > 1
        quietFrames = loud ? 0 : quietFrames + 1
        const speaking = loud || (this.lastSpeaking && quietFrames < 4)

        if (speaking !== this.lastSpeaking) {
          this.lastSpeaking = speaking
          this.handlers.onSpeakingChange?.(speaking)
        }
      }, 100)
    } catch {
      // Device/context failure keeps unamplified HTML playback available.
      this.audio.muted = false
      this.audio.volume = Math.min(1, voiceOutputLevel(this.callOwner!).get().gain)
    }
  }

  private clearOutput(): void {
    if (this.speakingProbe) {
      window.clearInterval(this.speakingProbe)
      this.speakingProbe = null
    }

    this.output?.close()
    this.output = null
    this.lastSpeaking = false
  }

  private async attachLease(): Promise<void> {
    const call = this.call!

    const url = new URL(await resolveVoiceLiveCallUrl(this.callOwner!, call.id))

    url.searchParams.set('session_id', call.sessionId)

    if (this.callOwner?.profile) {
      url.searchParams.set('profile', this.callOwner.profile)
    }

    if (this.finalized) {
      return
    }

    const ticket = url.searchParams.get('ticket')
    const native = url.searchParams.has('native_dial')

    if (native && !ticket) {
      throw new Error('Native gateway requires a fresh private ticket')
    }

    if (native) {
      url.searchParams.delete('ticket')
    }

    const socket = native
      ? new WebSocket(url.toString(), [CANONICAL_GATEWAY_PROTOCOL, `hermes-gateway-ticket.${ticket}`])
      : new WebSocket(url.toString())

    this.lease = socket
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Codex voice connection timed out')), 10_000)

      const fail = (code: number) => {
        window.clearTimeout(timeout)
        reject(new Error(`Codex voice connection closed (code ${code})`))
      }

      socket.addEventListener('open', () =>
        socket.send(JSON.stringify({ type: 'authenticate', call_token: call.token, session_id: call.sessionId }))
      )
      socket.addEventListener('message', ({ data }) => {
        const event = liveWireEvent(String(data))

        if (event?.type === 'lease.ready') {
          window.clearTimeout(timeout)
          this.leasePing = window.setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ping' }))
            }
          }, 15_000)
          resolve()
        } else {
          this.handleEvent(String(data))
        }
      })
      socket.addEventListener('close', event => {
        fail(event.code)
        this.finish(`Codex voice connection closed (code ${event.code})`, null)
      })
    })
  }

  private releaseCall(): void {
    const call = this.call
    this.call = null

    if (call && this.callOwner) {
      void hermesApiAs(this.callOwner, {
        path: `/api/audio/voice-live/calls/${encodeURIComponent(call.id)}/close`,
        method: 'POST',
        body: { call_token: call.token, session_id: call.sessionId }
      }).catch(() => undefined)
    }
  }

  private handleEvent(raw: string): void {
    if (this.finalized) {
      return
    }

    const event = liveWireEvent(raw)

    if (!event) {
      return
    }

    const fragment = this.transcript.append(event)

    if (fragment) {
      this.handlers.onTranscript?.(fragment)

      return
    }

    const delegation = delegationRequest(event)

    if (delegation) {
      if (!this.delegations.has(delegation.id)) {
        this.delegations.add(delegation.id)
        this.activeDelegationId = delegation.id
        this.handlers.onDelegation(delegation.id, this.contextWindow(), delegation.prompt)
      }

      return
    }

    if (event.type === 'session.started') {
      this.started = true
      this.sessionId = event.session?.id ?? this.sessionId
    } else if (event.type === 'error') {
      const code = event.error?.code ?? ''

      if (code === 'context_injection_incomplete') {
        return
      }

      const fatal =
        ['authentication_error', 'invalid_api_key', 'invalid_token', 'token_expired'].includes(code) ||
        [401, 403].includes(event.error?.status ?? 0)

      this.handlers.onError(
        fatal
          ? 'Codex voice authorization failed. Sign in to Codex and try again.'
          : (event.error?.message ?? 'Live voice error'),
        fatal
      )

      if (fatal) {
        this.finish('authorization_failed', null)
      }
    } else if (event.type === 'session.closed') {
      this.finish(event.reason ?? 'closed', event.usage?.seconds ?? null)
    }
  }

  /** Await the negotiated event channel before a user-triggered voice check. */
  async waitUntilConnected(timeoutMs = 10_000): Promise<void> {
    if (this.events?.readyState === 'open') {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error('Не удалось соединиться с голосом'))
      }, timeoutMs)

      const opened = () => {
        cleanup()
        resolve()
      }

      const closed = () => {
        cleanup()
        reject(new Error('Голосовое соединение закрыто'))
      }

      const cleanup = () => {
        window.clearTimeout(timeout)
        this.events?.removeEventListener('open', opened)
        this.events?.removeEventListener('close', closed)
      }

      this.events?.addEventListener('open', opened)
      this.events?.addEventListener('close', closed)

      if (this.finalized) {
        closed()
      }
    })
  }

  /** A typed name-wake suffix enters the same live model as microphone speech. */
  appendUserText(text: string): void {
    const clean = text.trim()

    if (clean && !this.finalized) {
      this.appendContext(
        null,
        `The user said: ${JSON.stringify(clean)}. Respond to this request and delegate any worker task normally.`,
        true
      )
      const fragment = this.transcript.append({ type: 'input_transcript.added', item: { text: clean } })

      if (fragment) {
        this.handlers.onTranscript?.(fragment)
      }
    }
  }

  /** Quiet progress for the live model ("Hermes is running the tests…"). */
  think(delegationId: null | string, content: string): void {
    const text = content.replace(/\s+/g, ' ').trim().slice(0, APPEND_CHAR_LIMIT)

    if (text) {
      if (this.wireProtocol === 'codex-v3') {
        this.appendContext(delegationId, text, false)

        return
      }

      this.send({
        content: text,
        delegation_id: delegationId,
        event_id: this.nextEventId('think'),
        type: 'session.thinking.append'
      })
    }
  }

  /** A result the voice should say aloud (paraphrased). */
  speak(delegationId: null | string, content: string): void {
    for (const chunk of chunkForCommentary(content)) {
      if (this.wireProtocol === 'codex-v3') {
        this.appendContext(delegationId, chunk, true)

        continue
      }

      this.send({
        content: chunk,
        delegation_id: delegationId,
        event_id: this.nextEventId('say'),
        type: 'session.commentary.append'
      })
    }
  }

  private appendContext(delegationId: null | string, text: string, speakable: boolean): void {
    this.send({
      type: delegationId ? 'delegation.context.append' : 'session.context.append',
      ...(delegationId ? { delegation_item_id: delegationId } : {}),
      channel: speakable ? 'speakable' : 'commentary',
      content: [{ type: 'input_text', text }]
    })
  }

  /** Steer the live persona mid-conversation (session-wide). */
  instruct(content: string): void {
    const text = content.trim().slice(0, APPEND_CHAR_LIMIT)

    if (text) {
      if (this.wireProtocol === 'codex-v3') {
        this.appendContext(null, text, false)

        return
      }

      this.send({
        content: text,
        delegation_id: null,
        event_id: this.nextEventId('instr'),
        type: 'session.instructions.append'
      })
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted

    for (const track of this.microphone?.getAudioTracks() ?? []) {
      track.enabled = !muted
    }

    if (this.wireProtocol === 'codex-v3') {
      return
    }

    this.send({
      event_id: this.nextEventId(muted ? 'mute' : 'unmute'),
      type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute'
    })
  }

  /** Graceful close: ask for `session.closed`, tear down after it (or a timeout). */
  close(): void {
    if (this.finalized) {
      return
    }

    if (this.wireProtocol === 'codex-v3' || !this.send({ type: 'session.close' })) {
      this.finish('close_requested', null)

      return
    }

    this.closeTimer = window.setTimeout(() => this.finish('close_requested', null), CLOSE_TIMEOUT_MS)
  }

  private finish(reason: string, usageSeconds: null | number): void {
    if (this.finalized) {
      return
    }

    this.finalized = true

    if (this.leasePing) {
      window.clearInterval(this.leasePing)
      this.leasePing = null
    }

    this.releaseCall()
    this.lease?.close()
    this.lease = null

    if (this.closeTimer) {
      window.clearTimeout(this.closeTimer)
      this.closeTimer = null
    }

    this.releaseOutputLevel?.()
    this.releaseOutputLevel = null
    this.clearOutput()

    this.silentInputSource?.stop()
    this.silentInputSource?.disconnect()
    this.silentInputStream?.getTracks().forEach(track => track.stop())
    void this.silentInputContext?.close().catch(() => undefined)
    this.silentInputSource = null
    this.silentInputStream = null
    this.silentInputContext = null
    this.microphone?.getTracks().forEach(track => track.stop())
    this.releaseStandby?.()
    this.releaseStandby = undefined
    this.events?.close()
    this.peer?.close()
    this.audio.srcObject = null
    this.audio.pause()
    this.handlers.onClosed(reason, usageSeconds)
  }
}
