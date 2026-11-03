import { cn } from '@/lib/utils'

export function VoiceLiveCaptions({
  active,
  transcript
}: {
  active: boolean
  transcript?: Array<{ speaker: 'user' | 'assistant'; text: string }>
}) {
  if (!active || !transcript?.length) {
    return null
  }

  return (
    <div aria-live="polite" className="max-h-48 min-w-0 flex-1 overflow-y-auto px-2 text-sm">
      {transcript.slice(-4).map((item, index) => (
        <p
          className={cn(
            'mb-2 whitespace-pre-wrap break-words',
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
