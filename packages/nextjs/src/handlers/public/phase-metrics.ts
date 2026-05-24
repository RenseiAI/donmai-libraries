/**
 * GET /api/public/phase-metrics
 *
 * Returns phase-level cost, cycle time, and rework aggregations
 * across all workflow states in the workspace.
 *
 * @see SUP-1651
 */

import { NextResponse } from 'next/server'
import { aggregatePhaseMetrics, createLogger } from '@donmai/server'
import type { TimeRange } from '@donmai/server'

const log = createLogger('api/public/phase-metrics')

const VALID_TIME_RANGES = new Set<TimeRange>(['7d', '30d', '90d'])

export function createPublicPhaseMetricsHandler() {
  return async function GET(request: Request) {
    try {
      const url = new URL(request.url)
      const rawTimeRange = url.searchParams.get('timeRange') ?? '30d'
      const timeRange: TimeRange = VALID_TIME_RANGES.has(rawTimeRange as TimeRange)
        ? (rawTimeRange as TimeRange)
        : '30d'

      const result = await aggregatePhaseMetrics(timeRange)

      return NextResponse.json({
        ...result,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      log.error('Failed to get phase metrics', { error })

      return NextResponse.json(
        {
          timeRange: '30d',
          phases: {
            development: { avgCycleTimeMs: 0, avgCostUsd: 0, avgAttempts: 0, totalRecords: 0 },
            qa: { avgCycleTimeMs: 0, avgCostUsd: 0, avgAttempts: 0, totalRecords: 0 },
            refinement: { avgCycleTimeMs: 0, avgCostUsd: 0, avgAttempts: 0, totalRecords: 0 },
            acceptance: { avgCycleTimeMs: 0, avgCostUsd: 0, avgAttempts: 0, totalRecords: 0 },
          },
          reworkRate: 0,
          escalationDistribution: {
            normal: 0,
            'context-enriched': 0,
            decompose: 0,
            'escalate-human': 0,
          },
          issueCount: 0,
          error: 'Failed to fetch phase metrics',
          timestamp: new Date().toISOString(),
        },
        { status: 500 }
      )
    }
  }
}
