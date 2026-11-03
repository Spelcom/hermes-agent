/*! @license
 * Codex v3 compatibility references: hermes-live-voice and hermes-talk.
 * MIT License
 * Copyright (c) 2026 Synero
 * Copyright (c) 2026 SmokeDev
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Codex v3 wire compatibility informed by hermes-live-voice (Synero, 2026)
 * and hermes-talk (SmokeDev, 2026), both MIT licensed. No catalog plugin runs
 * in this renderer. See voice-live-third-party-notices.txt for their licenses.
 */
import type { LiveTranscriptFragment } from './voice-live'

export interface LiveWireEvent {
  type: string
  source?: 'broker' | 'direct'
  event_id?: string
  delta?: string
  start_ms?: number
  end_ms?: number
  delegation?: { id: string; type?: string; target?: string }
  item?: {
    id?: string
    text?: string
    type?: string
    target?: string
    content?: Array<{ type?: string; text?: string }>
  }
  turn?: { id?: string; role?: string; transcript?: string }
  error?: { code?: null | string; message?: string; status?: number }
  usage?: { seconds?: number }
  reason?: string
  session?: { id: string }
}

/** Both direct datachannel frames and the broker's app-server notifications. */
export function liveWireEvent(raw: string): LiveWireEvent | null {
  try {
    const frame = JSON.parse(raw)
    let event = frame.method?.startsWith('thread/realtime/') ? (frame.params?.event ?? frame.params) : frame

    // WebRTC is authoritative for captions. App-server transcript notifications
    // mirror whole items without a stable identity shared with the datachannel.
    if (frame.method === 'thread/realtime/transcript/delta' || frame.method === 'thread/realtime/transcript/done') {
      return null
    }

    if (frame.method === 'thread/realtime/itemAdded' && event.item?.type === 'handoff_request') {
      event = {
        type: 'delegation.created',
        item: {
          id: event.item.item_id || event.item.handoff_id,
          target: 'client',
          content: [{ type: 'input_text', text: event.item.input_transcript ?? '' }]
        }
      }
    }

    if (frame.method === 'thread/realtime/error') {
      event = {
        type: 'error',
        error: { code: event.code, message: 'Codex voice connection failed', status: event.status }
      }
    } else if (frame.method === 'thread/realtime/started') {
      event = { type: 'session.started' }
    } else if (frame.method === 'thread/realtime/closed') {
      event = { type: 'session.closed', reason: 'connection_lost' }
    }

    return typeof event?.type === 'string'
      ? ({ ...event, source: frame.method ? 'broker' : 'direct' } as LiveWireEvent)
      : null
  } catch {
    return null
  }
}

interface TranscriptItem {
  speaker: 'assistant' | 'user'
  text: string
  final: boolean
  key: string
}

const TRANSCRIPT_SPEAKERS: Record<string, 'assistant' | 'user'> = {
  'session.input_transcript.delta': 'user',
  'session.output_transcript.delta': 'assistant',
  'input_transcript.added': 'user',
  'output_transcript.added': 'assistant'
}

function transcriptItem(event: LiveWireEvent): TranscriptItem | null {
  if (event.type === 'turn.done') {
    const speaker = event.turn?.role

    return speaker === 'user' || speaker === 'assistant'
      ? { speaker, text: event.turn?.transcript ?? '', final: true, key: event.event_id ?? '' }
      : null
  }

  const speaker = TRANSCRIPT_SPEAKERS[event.type]

  if (!speaker) {
    return null
  }

  const itemId = event.item?.id

  return {
    speaker,
    text: event.delta ?? event.item?.text ?? '',
    final: false,
    key: event.event_id ?? (itemId ? `${event.type}:${itemId}` : '')
  }
}

/** Emit append-only text: v3 turn.done can be shorter than prior item deltas. */
export class LiveTranscriptAccumulator {
  private seen = new Set<string>()
  private recent = new Map<string, { text: string; at: number }>()
  readonly fragments: LiveTranscriptFragment[] = []

  private duplicate(key: string): boolean {
    if (!key) {
      return false
    }

    if (this.seen.has(key)) {
      return true
    }

    this.seen.add(key)

    if (this.seen.size > 4000) {
      this.seen.delete(this.seen.values().next().value!)
    }

    return false
  }

  private appendText(item: TranscriptItem, now: number): string {
    const previous = this.recent.get(item.speaker)
    let delta = item.text

    if (item.final && previous && now - previous.at < 8000) {
      delta = item.text.startsWith(previous.text) ? item.text.slice(previous.text.length) : ''
    }

    if (!delta) {
      return ''
    }

    const text = previous && now - previous.at < 3500 ? previous.text + delta : delta
    this.recent.set(item.speaker, { at: now, text })

    return delta
  }

  append(event: LiveWireEvent): LiveTranscriptFragment | null {
    const item = transcriptItem(event)

    if (!item || this.duplicate(item.key)) {
      return null
    }

    const now = Date.now()
    const text = this.appendText(item, now)

    if (!text) {
      return null
    }

    const fragment: LiveTranscriptFragment = {
      speaker: item.speaker,
      text,
      startMs: event.start_ms ?? now,
      endMs: event.end_ms ?? now
    }

    this.fragments.push(fragment)

    if (this.fragments.length > 2000) {
      this.fragments.splice(0, this.fragments.length - 1500)
    }

    return fragment
  }
}

export function delegationRequest(event: LiveWireEvent): { id: string; prompt?: string } | null {
  if (event.type === 'session.delegation.created') {
    return event.delegation?.id ? { id: event.delegation.id } : null
  }

  if (event.type !== 'delegation.created' || !event.item?.id || (event.item.target && event.item.target !== 'client')) {
    return null
  }

  return {
    id: event.item.id,
    prompt: event.item.content
      ?.filter(part => part.type === 'input_text')
      .map(part => part.text ?? '')
      .join('')
      .trim()
  }
}
