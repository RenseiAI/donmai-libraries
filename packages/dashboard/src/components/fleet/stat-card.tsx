import { cn } from '../../lib/utils'
import { Skeleton } from '../../components/ui/skeleton'
import { Tooltip, TooltipTrigger, TooltipContent } from '../../components/ui/tooltip'

interface StatCardProps {
  label: string
  value: string | number
  detail?: string
  icon?: React.ReactNode
  trend?: 'up' | 'down' | 'neutral'
  accent?: boolean
  loading?: boolean
  className?: string
  tooltip?: React.ReactNode
}

export function StatCard({ label, value, detail, icon, accent, loading, className, tooltip }: StatCardProps) {
  if (loading) {
    return (
      <div className={cn(
        'rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/50 p-4',
        className
      )}>
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-4 rounded" />
        </div>
        <Skeleton className="mt-3 h-8 w-16" />
        <Skeleton className="mt-1.5 h-3 w-20" />
      </div>
    )
  }

  const card = (
    <div className={cn(
      'group rounded-xl border border-donmai-surface-border/50 bg-donmai-surface/40 p-4 transition-all duration-300 hover-glow',
      accent && 'border-donmai-accent/15 bg-donmai-accent/[0.03]',
      className
    )}>
      <div className="flex items-center justify-between">
        <span className="text-2xs font-body font-medium uppercase tracking-wider text-donmai-text-tertiary">
          {label}
        </span>
        {icon && (
          <span className={cn(
            'text-donmai-text-tertiary transition-colors duration-300 group-hover:text-donmai-text-secondary',
            accent && 'text-donmai-accent/40 group-hover:text-donmai-accent/70'
          )}>
            {icon}
          </span>
        )}
      </div>
      <div className={cn(
        'mt-2 font-display text-2xl font-bold tabular-nums tracking-tight',
        accent ? 'text-donmai-accent' : 'text-donmai-text-primary'
      )}>
        {value}
      </div>
      {detail && (
        <p className="mt-1 text-2xs font-body text-donmai-text-tertiary">{detail}</p>
      )}
    </div>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    )
  }

  return card
}
