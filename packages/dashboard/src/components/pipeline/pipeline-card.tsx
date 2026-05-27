import { cn } from '../../lib/utils'
import { StatusDot } from '../../components/fleet/status-dot'
import { Badge } from '../../components/ui/badge'
import { formatDuration } from '../../lib/format'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import type { PublicSessionResponse } from '../../types/api'
import { Clock } from 'lucide-react'

interface PipelineCardProps {
  session: PublicSessionResponse
  className?: string
  onSelect?: (sessionId: string) => void
  readOnly?: boolean
}

export function PipelineCard({ session, className, onSelect, readOnly }: PipelineCardProps) {
  const workTypeConfig = getWorkTypeConfig(session.workType)
  const isInteractive = onSelect && !readOnly

  return (
    <div
      className={cn(
        'rounded-lg border border-donmai-surface-border/40 bg-donmai-surface/50 p-3 transition-all duration-200',
        !readOnly && 'hover-glow',
        isInteractive && 'cursor-pointer',
        readOnly && 'pointer-events-none',
        className
      )}
      {...(isInteractive && {
        role: 'button',
        tabIndex: 0,
        onClick: () => onSelect(session.id),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(session.id)
          }
        },
      })}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={session.status} />
        <span className={cn(
          'text-xs font-mono font-medium truncate',
          onSelect
            ? 'text-donmai-teal hover:underline underline-offset-2'
            : 'text-donmai-text-primary'
        )}>
          {session.identifier}
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <Badge
          variant="outline"
          className={cn(
            'text-2xs border',
            workTypeConfig.bgColor, workTypeConfig.color, workTypeConfig.borderColor
          )}
        >
          {workTypeConfig.label}
        </Badge>
        <span className="flex items-center gap-1 text-2xs font-body text-donmai-text-tertiary tabular-nums">
          <Clock className="h-2.5 w-2.5" />
          {formatDuration(session.duration)}
        </span>
      </div>
    </div>
  )
}
