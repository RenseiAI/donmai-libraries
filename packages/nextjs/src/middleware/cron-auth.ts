/**
 * Cron Authentication Middleware
 *
 * Verifies cron job requests using CRON_SECRET or Vercel Cron headers.
 * In development, allows requests without secret.
 */

import { NextRequest } from 'next/server'
import { createLogger } from '@donmai/server'

const log = createLogger('cron-auth')

/**
 * Verify cron authentication
 *
 * Requires CRON_SECRET in production to prevent abuse.
 * In development, allows requests without secret.
 *
 * @param request - Next.js request object
 * @param cronSecret - Optional override for CRON_SECRET env var
 */
export function verifyCronAuth(
  request: NextRequest,
  cronSecret?: string
): { authorized: boolean; reason?: string } {
  const secret = cronSecret ?? process.env.CRON_SECRET
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL_ENV === 'production'
  const isVercel = !!process.env.VERCEL

  // Check if running as Vercel Cron (trusted header only on Vercel)
  const vercelCron = request.headers.get('x-vercel-cron')
  if (isVercel && vercelCron) {
    return { authorized: true }
  }

  // Check Authorization header
  const authHeader = request.headers.get('authorization')
  if (secret && authHeader === `Bearer ${secret}`) {
    return { authorized: true }
  }

  // In production, CRON_SECRET is required
  if (isProduction) {
    if (!secret) {
      return { authorized: false, reason: 'CRON_SECRET not configured' }
    }
    return { authorized: false, reason: 'Invalid or missing authorization' }
  }

  // In development, allow without secret but log warning
  if (!secret) {
    log.warn('CRON_SECRET not configured - allowing request in development')
    return { authorized: true }
  }

  return { authorized: false, reason: 'Invalid authorization' }
}
