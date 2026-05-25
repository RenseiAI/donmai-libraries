/**
 * POST /api/sessions/[id]/security-scan
 *
 * Receive and store structured security scan events from remote workers.
 * Events are stored in Redis for later retrieval via /api/factory/events.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { getSessionState, storeSecurityScanEvent, createLogger } from '@donmai/server'
import { SecurityScanEventSchema } from '@donmai/core'

const log = createLogger('api:sessions:security-scan')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createSessionSecurityScanHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId, event } = body as {
        workerId: string
        event: unknown
      }

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      // Validate event with Zod schema
      const parseResult = SecurityScanEventSchema.safeParse(event)
      if (!parseResult.success) {
        return NextResponse.json(
          { error: 'Bad Request', message: `Invalid event: ${parseResult.error.message}` },
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

      // Store event in Redis
      await storeSecurityScanEvent(sessionId, parseResult.data)

      log.info('Security scan event stored', {
        sessionId,
        scanner: parseResult.data.scanner,
        findings: parseResult.data.totalFindings,
      })

      return NextResponse.json({ stored: true })
    } catch (error) {
      log.error('Failed to process security scan event', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to process security scan event' },
        { status: 500 }
      )
    }
  }
}
