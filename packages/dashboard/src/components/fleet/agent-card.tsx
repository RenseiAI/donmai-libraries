'use client'

import { cn } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { StatusDot } from './status-dot'
import { ProviderIcon } from './provider-icon'
import { formatDuration, formatCost } from '../../lib/format'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import { getStatusConfig } from '../../lib/status-config'
import type { PublicSessionResponse } from '../../types/api'
import { Clock, Coins } from 'lucide-react'

interface AgentCardProps {
  session: PublicSessionResponse
  className?: string
  onSelect?: (sessionId: string) => void
}

export function AgentCard({ session, className, onSelect }: AgentCardProps) {
  const statusConfig = getStatusConfig(session.status)
  const workTypeConfig = getWorkTypeConfig(session.workType)

  return (
    <div
      className={cn(
        'group relative rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40 p-4 transition-all duration-300 hover-glow',
        session.status === 'working' && 'border-donmai-status-success/10',
        session.status === 'failed' && 'border-donmai-status-error/10',
        onSelect && 'cursor-pointer',
        className
      )}
      {...(onSelect && {
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
      {/* Top row: identifier + provider */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={session.status} showHeartbeat={session.status === 'working'} />
          <span className={cn(
            'text-sm font-mono font-medium truncate',
            onSelect
              ? 'text-donmai-teal hover:underline underline-offset-2'
              : 'text-donmai-text-primary'
          )}>
            {session.identifier}
          </span>
        </div>
        <ProviderIcon provider={session.provider} size={14} className="shrink-0 opacity-40 group-hover:opacity-70 transition-opacity" />
      </div>

      {/* Badges */}
      <div className="mt-3 flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn(
            'text-2xs border',
            workTypeConfig.bgColor, workTypeConfig.color, workTypeConfig.borderColor
          )}
        >
          {workTypeConfig.label}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            'text-2xs border',
            statusConfig.bgColor, statusConfig.textColor, statusConfig.borderColor
          )}
        >
          {statusConfig.label}
        </Badge>
      </div>

      {/* Footer metrics */}
      <div className="mt-3.5 flex items-center justify-between text-2xs font-body text-donmai-text-tertiary">
        <span className="flex items-center gap-1 tabular-nums">
          <Clock className="h-3 w-3" />
          {formatDuration(session.duration)}
        </span>
        {session.costUsd != null && (
          <span className="flex items-center gap-1 tabular-nums font-mono text-donmai-text-secondary">
            <Coins className="h-3 w-3" />
            {formatCost(session.costUsd)}
          </span>
        )}
      </div>
    </div>
  )
}
