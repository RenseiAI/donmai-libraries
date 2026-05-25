/**
 * Issue Tracker Proxy Handler
 *
 * Centralizes all issue tracker API calls through the dashboard server.
 * Agents, governors, and CLI tools call this endpoint instead of the
 * issue tracker (e.g., Linear) directly.
 *
 * Benefits:
 * - Single rate limiter and circuit breaker for all consumers
 * - OAuth token management stays server-side
 * - Response caching (future: Redis-based read-through cache)
 * - Platform-agnostic interface: consumers don't need to know Linear exists
 *
 * POST /api/issue-tracker-proxy
 * Body: { method: string, args: unknown[], organizationId?: string }
 * Auth: Bearer <worker-api-key>
 *
 * GET /api/issue-tracker-proxy/health
 * Returns: circuit breaker state, rate limiter tokens, quota remaining
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createLogger } from '@donmai/server'
import type {
  ProxyRequest,
  ProxyResponse,
  IssueTrackerMethod,
} from '@donmai/plugin-linear'
import { isCircuitOpenError } from '@donmai/plugin-linear'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { serializeIssue, serializeComment, serializeViewer, serializeTeam } from './serializer.js'
import type { ProxyHandlerConfig } from './types.js'

const log = createLogger('api:issue-tracker-proxy')

/** Methods that are allowed through the proxy */
const ALLOWED_METHODS: Set<IssueTrackerMethod> = new Set([
  'getIssue',
  'updateIssue',
  'createIssue',
  'createComment',
  'getIssueComments',
  'getTeamStatuses',
  'updateIssueStatus',
  'createAgentActivity',
  'updateAgentSession',
  'createAgentSessionOnIssue',
  'createIssueRelation',
  'getIssueRelations',
  'deleteIssueRelation',
  'getSubIssues',
  'getSubIssueStatuses',
  'getSubIssueGraph',
  'isParentIssue',
  'isChildIssue',
  'listProjectIssues',
  'getProjectRepositoryUrl',
  'getViewer',
  'getTeam',
  'unassignIssue',
  'issueLabels',
  'teamMembers',
])

/**
 * Methods that return Issue objects needing serialization.
 */
const ISSUE_RETURNING_METHODS: Set<string> = new Set([
  'getIssue',
  'updateIssue',
  'createIssue',
  'updateIssueStatus',
  'unassignIssue',
])

/**
 * Methods that return Comment objects needing serialization.
 */
const COMMENT_RETURNING_METHODS: Set<string> = new Set([
  'createComment',
])

/**
 * Create the issue tracker proxy handler.
 *
 * @param config - Route config with Linear client resolver
 * @returns POST handler for proxy requests, GET handler for health check
 */
