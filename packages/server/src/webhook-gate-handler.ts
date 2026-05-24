/**
 * Webhook Gate HTTP Handler
 *
 * Framework-agnostic request handler for webhook gate callbacks.
 * External systems POST to `/api/gates/{issueId}/{gateName}?token={token}`
 * to satisfy a webhook gate and resume workflow execution.
 *
 * Consuming applications wire this handler into their own HTTP server
 * (Express, Hono, Next.js, etc.) — this module has no framework dependency.
 */

import { timingSafeEqual } from 'node:crypto'
import type { GateStorage } from '@donmai/core'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[webhook-gate-handler] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[webhook-gate-handler] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[webhook-gate-handler] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ============================================
// Types
// ============================================

/** Gate status values matching the core GateState interface */
type GateStatus = 'pending' | 'active' | 'satisfied' | 'timed-out'

/**
 * Parsed parameters from the webhook gate callback request.
 * Framework integration layers extract these from the HTTP request.
 */
export interface WebhookGateCallbackParams {
  /** The issue identifier (from URL path) */
  issueId: string
  /** The gate name (from URL path) */
  gateName: string
  /** Authentication token (from query parameter) */
  token: string
  /** Optional JSON payload from the POST body */
  payload?: Record<string, unknown>
}

/**
 * Result of processing a webhook gate callback.
 * Framework integration layers use this to build the HTTP response.
 */
export interface WebhookGateCallbackResult {
  /** HTTP status code to return */
  status: number
  /** Response body */
  body: {
    ok: boolean
    /** Gate name that was processed */
    gate?: string
    /** Current gate status after processing */
    gateStatus?: GateStatus
    /** Error message if the request failed */
    error?: string
  }
}

// ============================================
// Internal helpers
// ============================================

/**
 * Timing-safe token comparison to prevent timing attacks.
 */
function validateToken(token: string, expectedToken: string): boolean {
  if (!token || !expectedToken) return false
  const tokenBuf = Buffer.from(token, 'utf8')
  const expectedBuf = Buffer.from(expectedToken, 'utf8')
  if (tokenBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(tokenBuf, expectedBuf)
}

// ============================================
// Handler
// ============================================

/**
 * Process an incoming webhook gate callback.
 *
 * This is the core handler logic, decoupled from any HTTP framework.
 * It validates the token, checks gate state, and satisfies the gate
 * if everything checks out.
 *
 * Expected endpoint: `POST /api/gates/{issueId}/{gateName}?token={token}`
 *
 * Response codes:
 * - 200: Gate satisfied successfully
 * - 400: Missing required parameters
 * - 401: Invalid or missing token
 * - 404: Gate not found
 * - 409: Gate not in active state (already satisfied or timed out)
 *
 * @param params - Parsed request parameters
 * @param storage - Gate storage adapter for state lookup and mutation
 * @returns Result with HTTP status code and response body
 */
export async function handleWebhookGateCallback(
  params: WebhookGateCallbackParams,
  storage: GateStorage,
): Promise<WebhookGateCallbackResult> {
  const { issueId, gateName, token, payload } = params

  // Validate required parameters
  if (!issueId || !gateName) {
    return {
      status: 400,
      body: { ok: false, error: 'Missing required path parameters: issueId and gateName' },
    }
  }

  if (!token) {
    return {
      status: 401,
      body: { ok: false, error: 'Missing required query parameter: token' },
    }
  }

  // Fetch gate state
  const gateState = await storage.getGateState(issueId, gateName)

  if (!gateState) {
    log.warn('Webhook callback for unknown gate', { issueId, gateName })
    return {
      status: 404,
      body: { ok: false, error: 'Gate not found' },
    }
  }

  // Verify this is a webhook gate
  if (gateState.gateType !== 'webhook') {
    log.warn('Webhook callback for non-webhook gate', { issueId, gateName, gateType: gateState.gateType })
    return {
      status: 404,
      body: { ok: false, error: 'Gate not found' },
    }
  }

  // Check gate is in active state
  if (gateState.status !== 'active') {
    log.warn('Webhook callback for non-active gate', { issueId, gateName, status: gateState.status })
    return {
      status: 409,
      body: {
        ok: false,
        gate: gateName,
        gateStatus: gateState.status,
        error: `Gate is ${gateState.status}, not active`,
      },
    }
  }

  // Check timeout deadline
  if (gateState.timeoutDeadline && Date.now() > gateState.timeoutDeadline) {
    log.warn('Webhook callback after timeout deadline', { issueId, gateName })
    return {
      status: 409,
      body: {
        ok: false,
        gate: gateName,
        gateStatus: 'timed-out',
        error: 'Gate has expired',
      },
    }
  }

  // Validate token
  const expectedToken = gateState.webhookToken
  if (!expectedToken) {
    log.error('Gate has no webhook token stored', { issueId, gateName })
    return {
      status: 500,
      body: { ok: false, error: 'Internal error: gate token not configured' },
    }
  }

  if (!validateToken(token, expectedToken)) {
    log.warn('Webhook callback with invalid token', { issueId, gateName })
    return {
      status: 401,
      body: { ok: false, error: 'Invalid token' },
    }
  }

  // Satisfy the gate
  const source = payload
    ? `webhook-callback:${JSON.stringify(payload)}`
    : 'webhook-callback'

  gateState.status = 'satisfied'
  gateState.satisfiedAt = Date.now()
  gateState.signalSource = source

  await storage.setGateState(issueId, gateName, gateState)

  log.info('Webhook gate satisfied via HTTP callback', { issueId, gateName })

  return {
    status: 200,
    body: {
      ok: true,
      gate: gateName,
      gateStatus: 'satisfied',
    },
  }
}
