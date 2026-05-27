import { cn } from '../../lib/utils'

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-lg bg-donmai-surface/60',
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
