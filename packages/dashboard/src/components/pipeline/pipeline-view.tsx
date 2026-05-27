'use client'

import { cn } from '../../lib/utils'
import { useSessions } from '../../hooks/use-sessions'
import { PipelineColumn } from './pipeline-column'
import { EmptyState } from '../../components/shared/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import type { PublicSessionResponse, SessionStatus } from '../../types/api'

interface ColumnDef {
  title: string
  statuses: SessionStatus[]
  accentClass: string
}

const columns: ColumnDef[] = [
  { title: 'Backlog', statuses: ['queued', 'parked'], accentClass: 'column-accent column-accent-gray' },
  { title: 'Started', statuses: ['working'], accentClass: 'column-accent column-accent-green' },
  { title: 'Finished', statuses: ['completed'], accentClass: 'column-accent column-accent-blue' },
  { title: 'Failed', statuses: ['failed'], accentClass: 'column-accent column-accent-red' },
  { title: 'Stopped', statuses: ['stopped'], accentClass: 'column-accent column-accent-yellow' },
]

function groupByColumn(sessions: PublicSessionResponse[]) {
  return columns.map((col) => ({
    ...col,
    sessions: sessions.filter((s) => col.statuses.includes(s.status)),
  }))
}

interface PipelineViewProps {
  className?: string
  onSessionSelect?: (sessionId: string) => void
  /** When true, renders pipeline in a muted, non-interactive state */
  readOnly?: boolean
}

export function PipelineView({ className, onSessionSelect, readOnly }: PipelineViewProps) {
  const { data, isLoading } = useSessions()
  const sessions = data?.sessions ?? []

  return (
    <div className={cn('p-6', className)}>
      <div className="mb-5 flex items-center gap-3">
        <h2 className="font-display text-lg font-bold text-donmai-text-primary tracking-tight">
          Pipeline
        </h2>
        {!isLoading && (
          <span className="rounded-full bg-donmai-surface/60 px-2 py-0.5 text-2xs font-body font-medium tabular-nums text-donmai-text-secondary">
            {sessions.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((col) => (
            <Skeleton key={col.title} className="h-96 w-72 shrink-0 rounded-xl" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No pipeline data"
          description="Sessions will populate the pipeline as agents work on issues."
        />
      ) : (
        <div className={cn('flex gap-3 overflow-x-auto pb-2', readOnly && 'opacity-60')}>
          {groupByColumn(sessions).map((col, i) => (
            <div
              key={col.title}
              className="animate-fade-in"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <PipelineColumn
                title={col.title}
                sessions={col.sessions}
                count={col.sessions.length}
                accentClass={col.accentClass}
                onSessionSelect={readOnly ? undefined : onSessionSelect}
                readOnly={readOnly}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
