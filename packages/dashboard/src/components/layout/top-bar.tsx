'use client'

import { cn } from '../../lib/utils'
import { StatusDot } from '../../components/fleet/status-dot'
import { useStats } from '../../hooks/use-stats'
import { Skeleton } from '../../components/ui/skeleton'
import { Radio } from 'lucide-react'

interface TopBarProps {
  className?: string
}

export function TopBar({ className }: TopBarProps) {
  const { data, isLoading } = useStats()

  return (
    <header
      className={cn(
        'flex h-11 items-center justify-between border-b border-donmai-surface-border/50 bg-donmai-bg-secondary/40 backdrop-blur-md px-5',
        className
      )}
    >
      <div className="flex items-center gap-5">
        {isLoading ? (
          <>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <StatusDot status={data?.workersOnline ? 'working' : 'stopped'} showHeartbeat />
              <span className="text-xs font-body text-donmai-text-secondary">
                <span className="font-semibold text-donmai-text-primary tabular-nums">{data?.workersOnline ?? 0}</span>{' '}
                {data?.workersOnline === 1 ? 'worker' : 'workers'}
              </span>
            </div>

            <div className="h-3 w-px bg-donmai-surface-border" />

            <span className="text-xs font-body text-donmai-text-secondary">
              <span className="font-semibold text-donmai-teal tabular-nums">{data?.agentsWorking ?? 0}</span> active
            </span>

            <span className="text-xs font-body text-donmai-text-secondary">
              <span className="font-semibold text-donmai-text-primary tabular-nums">{data?.queueDepth ?? 0}</span> queued
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs font-body text-donmai-text-tertiary">
        {data?.timestamp && (
          <>
            <Radio className="h-3 w-3 text-donmai-teal animate-pulse-dot" />
            <span>{new Date(data.timestamp).toLocaleTimeString()}</span>
          </>
        )}
      </div>
    </header>
  )
}
