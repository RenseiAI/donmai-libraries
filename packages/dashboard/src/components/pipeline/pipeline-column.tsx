import { cn } from '../../lib/utils'
import { ScrollArea } from '../../components/ui/scroll-area'
import { PipelineCard } from './pipeline-card'
import type { PublicSessionResponse } from '../../types/api'

interface PipelineColumnProps {
  title: string
  sessions: PublicSessionResponse[]
  count: number
  accentClass?: string
  className?: string
  onSessionSelect?: (sessionId: string) => void
  readOnly?: boolean
}

export function PipelineColumn({ title, sessions, count, accentClass, className, onSessionSelect, readOnly }: PipelineColumnProps) {
  return (
    <div
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-xl border border-donmai-surface-border/40 bg-donmai-bg-secondary/50 backdrop-blur-sm',
        accentClass,
        className
      )}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3.5 py-3">
        <span className="text-xs font-display font-semibold text-donmai-text-primary tracking-tight">
          {title}
        </span>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-donmai-surface/60 px-1.5 text-2xs font-body font-medium tabular-nums text-donmai-text-secondary">
          {count}
        </span>
      </div>

      {/* Card list */}
      <ScrollArea className="flex-1 px-2 pb-2">
        <div className="space-y-2">
          {sessions.map((session) => (
            <PipelineCard key={session.id} session={session} onSelect={onSessionSelect} readOnly={readOnly} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
