/**
 * POST /api/sessions/[id]/inbox/ack
 *
 * Acknowledge an inbox message after successful delivery to the agent process.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import {
  getSessionState,
  ack,
  type InboxLane,
  createLogger,
} from '@donmai/server'

const log = createLogger('api:sessions:inbox-ack')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createSessionInboxAckHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { messageId, lane } = body as { messageId: string; lane: InboxLane }

      if (!messageId || typeof messageId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'messageId is required' },
          { status: 400 }
        )
      }

      if (!lane || (lane !== 'urgent' && lane !== 'normal')) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'lane must be "urgent" or "normal"' },
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

      const agentId = session.agentId
      if (!agentId) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'Session has no agentId' },
          { status: 400 }
        )
      }

      await ack(agentId, lane, messageId)

      log.debug('Inbox message acknowledged', {
        sessionId,
        agentId,
        messageId,
        lane,
      })

      return NextResponse.json({ acknowledged: true })
    } catch (error) {
      log.error('Failed to acknowledge inbox message', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to acknowledge inbox message' },
        { status: 500 }
      )
    }
  }
}
