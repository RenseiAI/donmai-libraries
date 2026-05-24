/**
 * Worker Authentication — Next.js Adapter
 *
 * Thin wrapper around @donmai/server's framework-agnostic
 * auth functions, adapted for Next.js request/response types.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  extractBearerToken,
  verifyApiKey,
  isWorkerAuthConfigured,
  createLogger,
} from '@donmai/server'

export { isWorkerAuthConfigured }

const log = createLogger('worker-auth')

/**
 * Verify worker API key from request
 */
export function verifyWorkerAuth(request: NextRequest): boolean {
  const token = extractBearerToken(request.headers.get('authorization'))
  if (!token) {
    log.debug('Missing or invalid Authorization header')
    return false
  }
  return verifyApiKey(token)
}

/**
 * Create an unauthorized response
 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized', message: 'Invalid or missing API key' },
    { status: 401 }
  )
}

/**
 * Middleware helper for protected routes
 *
 * @param request - Next.js request object
 * @returns NextResponse if unauthorized, null if authorized
 */
export function requireWorkerAuth(request: NextRequest): NextResponse | null {
  if (!verifyWorkerAuth(request)) {
    log.warn('Unauthorized worker API request', {
      path: request.nextUrl.pathname,
      ip: request.headers.get('x-forwarded-for') || 'unknown',
    })
    return unauthorizedResponse()
  }
  return null
}
