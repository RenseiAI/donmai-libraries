/**
 * POST /api/sessions/[id]/transfer-ownership
 *
 * Transfer session ownership to a new worker.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import {
  transferSessionOwnership,
  getSessionState,
  removeWorkerSession,
  addWorkerSession,
  createLogger,
} from '@donmai/server'

const log = createLogger('api:sessions:transfer-ownership')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createSessionTransferOwnershipHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { newWorkerId, oldWorkerId } = body as { newWorkerId: string; oldWorkerId: string }

      if (!newWorkerId || typeof newWorkerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'newWorkerId is required' },
          { status: 400 }
        )
      }

      if (!oldWorkerId || typeof oldWorkerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'oldWorkerId is required' },
          { status: 400 }
        )
      }

      const result = await transferSessionOwnership(sessionId, newWorkerId, oldWorkerId)

      if (!result.transferred) {
        log.warn('Session ownership transfer failed', {
          sessionId,
          newWorkerId,
          oldWorkerId,
          reason: result.reason,
        })
        return NextResponse.json({
          transferred: false,
          reason: result.reason,
        })
      }

      await removeWorkerSession(oldWorkerId, sessionId)
      await addWorkerSession(newWorkerId, sessionId)

      log.info('Session ownership transferred', {
        sessionId,
        oldWorkerId,
        newWorkerId,
      })

      const session = await getSessionState(sessionId)

      return NextResponse.json({
        transferred: true,
        session,
      })
    } catch (error) {
      log.error('Failed to transfer session ownership', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to transfer session ownership' },
        { status: 500 }
      )
    }
  }
}
