/**
 * POST /api/sessions/[id]/lock-refresh
 *
 * Refresh the issue lock TTL for an active session.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { getSessionState, refreshIssueLockTTL, createLogger } from '@donmai/server'

const log = createLogger('api:sessions:lock-refresh')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createSessionLockRefreshHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId, issueId } = body as { workerId: string; issueId: string }

      if (!workerId || !issueId) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId and issueId are required' },
          { status: 400 }
        )
      }

      const session = await getSessionState(sessionId)
      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      if (session.workerId && session.workerId !== workerId) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Session is owned by another worker' },
          { status: 403 }
        )
      }

      const refreshed = await refreshIssueLockTTL(issueId)

      log.debug('Lock TTL refreshed', { sessionId, issueId, refreshed })

      return NextResponse.json({ refreshed })
    } catch (error) {
      log.error('Failed to refresh lock TTL', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to refresh lock TTL' },
        { status: 500 }
      )
    }
  }
}
