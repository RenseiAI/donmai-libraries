'use client'

import { cn } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { Separator } from '../../components/ui/separator'
import { useStats } from '../../hooks/use-stats'
import { useWorkers } from '../../hooks/use-workers'
import { ProviderIcon } from '../../components/fleet/provider-icon'
import { StatusDot } from '../../components/fleet/status-dot'
import { CheckCircle2, AlertCircle, Settings2, Webhook, Server, Shield } from 'lucide-react'

interface SettingsViewProps {
  className?: string
}

export function SettingsView({ className }: SettingsViewProps) {
  const { data: stats } = useStats()
  const { data: workersData } = useWorkers()

  const workers = workersData?.workers ?? []
  const hasWorkerAuth = workersData !== null

  return (
    <div className={cn('space-y-6 p-6 max-w-3xl', className)}>
      {/* Page header */}
      <div>
        <h1 className="font-display text-xl font-bold text-donmai-text-primary tracking-tight">Settings</h1>
        <p className="mt-1 text-sm font-body text-donmai-text-secondary">
          Configuration and integration status for your Donmai instance.
        </p>
      </div>

      {/* Integration Status */}
      <div className="rounded-xl border border-donmai-surface-border/40 bg-donmai-surface/30 overflow-hidden">
        <div className="px-6 py-4 border-b border-donmai-surface-border/30">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-donmai-text-primary tracking-tight">
            <Webhook className="h-4 w-4 text-donmai-text-tertiary" />
            Integration Status
          </h3>
          <p className="mt-0.5 text-xs font-body text-donmai-text-tertiary">Connected services and API endpoints</p>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-donmai-status-success" />
              <div>
                <p className="text-sm font-body text-donmai-text-primary">Linear Webhook</p>
                <p className="text-2xs font-mono text-donmai-text-tertiary">/webhook</p>
              </div>
            </div>
            <Badge variant="success">Connected</Badge>
          </div>

          <Separator className="bg-donmai-surface-border/30" />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-donmai-status-success" />
              <div>
                <p className="text-sm font-body text-donmai-text-primary">Public API</p>
                <p className="text-2xs font-mono text-donmai-text-tertiary">/api/public/stats</p>
              </div>
            </div>
            <Badge variant="success">Active</Badge>
          </div>

          <Separator className="bg-donmai-surface-border/30" />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {hasWorkerAuth ? (
                <CheckCircle2 className="h-4 w-4 text-donmai-status-success" />
              ) : (
                <AlertCircle className="h-4 w-4 text-donmai-text-tertiary" />
              )}
              <div>
                <p className="text-sm font-body text-donmai-text-primary">Worker API</p>
                <p className="text-2xs font-mono text-donmai-text-tertiary">/api/workers</p>
              </div>
            </div>
            <Badge variant={hasWorkerAuth ? 'success' : 'secondary'}>
              {hasWorkerAuth ? 'Authenticated' : 'No Auth Key'}
            </Badge>
          </div>
        </div>
      </div>

      {/* Workers */}
      <div className="rounded-xl border border-donmai-surface-border/40 bg-donmai-surface/30 overflow-hidden">
        <div className="px-6 py-4 border-b border-donmai-surface-border/30">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-donmai-text-primary tracking-tight">
            <Server className="h-4 w-4 text-donmai-text-tertiary" />
            Workers
          </h3>
          <p className="mt-0.5 text-xs font-body text-donmai-text-tertiary">
            {workers.length > 0
              ? `${workers.length} worker${workers.length !== 1 ? 's' : ''} registered`
              : !hasWorkerAuth && (stats?.workersOnline ?? 0) > 0
                ? `${stats!.workersOnline} worker${stats!.workersOnline !== 1 ? 's' : ''} online`
                : 'No workers connected'}
          </p>
        </div>

        <div className="px-6 py-4">
          {!hasWorkerAuth && (stats?.workersOnline ?? 0) > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-body text-donmai-text-secondary">
                {stats!.workersOnline} worker{stats!.workersOnline !== 1 ? 's' : ''} connected to the fleet.
              </p>
              <p className="text-xs font-body text-donmai-text-tertiary">
                Set <code className="font-mono text-2xs px-1 py-0.5 rounded bg-donmai-surface-border/30">WORKER_API_KEY</code> to view detailed worker information.
              </p>
            </div>
          ) : workers.length === 0 ? (
            <p className="text-sm font-body text-donmai-text-tertiary">
              Workers will appear here once they register with the server.
            </p>
          ) : (
            <div className="space-y-3">
              {workers.map((worker) => (
                <div key={worker.id} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-3">
                    <StatusDot status={worker.status === 'active' ? 'working' : 'stopped'} />
                    <div>
                      <p className="text-sm font-mono text-donmai-text-primary">
                        {worker.hostname ?? worker.id.slice(0, 8)}
                      </p>
                      <p className="text-2xs font-body text-donmai-text-tertiary">
                        {worker.activeSessions}/{worker.capacity} slots
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <ProviderIcon provider={worker.provider} size={14} />
                    <Badge variant={worker.status === 'active' ? 'success' : 'secondary'}>
                      {worker.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Fleet Stats */}
      <div className="rounded-xl border border-donmai-surface-border/40 bg-donmai-surface/30 overflow-hidden">
        <div className="px-6 py-4 border-b border-donmai-surface-border/30">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-donmai-text-primary tracking-tight">
            <Shield className="h-4 w-4 text-donmai-text-tertiary" />
            Fleet Configuration
          </h3>
        </div>

        <div className="px-6 py-4">
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-1">
              <dt className="text-2xs font-body uppercase tracking-wider text-donmai-text-tertiary">Total Capacity</dt>
              <dd className="font-display text-lg font-bold tabular-nums text-donmai-text-primary">
                {stats?.availableCapacity ?? '—'}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-2xs font-body uppercase tracking-wider text-donmai-text-tertiary">Workers Online</dt>
              <dd className="font-display text-lg font-bold tabular-nums text-donmai-text-primary">
                {stats?.workersOnline ?? '—'}
              </dd>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
