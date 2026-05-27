'use client'

import { cn } from '../../lib/utils'
import { useStats } from '../../hooks/use-stats'
import { useSessions } from '../../hooks/use-sessions'
import { StatCard } from './stat-card'
import { AgentCard } from './agent-card'
import { EmptyState } from '../../components/shared/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { formatCost } from '../../lib/format'
import { Users, Cpu, ListTodo, CheckCircle2, Gauge, DollarSign } from 'lucide-react'

interface FleetOverviewProps {
  className?: string
  onSessionSelect?: (sessionId: string) => void
}

export function FleetOverview({ className, onSessionSelect }: FleetOverviewProps) {
  const { data: stats, isLoading: statsLoading } = useStats()
  const { data: sessionsData, isLoading: sessionsLoading } = useSessions()

  const sessions = sessionsData?.sessions ?? []
  const activeSessions = sessions.filter((s) => s.status === 'working' || s.status === 'queued')

  return (
    <div className={cn('space-y-8 p-6', className)}>
      {/* Section: Fleet Metrics */}
      <div>
        <div className="mb-4 flex items-center gap-3">
          <h2 className="font-display text-lg font-bold text-donmai-text-primary tracking-tight">
            Fleet Overview
          </h2>
          {!statsLoading && stats && (
            <span className="text-2xs font-body text-donmai-text-tertiary tabular-nums">
              {stats.workersOnline} worker{stats.workersOnline !== 1 ? 's' : ''} online
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="Workers"
            value={stats?.workersOnline ?? 0}
            icon={<Users className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Active"
            value={stats?.agentsWorking ?? 0}
            icon={<Cpu className="h-3.5 w-3.5" />}
            accent
            loading={statsLoading}
          />
          <StatCard
            label="Queued"
            value={stats?.queueDepth ?? 0}
            icon={<ListTodo className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Completed"
            value={stats?.completedToday ?? 0}
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Capacity"
            value={stats?.availableCapacity ?? 0}
            icon={<Gauge className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Cost Today"
            value={formatCost(stats?.totalCostToday)}
            icon={<DollarSign className="h-3.5 w-3.5" />}
            loading={statsLoading}
            tooltip={
              <div className="space-y-1.5 py-1">
                <p className="font-medium text-donmai-text-primary">Cost Today (UTC)</p>
                <p className="text-donmai-text-secondary">
                  Sum of {stats?.sessionCountToday ?? 0} session{(stats?.sessionCountToday ?? 0) !== 1 ? 's' : ''} active or completed today.
                </p>
                {stats?.totalCostAllTime != null && stats.totalCostAllTime !== stats.totalCostToday && (
                  <p className="text-donmai-text-tertiary border-t border-donmai-surface-border/50 pt-1.5">
                    All-time total: <span className="font-mono tabular-nums text-donmai-text-secondary">{formatCost(stats.totalCostAllTime)}</span>
                  </p>
                )}
              </div>
            }
          />
        </div>
      </div>

      {/* Section: Active Sessions */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-display text-lg font-bold text-donmai-text-primary tracking-tight">
              Sessions
            </h2>
            <span className="rounded-full bg-donmai-surface/60 px-2 py-0.5 text-2xs font-body font-medium tabular-nums text-donmai-text-secondary">
              {sessions.length}
            </span>
          </div>
          {activeSessions.length > 0 && (
            <span className="text-2xs font-body text-donmai-teal">
              {activeSessions.length} active
            </span>
          )}
        </div>

        {sessionsLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[130px] rounded-xl" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No active sessions"
            description="Sessions will appear here when agents start working."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sessions.map((session, i) => (
              <div
                key={session.id}
                className="animate-fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <AgentCard session={session} onSelect={onSessionSelect} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
