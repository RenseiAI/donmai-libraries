'use client'

import { cn } from '../../lib/utils'
import { useSessions } from '../../hooks/use-sessions'
import { StatusDot } from '../../components/fleet/status-dot'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/shared/empty-state'
import { formatDuration, formatCost, formatRelativeTime } from '../../lib/format'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import { getStatusConfig } from '../../lib/status-config'

interface SessionListProps {
  onSelect?: (sessionId: string) => void
  className?: string
}

export function SessionList({ onSelect, className }: SessionListProps) {
  const { data, isLoading } = useSessions()
  const sessions = data?.sessions ?? []

  if (isLoading) {
    return (
      <div className={cn('space-y-2 p-6', className)}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No sessions"
          description="Agent sessions will appear here once they start."
        />
      </div>
    )
  }

  return (
    <div className={cn('p-6', className)}>
      <div className="mb-5 flex items-center gap-3">
        <h2 className="font-display text-lg font-bold text-donmai-text-primary tracking-tight">
          Sessions
        </h2>
        <span className="rounded-full bg-donmai-surface/60 px-2 py-0.5 text-2xs font-body font-medium tabular-nums text-donmai-text-secondary">
          {sessions.length}
        </span>
      </div>

      <div className="rounded-xl border border-donmai-surface-border/40 overflow-hidden">
        <table className="w-full text-sm font-body">
          <thead>
            <tr className="border-b border-donmai-surface-border/40 bg-donmai-bg-secondary/50">
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-donmai-text-tertiary">Issue</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-donmai-text-tertiary">Status</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-donmai-text-tertiary">Type</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-donmai-text-tertiary">Duration</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-donmai-text-tertiary">Cost</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-donmai-text-tertiary">Started</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session, i) => {
              const statusConfig = getStatusConfig(session.status)
              const workTypeConfig = getWorkTypeConfig(session.workType)
              return (
                <tr
                  key={session.id}
                  className={cn(
                    'border-b border-donmai-surface-border/20 last:border-0 cursor-pointer transition-all duration-200',
                    'hover:bg-donmai-surface/30'
                  )}
                  onClick={() => onSelect?.(session.id)}
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-sm text-donmai-text-primary">{session.identifier}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusDot status={session.status} />
                      <span className={cn('text-xs', statusConfig.textColor)}>
                        {statusConfig.label}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-2xs border',
                        workTypeConfig.bgColor, workTypeConfig.color, workTypeConfig.borderColor
                      )}
                    >
                      {workTypeConfig.label}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-donmai-text-secondary tabular-nums">
                      {formatDuration(session.duration)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-donmai-text-secondary tabular-nums font-mono">
                      {formatCost(session.costUsd)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-donmai-text-tertiary">
                      {formatRelativeTime(session.startedAt)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
