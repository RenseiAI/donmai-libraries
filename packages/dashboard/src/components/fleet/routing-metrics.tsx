'use client'

import { useState, useCallback } from 'react'
import { cn } from '../../lib/utils'
import { useRoutingMetrics } from '../../hooks/use-routing-metrics'
import { EmptyState } from '../../components/shared/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { Button } from '../../components/ui/button'
import { formatCost } from '../../lib/format'
import { Router, Activity, TrendingUp, CheckCircle2, XCircle, HelpCircle, ChevronLeft, ChevronRight } from 'lucide-react'

interface RoutingMetricsProps {
  className?: string
}

const TIME_RANGES = [
  { label: 'All', value: '' },
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
] as const

type TimeRangeValue = (typeof TIME_RANGES)[number]['value']

function getTimeRangeFrom(value: TimeRangeValue): string | undefined {
  if (!value) return undefined
  const now = Date.now()
  const ms: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  }
  return new Date(now - ms[value]!).toISOString()
}

function confidenceColor(confidence: number): string {
  if (confidence > 0.7) return 'text-emerald-400'
  if (confidence >= 0.3) return 'text-amber-400'
  return 'text-red-400'
}

function confidenceBg(confidence: number): string {
  if (confidence > 0.7) return 'bg-emerald-500/10 border-emerald-500/20'
  if (confidence >= 0.3) return 'bg-amber-500/10 border-amber-500/20'
  return 'bg-red-500/10 border-red-500/20'
}

