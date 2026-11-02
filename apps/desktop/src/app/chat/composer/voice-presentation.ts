import type { VoiceStatus } from './types'

interface DictationLabels {
  voiceDictation: string
  preparingAudio: string
  stopDictation: string
  transcribingDictation: string
}

const DICTATION_LABEL: Record<VoiceStatus, keyof DictationLabels> = {
  idle: 'voiceDictation',
  starting: 'preparingAudio',
  recording: 'stopDictation',
  transcribing: 'transcribingDictation'
}

export function dictationStatusLabel(status: VoiceStatus, copy: DictationLabels): string {
  return copy[DICTATION_LABEL[status]]
}
