import { cn } from '../../lib/utils'
import { Inbox } from 'lucide-react'

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: React.ReactNode
  className?: string
  children?: React.ReactNode
}

export function EmptyState({
  title = 'No data',
  description = 'Nothing to show yet.',
  icon,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center py-16 text-center',
      className
    )}>
      <div className="mb-4 rounded-xl border border-donmai-surface-border/30 bg-donmai-surface/20 p-4">
        <div className="text-donmai-text-tertiary">
          {icon ?? <Inbox className="h-8 w-8" />}
        </div>
      </div>
      <h3 className="font-display text-sm font-semibold text-donmai-text-primary tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-xs text-xs font-body text-donmai-text-tertiary">{description}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  )
}
