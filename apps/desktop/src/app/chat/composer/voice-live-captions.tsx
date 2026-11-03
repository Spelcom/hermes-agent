import { cn } from '@/lib/utils'

export interface VoiceLiveCaptionsProps {
  active: boolean
  transcript?: Array<{ speaker: 'user' | 'assistant'; text: string }>
}

export function VoiceLiveCaptions({ active, transcript }: VoiceLiveCaptionsProps) {
  if (!active || !transcript?.length) {
    return null
  }

  return (
    <div aria-live="polite" className="max-h-40 w-full min-w-0 shrink-0 space-y-2 overflow-y-auto py-1 text-left text-sm [overflow-wrap:anywhere]">
      {transcript.slice(-4).map((item, index) => (
        <p
          className={cn(
            'whitespace-pre-wrap break-words',
            item.speaker === 'user' ? 'text-muted-foreground' : 'text-foreground'
          )}
          key={index}
        >
          {item.text}
        </p>
      ))}
    </div>
  )
}
