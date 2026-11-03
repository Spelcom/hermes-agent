import { describe, expect, it } from 'vitest'

import { delegationRequest, LiveTranscriptAccumulator, liveWireEvent } from './voice-live-protocol'

describe('Codex live wire', () => {
  it('appends transcript fragments and never shrinks or duplicates a final snapshot', () => {
    const transcript = new LiveTranscriptAccumulator()
    const event = { type: 'output_transcript.added', event_id: 'e1', item: { id: 'i1', text: 'Голосовой разговор ' } }
    expect(transcript.append(event)?.text).toBe('Голосовой разговор ')
    expect(transcript.append(event)).toBeNull()
    transcript.append({ type: 'output_transcript.added', item: { id: 'i2', text: 'работает' } })
    expect(transcript.append({ type: 'turn.done', turn: { role: 'assistant', transcript: 'работает' } })).toBeNull()
    expect(
      transcript.append({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Голосовой разговор работает.' } })
        ?.text
    ).toBe('.')
    expect(transcript.fragments.map(item => item.text).join('')).toBe('Голосовой разговор работает.')
  })
  it('deduplicates a broker mirror without swallowing repeated direct speech', () => {
    const transcript = new LiveTranscriptAccumulator()
    transcript.append(liveWireEvent(JSON.stringify({ type: 'input_transcript.added', item: { text: 'да ' } }))!)
    expect(
      liveWireEvent(
        JSON.stringify({ method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: 'да ' } })
      )
    ).toBeNull()
    transcript.append(liveWireEvent(JSON.stringify({ type: 'input_transcript.added', item: { text: 'да ' } }))!)
    expect(transcript.fragments.map(item => item.text).join('')).toBe('да да ')
  })
  it('preserves the actual delegation item ID and supplied request across broker envelopes', () => {
    const event = liveWireEvent(
      JSON.stringify({
        method: 'thread/realtime/itemAdded',
        params: {
          item: {
            type: 'handoff_request',
            item_id: 'item-owner-1',
            handoff_id: 'other',
            input_transcript: 'Проверь сервер'
          }
        }
      })
    )!

    expect(delegationRequest(event)).toEqual({ id: 'item-owner-1', prompt: 'Проверь сервер' })
    expect(delegationRequest({ type: 'delegation.created', item: { id: 'x', target: 'server' } })).toBeNull()
  })
})
