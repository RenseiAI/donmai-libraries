'use client'

import { cn } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { StatusDot } from '../../components/fleet/status-dot'
import { SessionTimeline, type TimelineEvent } from './session-timeline'
import { TokenChart } from './token-chart'
import { formatDuration, formatCost } from '../../lib/format'
import { getStatusConfig } from '../../lib/status-config'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import type { PublicSessionResponse } from '../../types/api'
import { ArrowLeft, Clock, Coins, Calendar, Tag } from 'lucide-react'
import { Button } from '../../components/ui/button'

interface SessionDetailProps {
  session: PublicSessionResponse
  onBack?: () => void
  className?: string
}

export function SessionDetail({ session, onBack, className }: SessionDetailProps) {
  const statusConfig = getStatusConfig(session.status)
  const workTypeConfig = getWorkTypeConfig(session.workType)

  const events: TimelineEvent[] = [
    {
      id: 'started',
      label: 'Session started',
      timestamp: session.startedAt,
      type: 'info',
    },
  ]

  if (session.status === 'completed') {
    const endTime = new Date(new Date(session.startedAt).getTime() + session.duration * 1000)
    events.push({
      id: 'completed',
      label: 'Session completed',
      timestamp: endTime.toISOString(),
      type: 'success',
    })
  } else if (session.status === 'failed') {
    const endTime = new Date(new Date(session.startedAt).getTime() + session.duration * 1000)
    events.push({
      id: 'failed',
      label: 'Session failed',
      timestamp: endTime.toISOString(),
      type: 'error',
    })
  }

  return (
    <div className={cn('space-y-6 p-6 animate-fade-in', className)}>
      {/* Back button */}
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-1.5 text-donmai-text-secondary hover:text-donmai-text-primary font-body -ml-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
      )}

      {/* Header */}
      <div className="flex items-center gap-3">
        <StatusDot status={session.status} showHeartbeat={session.status === 'working'} className="h-3 w-3" />
        <h1 className="font-display text-xl font-bold font-mono text-donmai-text-primary tracking-tight">
          {session.identifier}
        </h1>
        <Badge
          variant="outline"
          className={cn(
            'text-xs border',
            statusConfig.bgColor, statusConfig.textColor, statusConfig.borderColor
          )}
        >
          {statusConfig.label}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: Details */}
        <div className="lg:col-span-2 rounded-xl border border-donmai-surface-border/40 bg-donmai-surface/30 p-6">
          <h3 className="font-display text-sm font-semibold text-donmai-text-primary tracking-tight mb-5">
            Session Details
          </h3>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-1">
              <dt className="flex items-center gap-1.5 text-2xs font-body uppercase tracking-wider text-donmai-text-tertiary">
                <Tag className="h-3 w-3" />
                Work Type
              </dt>
              <dd>
                <Badge
                  variant="outline"
                  className={cn('text-xs border', workTypeConfig.bgColor, workTypeConfig.color, workTypeConfig.borderColor)}
                >
                  {workTypeConfig.label}
                </Badge>
              </dd>
            </div>

            <div className="space-y-1">
              <dt className="flex items-center gap-1.5 text-2xs font-body uppercase tracking-wider text-donmai-text-tertiary">
                <Clock className="h-3 w-3" />
                Duration
              </dt>
              <dd className="font-display text-lg font-bold tabular-nums text-donmai-text-primary">
                {formatDuration(session.duration)}
              </dd>
            </div>

            <div className="space-y-1">
              <dt className="flex items-center gap-1.5 text-2xs font-body uppercase tracking-wider text-donmai-text-tertiary">
                <Coins className="h-3 w-3" />
                Cost
              </dt>
              <dd className="font-display text-lg font-bold tabular-nums font-mono text-donmai-accent">
                {formatCost(session.costUsd)}
              </dd>
            </div>

            <div className="space-y-1">
              <dt className="flex items-center gap-1.5 text-2xs font-body uppercase tracking-wider text-donmai-text-tertiary">
                <Calendar className="h-3 w-3" />
                Started
              </dt>
              <dd className="text-sm font-body text-donmai-text-primary">
                {new Date(session.startedAt).toLocaleString()}
              </dd>
            </div>
          </div>

          <div className="mt-8">
            <TokenChart />
          </div>
        </div>

        {/* Right: Timeline */}
        <div className="rounded-xl border border-donmai-surface-border/40 bg-donmai-surface/30 p-6">
          <h3 className="font-display text-sm font-semibold text-donmai-text-primary tracking-tight mb-5">
            Timeline
          </h3>
          <SessionTimeline events={events} />
        </div>
      </div>
    </div>
  )
}
