'use client'

import { cn } from '../../lib/utils'
import { useStats } from '../../hooks/use-stats'
import { formatCost } from '../../lib/format'
import { Tooltip, TooltipTrigger, TooltipContent } from '../../components/ui/tooltip'
import { Zap } from 'lucide-react'

interface BottomBarProps {
  className?: string
}

export function BottomBar({ className }: BottomBarProps) {
  const { data } = useStats()

  return (
    <footer
      className={cn(
        'flex h-8 items-center justify-between border-t border-donmai-surface-border/40 bg-donmai-bg-secondary/30 backdrop-blur-sm px-5',
        className
      )}
    >
      <div className="flex items-center gap-5 text-2xs font-body text-donmai-text-tertiary">
        <span>
          <span className="text-donmai-text-secondary tabular-nums">{data?.completedToday ?? 0}</span> completed
        </span>
        <span>
          <span className="text-donmai-text-secondary tabular-nums">{data?.availableCapacity ?? 0}</span> capacity
        </span>
        {data?.totalCostToday != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default">
                <span className="text-donmai-accent font-mono tabular-nums">{formatCost(data.totalCostToday)}</span> today
                {data.totalCostAllTime != null && data.totalCostAllTime !== data.totalCostToday && (
                  <span className="text-donmai-text-tertiary"> · <span className="font-mono tabular-nums">{formatCost(data.totalCostAllTime)}</span> total</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              Cost from {data.sessionCountToday ?? 0} session{(data.sessionCountToday ?? 0) !== 1 ? 's' : ''} updated today (UTC)
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <a
        href="https://github.com/RenseiAI/donmai"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-2xs font-body text-donmai-text-tertiary hover:text-donmai-text-secondary transition-colors"
      >
        <Zap className="h-2.5 w-2.5" />
        Donmai
      </a>
    </footer>
  )
}