export function createIssueTrackerProxyHandler(config: ProxyHandlerConfig) {
  async function POST(request: NextRequest): Promise<NextResponse> {
    // Authenticate caller
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    let body: ProxyRequest
    try {
      body = (await request.json()) as ProxyRequest
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body', retryable: false } } satisfies ProxyResponse,
        { status: 400 }
      )
    }

    const { method, args, organizationId } = body

    // Validate method
    if (!method || !ALLOWED_METHODS.has(method as IssueTrackerMethod)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_METHOD', message: `Unknown method: ${method}`, retryable: false } } satisfies ProxyResponse,
        { status: 400 }
      )
    }

    // Validate args
    if (!Array.isArray(args)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_ARGS', message: 'args must be an array', retryable: false } } satisfies ProxyResponse,
        { status: 400 }
      )
    }

    log.debug('Proxy request', { method, organizationId, argsLength: args.length })

    try {
      // Resolve the Linear client for this workspace
      const client = await config.linearClient.getClient(organizationId)

      // Call the method on the client
      const fn = (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]
      if (typeof fn !== 'function') {
        return NextResponse.json(
          { success: false, error: { code: 'METHOD_NOT_FOUND', message: `Method ${method} not available on client`, retryable: false } } satisfies ProxyResponse,
          { status: 400 }
        )
      }

      const rawResult = await fn.apply(client, args)

      // Serialize result based on method type.
      // The serializer functions use duck-typing (no @linear/sdk dependency).
      let data: unknown
      if (ISSUE_RETURNING_METHODS.has(method) && rawResult && typeof rawResult === 'object' && 'id' in rawResult) {
        data = await serializeIssue(rawResult)
      } else if (COMMENT_RETURNING_METHODS.has(method) && rawResult && typeof rawResult === 'object' && 'body' in rawResult) {
        data = await serializeComment(rawResult)
      } else if (method === 'getIssueComments' && Array.isArray(rawResult)) {
        data = await Promise.all(rawResult.map((c: unknown) => serializeComment(c)))
      } else if (method === 'getSubIssues' && Array.isArray(rawResult)) {
        data = await Promise.all(rawResult.map((i: unknown) => serializeIssue(i)))
      } else if (method === 'getViewer' && rawResult && typeof rawResult === 'object' && 'email' in rawResult) {
        data = serializeViewer(rawResult)
      } else if (method === 'getTeam' && rawResult && typeof rawResult === 'object' && 'key' in rawResult) {
        data = serializeTeam(rawResult)
      } else {
        // Plain JSON-serializable results (e.g., boolean, relation results, status maps, sub-issue statuses, graphs)
        data = rawResult
      }

      const response: ProxyResponse = { success: true, data }
      return NextResponse.json(response)
    } catch (error) {
      // Circuit breaker open — return 503 so callers know to retry later
      if (isCircuitOpenError(error)) {
        log.warn('Proxy request blocked by circuit breaker', { method })
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'CIRCUIT_OPEN',
              message: error.message,
              retryable: true,
            },
          } satisfies ProxyResponse,
          {
            status: 503,
            headers: { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) },
          }
        )
      }

      // Auth errors — return 401/403
      const statusCode = extractStatusCode(error)
      if (statusCode === 401 || statusCode === 403) {
        log.error('Proxy auth error', { method, statusCode })
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'AUTH_ERROR',
              message: error instanceof Error ? error.message : 'Authentication failed',
              retryable: false,
            },
          } satisfies ProxyResponse,
          { status: statusCode }
        )
      }

      // Rate limited
      if (statusCode === 429) {
        log.warn('Proxy rate limited by upstream', { method })
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'RATE_LIMITED',
              message: 'Rate limited by upstream issue tracker',
              retryable: true,
            },
          } satisfies ProxyResponse,
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }

      // Generic errors
      log.error('Proxy request failed', {
        method,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'PROXY_ERROR',
            message: error instanceof Error ? error.message : 'Proxy request failed',
            retryable: statusCode !== undefined && statusCode >= 500,
          },
        } satisfies ProxyResponse,
        { status: statusCode ?? 500 }
      )
    }
  }

  async function GET(_request: NextRequest): Promise<NextResponse> {
    // Health endpoint — no auth required for monitoring
    try {
      const { getQuota } = await import('@donmai/server')
      const quota = await getQuota('default')

      return NextResponse.json({
        healthy: true,
        quota: {
          requestsRemaining: quota.requestsRemaining,
          complexityRemaining: quota.complexityRemaining,
          resetAt: quota.requestsReset,
          updatedAt: quota.updatedAt,
        },
      })
    } catch {
      return NextResponse.json({
        healthy: true,
        quota: { requestsRemaining: null, complexityRemaining: null, resetAt: null, updatedAt: 0 },
      })
    }
  }

  return { POST, GET }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const err = error as Record<string, unknown>
  if (typeof err.status === 'number') return err.status
  if (typeof err.statusCode === 'number') return err.statusCode
  const response = err.response as Record<string, unknown> | undefined
  if (response && typeof response.status === 'number') return response.status
  return undefined
}