export function RoutingMetrics({ className }: RoutingMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>('')
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [cursorStack, setCursorStack] = useState<string[]>([])

  const from = getTimeRangeFrom(timeRange)
  const { data, isLoading } = useRoutingMetrics({ from, cursor })

  const handleTimeRangeChange = useCallback((value: TimeRangeValue) => {
    setTimeRange(value)
    setCursor(undefined)
    setCursorStack([])
  }, [])

  const handleNextPage = useCallback(() => {
    if (data?.nextCursor) {
      setCursorStack((prev) => [...prev, cursor ?? ''])
      setCursor(data.nextCursor)
    }
  }, [data?.nextCursor, cursor])

  const handlePrevPage = useCallback(() => {
    setCursorStack((prev) => {
      const next = [...prev]
      const prevCursor = next.pop()
      setCursor(prevCursor || undefined)
      return next
    })
  }, [])

  const routingDisabled = !isLoading && (!data || !data.summary.routingEnabled)

  if (routingDisabled) {
    return (
      <div className={cn('p-6', className)}>
        <EmptyState
          title="Routing not enabled"
          description="Multi-armed bandit routing will appear here once providers begin receiving observations."
          icon={<Router className="h-8 w-8" />}
        />
      </div>
    )
  }

  return (
    <div className={cn('space-y-8 p-6', className)}>
      {/* Section: Summary */}
      <div>
        <div className="mb-4 flex items-center gap-3">
          <h2 className="font-display text-lg font-bold text-donmai-text-primary tracking-tight">
            Routing Analytics
          </h2>
          {!isLoading && data && (
            <span className="text-2xs font-body text-donmai-text-tertiary tabular-nums">
              {data.summary.totalObservations} observation{data.summary.totalObservations !== 1 ? 's' : ''} total
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[72px] rounded-xl" />
            ))}
          </div>
        ) : data ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40 p-4">
              <p className="text-2xs font-body text-donmai-text-tertiary">Total Observations</p>
              <p className="mt-1 font-display text-xl font-bold text-donmai-text-primary tabular-nums">
                {data.summary.totalObservations}
              </p>
            </div>
            <div className="rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40 p-4">
              <p className="text-2xs font-body text-donmai-text-tertiary">Avg Confidence</p>
              <p className={cn('mt-1 font-display text-xl font-bold tabular-nums', confidenceColor(data.summary.avgConfidence))}>
                {(data.summary.avgConfidence * 100).toFixed(1)}%
              </p>
            </div>
            <div className="rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40 p-4">
              <p className="text-2xs font-body text-donmai-text-tertiary">Exploration Rate</p>
              <p className="mt-1 font-display text-xl font-bold text-donmai-text-primary tabular-nums">
                {(data.summary.explorationRate * 100).toFixed(0)}%
              </p>
            </div>
            <div className="rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40 p-4">
              <p className="text-2xs font-body text-donmai-text-tertiary">Providers Tracked</p>
              <p className="mt-1 font-display text-xl font-bold text-donmai-text-primary tabular-nums">
                {data.posteriors.length}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* Section: Provider Performance Matrix */}
      <div>
        <div className="mb-4 flex items-center gap-3">
          <TrendingUp className="h-4 w-4 text-donmai-text-tertiary" />
          <h2 className="font-display text-lg font-bold text-donmai-text-primary tracking-tight">
            Provider Performance
          </h2>
        </div>

        {isLoading ? (
          <Skeleton className="h-[200px] rounded-xl" />
        ) : data && data.posteriors.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-donmai-surface-border/50">
                  <th className="px-4 py-3 text-2xs font-body font-medium text-donmai-text-tertiary">Provider</th>
                  <th className="px-4 py-3 text-2xs font-body font-medium text-donmai-text-tertiary">Work Type</th>
                  <th className="px-4 py-3 text-2xs font-body font-medium text-donmai-text-tertiary text-right">Expected Reward</th>
                  <th className="px-4 py-3 text-2xs font-body font-medium text-donmai-text-tertiary text-right">Confidence</th>
                  <th className="px-4 py-3 text-2xs font-body font-medium text-donmai-text-tertiary text-right">Observations</th>
                  <th className="px-4 py-3 text-2xs font-body font-medium text-donmai-text-tertiary text-right">Avg Cost</th>
                  <th className="px-4 py-3 text-2xs font-body font-medium text-donmai-text-tertiary text-right">Alpha / Beta</th>
                </tr>
              </thead>
              <tbody>
                {data.posteriors.map((p) => (
                  <tr
                    key={`${p.provider}-${p.workType}`}
                    className="border-b border-donmai-surface-border/30 last:border-b-0 hover:bg-donmai-surface/60 transition-colors"
                  >
                    <td className="px-4 py-3 text-xs font-body font-medium text-donmai-text-primary">{p.provider}</td>
                    <td className="px-4 py-3 text-xs font-body text-donmai-text-secondary">{p.workType}</td>
                    <td className="px-4 py-3 text-xs font-body text-donmai-text-primary text-right tabular-nums">
                      {(p.expectedReward * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={cn(
                          'inline-block rounded-md border px-2 py-0.5 text-xs font-body tabular-nums',
                          confidenceBg(p.confidence),
                          confidenceColor(p.confidence),
                        )}
                      >
                        {(p.confidence * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs font-body text-donmai-text-secondary text-right tabular-nums">
                      {p.totalObservations}
                    </td>
                    <td className="px-4 py-3 text-xs font-body text-donmai-text-secondary text-right tabular-nums">
                      {formatCost(p.avgCostUsd)}
                    </td>
                    <td className="px-4 py-3 text-xs font-body text-donmai-text-tertiary text-right tabular-nums">
                      {p.alpha.toFixed(1)} / {p.beta.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No provider data"
            description="Posterior distributions will appear once routing observations are recorded."
          />
        )}
      </div>

      {/* Section: Recent Routing Decisions */}
      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Activity className="h-4 w-4 text-donmai-text-tertiary" />
            <h2 className="font-display text-lg font-bold text-donmai-text-primary tracking-tight">
              Recent Decisions
            </h2>
            {!isLoading && data && (
              <span className="text-2xs font-body text-donmai-text-tertiary tabular-nums">
                showing {data.recentDecisions.length}{timeRange ? ` from last ${timeRange}` : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Time-range selector */}
            <div className="flex items-center rounded-lg border border-donmai-surface-border/50 bg-donmai-surface/20 p-0.5">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.value}
                  onClick={() => handleTimeRangeChange(range.value)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-2xs font-body transition-colors',
                    timeRange === range.value
                      ? 'bg-donmai-surface/60 text-donmai-text-primary font-medium'
                      : 'text-donmai-text-tertiary hover:text-donmai-text-secondary',
                  )}
                >
                  {range.label}
                </button>
              ))}
            </div>
            {/* Pagination controls */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handlePrevPage}
                disabled={cursorStack.length === 0}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleNextPage}
                disabled={!data?.nextCursor}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[52px] rounded-xl" />
            ))}
          </div>
        ) : data && data.recentDecisions.length > 0 ? (
          <div className="space-y-2">
            {data.recentDecisions.map((d, i) => (
              <div
                key={`${d.timestamp}-${i}`}
                className="flex items-center gap-4 rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40 px-4 py-3"
              >
                <div className="flex-shrink-0">
                  {d.taskCompleted ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : d.reward > 0 ? (
                    <HelpCircle className="h-4 w-4 text-amber-400" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-body font-medium text-donmai-text-primary">{d.provider}</span>
                    <span className="text-2xs font-body text-donmai-text-tertiary">{d.workType}</span>
                    {d.explorationReason && (
                      <span className="rounded-full bg-donmai-surface/60 px-1.5 py-0.5 text-2xs font-body text-donmai-text-tertiary">
                        {d.explorationReason}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0">
                  <span className={cn('text-xs font-body tabular-nums', confidenceColor(d.confidence))}>
                    {(d.confidence * 100).toFixed(0)}%
                  </span>
                  <span className="text-xs font-body text-donmai-text-secondary tabular-nums">
                    reward {d.reward.toFixed(2)}
                  </span>
                  <span className="text-2xs font-body text-donmai-text-tertiary tabular-nums">
                    {new Date(d.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No recent decisions"
            description="Routing decisions will appear here as agents complete tasks."
          />
        )}
      </div>
    </div>
  )
}
