/**
 * POST, GET /api/cleanup
 *
 * Trigger orphan session cleanup.
 */

import { NextRequest, NextResponse } from 'next/server'
import { cleanupOrphanedSessions, createLogger } from '@donmai/server'
import { verifyCronAuth } from '../middleware/cron-auth.js'
import type { CronConfig } from '../types.js'

const log = createLogger('api:cleanup')

export function createCleanupHandler(config?: CronConfig) {
  async function handleCleanup(request: NextRequest) {
    const authResult = verifyCronAuth(request, config?.cronSecret)
    if (!authResult.authorized) {
      log.warn('Unauthorized cleanup request', { reason: authResult.reason })
      return NextResponse.json(
        { error: 'Unauthorized', message: authResult.reason },
        { status: 401 }
      )
    }

    try {
      log.info('Running orphan cleanup')
      const result = await cleanupOrphanedSessions()

      return NextResponse.json({
        success: true,
        ...result,
      })
    } catch (error) {
      log.error('Cleanup failed', { error })
      return NextResponse.json(
        { error: 'Cleanup failed' },
        { status: 500 }
      )
    }
  }

  return {
    POST: handleCleanup,
    GET: handleCleanup,
  }
}
