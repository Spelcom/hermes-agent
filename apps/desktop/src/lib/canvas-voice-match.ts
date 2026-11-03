export type CanvasVoiceAgentId = 'ciel' | 'kai' | 'ren' | 'mio' | 'yuki'

const ALIASES: Record<string, CanvasVoiceAgentId> = {
  сиэль: 'ciel',
  сиель: 'ciel',
  ciel: 'ciel',
  cl: 'ciel',
  кай: 'kai',
  kai: 'kai',
  рен: 'ren',
  ren: 'ren',
  мио: 'mio',
  mio: 'mio',
  юки: 'yuki',
  yuki: 'yuki'
}

/** Only a name at the beginning authorizes a command; incidental names never do. */
export function matchCanvasVoiceCommand(text: string): { id: CanvasVoiceAgentId; text: string } | null {
  const match = text.trim().match(/^(?:эй[\s,]+|hey[\s,]+)?([\p{L}]+)(?=$|[\s,:.!?—-])([\s\S]*)$/iu)
  const id = match && ALIASES[match[1].toLowerCase()]

  return id ? { id, text: match![2].replace(/^[\s,:.!?—-]+/, '').trim() } : null
}
