/**
 * GET, DELETE /api/workers/[id]
 *
 * Get worker details or deregister a worker.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { deregisterWorker, getWorker, createLogger } from '@donmai/server'

const log = createLogger('api:workers:detail')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createWorkerDeleteHandler() {
  return async function DELETE(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: workerId } = await params

    try {
      const worker = await getWorker(workerId)
      if (!worker) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Worker not found' },
          { status: 404 }
        )
      }

      const result = await deregisterWorker(workerId)

      if (!result.deregistered) {
        return NextResponse.json(
          { error: 'Service Unavailable', message: 'Failed to deregister worker' },
          { status: 503 }
        )
      }

      log.info('Worker deregistered via API', {
        workerId,
        unclaimedSessions: result.unclaimedSessions.length,
      })

      return NextResponse.json({
        deregistered: true,
        unclaimedSessions: result.unclaimedSessions,
      })
    } catch (error) {
      log.error('Failed to deregister worker', { error, workerId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to deregister worker' },
        { status: 500 }
      )
    }
  }
}

export function createWorkerGetHandler() {
  return async function GET(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: workerId } = await params

    try {
      const worker = await getWorker(workerId)

      if (!worker) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Worker not found' },
          { status: 404 }
        )
      }

      return NextResponse.json(worker)
    } catch (error) {
      log.error('Failed to get worker', { error, workerId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to get worker' },
        { status: 500 }
      )
    }
  }
}
