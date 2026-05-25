/**
 * POST /api/workers/[id]/heartbeat
 *
 * Send a heartbeat from a worker to keep registration active.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { updateHeartbeat, getWorker, createLogger } from '@donmai/server'

const log = createLogger('api:workers:heartbeat')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createWorkerHeartbeatHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: workerId } = await params

    try {
      const body = await request.json()
      const { activeCount, load } = body as { activeCount: number; load?: { cpu: number; memory: number } }

      if (typeof activeCount !== 'number' || activeCount < 0) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'activeCount must be a non-negative number' },
          { status: 400 }
        )
      }

      const worker = await getWorker(workerId)
      if (!worker) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Worker not found' },
          { status: 404 }
        )
      }

      const result = await updateHeartbeat(workerId, activeCount, load)

      if (!result) {
        return NextResponse.json(
          { error: 'Service Unavailable', message: 'Failed to update heartbeat' },
          { status: 503 }
        )
      }

      log.debug('Heartbeat received', {
        workerId,
        activeCount,
        pendingWorkCount: result.pendingWorkCount,
      })

      return NextResponse.json(result)
    } catch (error) {
      log.error('Failed to process heartbeat', { error, workerId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to process heartbeat' },
        { status: 500 }
      )
    }
  }
}
