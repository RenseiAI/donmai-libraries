import { cn } from '../../lib/utils'
import { formatTokens } from '../../lib/format'

interface TokenChartProps {
  inputTokens?: number
  outputTokens?: number
  className?: string
}

export function TokenChart({ inputTokens = 0, outputTokens = 0, className }: TokenChartProps) {
  const total = inputTokens + outputTokens
  if (total === 0) return null

  const inputPct = (inputTokens / total) * 100
  const outputPct = (outputTokens / total) * 100

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between text-2xs font-body">
        <span className="uppercase tracking-wider text-donmai-text-tertiary">Token Usage</span>
        <span className="tabular-nums font-mono text-donmai-text-secondary">{formatTokens(total)} total</span>
      </div>

      {/* Bar */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-donmai-bg-primary/60">
        <div
          className="bg-donmai-blue rounded-l-full transition-all duration-500"
          style={{ width: `${inputPct}%` }}
        />
        <div
          className="bg-donmai-accent transition-all duration-500"
          style={{ width: `${outputPct}%` }}
        />
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5 text-2xs font-body">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-donmai-blue shadow-[0_0_6px_1px_rgba(75,139,245,0.3)]" />
          <span className="text-donmai-text-tertiary">Input</span>
          <span className="tabular-nums font-mono text-donmai-text-secondary">{formatTokens(inputTokens)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-donmai-accent shadow-[0_0_6px_1px_rgba(255,107,53,0.3)]" />
          <span className="text-donmai-text-tertiary">Output</span>
          <span className="tabular-nums font-mono text-donmai-text-secondary">{formatTokens(outputTokens)}</span>
        </div>
      </div>
    </div>
  )
}
