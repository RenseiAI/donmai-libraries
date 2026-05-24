/**
 * GET /api/factory/events
 *
 * Query structured agent events for platform consumption.
 * Supports filtering by event type, time range, and pagination.
 *
 * Query parameters:
 *   - type: Event type filter (e.g., 'agent.security-scan')
 *   - since: ISO-8601 timestamp for incremental polling
 *   - limit: Maximum events to return (default 50, max 200)
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { querySecurityScanEvents, createLogger } from '@donmai/server'

const log = createLogger('api:factory:events')

export function createFactoryEventsHandler() {
  return async function GET(request: NextRequest) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    try {
      const { searchParams } = request.nextUrl
      const type = searchParams.get('type') ?? undefined
      const since = searchParams.get('since') ?? undefined
      const limitParam = searchParams.get('limit')
      const limit = Math.min(Math.max(1, parseInt(limitParam ?? '50', 10) || 50), 200)

      // Currently only security-scan events are supported
      const { events, cursor } = await querySecurityScanEvents({
        type,
        since,
        limit,
      })

      return NextResponse.json({
        events,
        cursor,
      })
    } catch (error) {
      log.error('Failed to query factory events', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to query events' },
        { status: 500 }
      )
    }
  }
}
