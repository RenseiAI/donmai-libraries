/**
 * Middleware Factory — Edge Runtime Compatible
 *
 * Creates a Next.js middleware function that handles authentication,
 * rate limiting, and security for AgentFactory API routes.
 *
 * IMPORTANT: This module runs in the Edge Runtime. It MUST NOT import
 * from @donmai/server (which uses Node.js crypto/ioredis).
 * All utilities are inlined for Edge compatibility.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { MiddlewareConfig } from './types.js'

// === Edge-compatible rate limiting ===

interface RateLimitEntry {
  timestamps: number[]
  lastAccess: number
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetIn: number
  limit: number
}

const RATE_LIMITS = {
  public: { limit: 60, windowMs: 60_000 },
  webhook: { limit: 10, windowMs: 1_000 },
  dashboard: { limit: 30, windowMs: 60_000 },
} as const

type RateLimitType = keyof typeof RATE_LIMITS

const caches = new Map<string, Map<string, RateLimitEntry>>()

function checkRateLimit(type: RateLimitType, key: string): RateLimitResult {
  const config = RATE_LIMITS[type]
  let cache = caches.get(type)
  if (!cache) {
    cache = new Map()
    caches.set(type, cache)
  }

  const now = Date.now()
  const windowStart = now - config.windowMs
  let entry = cache.get(key)
  if (!entry) {
    entry = { timestamps: [], lastAccess: now }
  }

  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart)
  entry.lastAccess = now

  const allowed = entry.timestamps.length < config.limit
  if (allowed) entry.timestamps.push(now)
  cache.set(key, entry)

  // LRU eviction at 10k entries
  if (cache.size > 10_000) {
    const entries = Array.from(cache.entries()).sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess
    )
    const toRemove = Math.ceil(10_000 * 0.1)
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      cache.delete(entries[i][0])
    }
  }

  const remaining = Math.max(0, config.limit - entry.timestamps.length)
  const oldestTs = entry.timestamps[0]
  const resetIn = oldestTs ? Math.max(0, oldestTs + config.windowMs - now) : 0

  return { allowed, remaining, resetIn, limit: config.limit }
}

// === Edge-compatible utilities ===

function getClientIP(headers: Headers): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    headers.get('cf-connecting-ip') ||
    headers.get('x-real-ip') ||
    'unknown'
  )
}

function buildRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': Math.ceil(result.resetIn / 1000).toString(),
  }
}

/**
 * Timing-safe string comparison using XOR (Edge-compatible).
 * Does NOT use Node.js crypto.timingSafeEqual.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

// === Route defaults ===

const DEFAULT_PUBLIC_ROUTES = ['/api/public/', '/dashboard', '/pipeline', '/settings', '/']
const DEFAULT_PROTECTED_ROUTES = ['/api/sessions', '/api/workers']
const DEFAULT_SESSION_PAGES = ['/sessions/']
const DEFAULT_WEBHOOK_ROUTE = '/webhook'
const DEFAULT_PASSTHROUGH_ROUTES = ['/api/cleanup']

/**
 * Create an AgentFactory middleware function with configurable routes
 * and rate limiting.
 *
 * @example
 * ```typescript
 * // In middleware.ts:
 * import { createAgentFactoryMiddleware } from '@donmai/nextjs'
 *
 * const { middleware, matcherConfig } = createAgentFactoryMiddleware()
 * export { middleware }
 * export const config = matcherConfig
 * ```
 */
export function createAgentFactoryMiddleware(userConfig?: MiddlewareConfig) {
  const publicRoutes = userConfig?.routes?.public ?? DEFAULT_PUBLIC_ROUTES
  const protectedRoutes = userConfig?.routes?.protected ?? DEFAULT_PROTECTED_ROUTES
  const sessionPages = userConfig?.routes?.sessionPages ?? DEFAULT_SESSION_PAGES
  const webhookRoute = userConfig?.routes?.webhook ?? DEFAULT_WEBHOOK_ROUTE
  const passthroughRoutes = userConfig?.routes?.passthrough ?? DEFAULT_PASSTHROUGH_ROUTES

  function middleware(request: NextRequest): NextResponse | undefined {
    const { pathname } = request.nextUrl
    const clientIP = getClientIP(request.headers)

    // === PROTECTED INTERNAL APIS (checked first — no rate limiting) ===
    // Must come before public routes because '/' in publicRoutes would
    // match all pathnames via startsWith, rate-limiting authenticated workers.
    if (protectedRoutes.some(route => pathname.startsWith(route))) {
      const workerApiKey = process.env.WORKER_API_KEY

      // In development without key, allow access
      if (!workerApiKey && process.env.NODE_ENV !== 'production') {
        return NextResponse.next()
      }

      if (!workerApiKey) {
        console.error('WORKER_API_KEY not configured - blocking protected API access')
        return new NextResponse(
          JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const authHeader = request.headers.get('authorization')
      if (!authHeader?.startsWith('Bearer ')) {
        return new NextResponse(
          JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const token = authHeader.slice(7)
      if (!timingSafeEqual(token, workerApiKey)) {
        return new NextResponse(
          JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return NextResponse.next()
    }

    // === WEBHOOK ROUTE ===
    if (pathname === webhookRoute) {
      const result = checkRateLimit('webhook', clientIP)

      if (!result.allowed) {
        return new NextResponse(
          JSON.stringify({ error: 'Too many requests' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...buildRateLimitHeaders(result),
            },
          }
        )
      }

      return NextResponse.next()
    }

    // === SESSION DETAIL PAGES ===
    if (sessionPages.some(route => pathname.startsWith(route))) {
      return NextResponse.next()
    }

    // === PASSTHROUGH ROUTES ===
    if (passthroughRoutes.some(route => pathname === route || pathname.startsWith(route))) {
      return NextResponse.next()
    }

    // === PUBLIC ROUTES (rate limited) ===
    if (publicRoutes.some(route => pathname === route || pathname.startsWith(route))) {
      const result = checkRateLimit('public', clientIP)

      if (!result.allowed) {
        return new NextResponse(
          JSON.stringify({ error: 'Too many requests' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...buildRateLimitHeaders(result),
            },
          }
        )
      }

      const response = NextResponse.next()
      const rateLimitHeaders = buildRateLimitHeaders(result)
      for (const [key, value] of Object.entries(rateLimitHeaders)) {
        response.headers.set(key, value)
      }
      return response
    }

    // === ALL OTHER ROUTES ===
    return NextResponse.next()
  }

  const matcherConfig = {
    matcher: [
      '/api/:path*',
      webhookRoute,
      '/dashboard',
      '/pipeline',
      '/settings',
      '/sessions/:path*',
      '/',
    ],
  }

  return { middleware, matcherConfig }
}
