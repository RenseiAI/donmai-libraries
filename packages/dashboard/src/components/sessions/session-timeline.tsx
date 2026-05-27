import { cn } from '../../lib/utils'

export interface TimelineEvent {
  id: string
  label: string
  timestamp: string
  detail?: string
  type?: 'info' | 'success' | 'warning' | 'error'
}

interface SessionTimelineProps {
  events: TimelineEvent[]
  className?: string
}

const typeStyles = {
  info: {
    dot: 'bg-donmai-blue',
    glow: 'shadow-[0_0_8px_2px_rgba(75,139,245,0.3)]',
    line: 'bg-donmai-blue/20',
  },
  success: {
    dot: 'bg-donmai-status-success',
    glow: 'shadow-[0_0_8px_2px_rgba(34,197,94,0.3)]',
    line: 'bg-donmai-status-success/20',
  },
  warning: {
    dot: 'bg-donmai-status-warning',
    glow: 'shadow-[0_0_8px_2px_rgba(245,158,11,0.3)]',
    line: 'bg-donmai-status-warning/20',
  },
  error: {
    dot: 'bg-donmai-status-error',
    glow: 'shadow-[0_0_8px_2px_rgba(239,68,68,0.3)]',
    line: 'bg-donmai-status-error/20',
  },
}

export function SessionTimeline({ events, className }: SessionTimelineProps) {
  return (
    <div className={cn('relative space-y-0', className)}>
      {/* Vertical connector line */}
      {events.length > 1 && (
        <div className="absolute left-[5px] top-3 bottom-3 w-px bg-donmai-surface-border/40" />
      )}

      {events.map((event) => {
        const styles = typeStyles[event.type ?? 'info']
        return (
          <div key={event.id} className="relative flex gap-3.5 py-2.5">
            {/* Glowing dot */}
            <span
              className={cn(
                'relative z-10 mt-1.5 h-[10px] w-[10px] shrink-0 rounded-full',
                styles.dot,
                styles.glow
              )}
            />

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-body text-donmai-text-primary">{event.label}</span>
                <span className="text-2xs font-body text-donmai-text-tertiary whitespace-nowrap tabular-nums">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {event.detail && (
                <p className="mt-0.5 text-xs font-body text-donmai-text-tertiary">{event.detail}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
