/**
 * GET /api/workers
 *
 * List all registered workers.
 * Used by dashboard to display worker status.
 */

import { NextResponse } from 'next/server'
import { listWorkers, getTotalCapacity, getQueueLength, createLogger } from '@donmai/server'

const log = createLogger('api:workers:list')

export function createWorkerListHandler() {
  return async function GET() {
    try {
      const [workers, queueLength] = await Promise.all([
        listWorkers(),
        getQueueLength(),
      ])

      const capacity = await getTotalCapacity(workers)

      return NextResponse.json({
        workers,
        summary: {
          totalWorkers: workers.length,
          activeWorkers: workers.filter((w) => w.status === 'active').length,
          ...capacity,
          queueLength,
        },
      })
    } catch (error) {
      log.error('Failed to list workers', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to list workers' },
        { status: 500 }
      )
    }
  }
}
