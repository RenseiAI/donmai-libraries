/**
 * Webhook Processor — Main Entry Point
 *
 * Receives Linear webhook events, verifies signatures, runs idempotency
 * checks, and dispatches to sub-handlers.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { LinearWebhookPayload } from '@donmai/plugin-linear'
import {
  isAgentSessionCreated,
  isAgentSessionPrompted,
  isAgentSessionUpdated,
  isIssueUpdate,
} from '@donmai/plugin-linear'
import { createLogger, generateRequestId } from '@donmai/server'
import type { ResolvedWebhookConfig } from '../types.js'
import { verifyWebhookSignature } from './signature.js'
import { handleSessionCreated } from './handlers/session-created.js'
import { handleSessionUpdated } from './handlers/session-updated.js'
import { handleSessionPrompted } from './handlers/session-prompted.js'
import { handleIssueUpdated } from './handlers/issue-updated.js'

const baseLogger = createLogger('webhook')

/**
 * Create webhook route handlers from config.
 *
 * Returns { POST, GET } for use as Next.js App Router exports.
 */
export function createWebhookHandler(config: ResolvedWebhookConfig) {
  async function POST(request: NextRequest) {
    const startTime = Date.now()
    const requestId = generateRequestId()
    const log = baseLogger.child({ requestId })

    try {
      const body = await request.text()
      const signature = request.headers.get('linear-signature')

      // Verify webhook signature
      const webhookSecret = config.webhookSecret ?? process.env.LINEAR_WEBHOOK_SECRET

      if (!webhookSecret) {
        const isProduction =
          process.env.NODE_ENV === 'production' ||
          process.env.VERCEL_ENV === 'production'

        if (isProduction) {
          log.error('LINEAR_WEBHOOK_SECRET not configured - rejecting webhook in production')
          return NextResponse.json(
            { error: 'Service unavailable', message: 'Webhook signature verification not configured' },
            { status: 503 }
          )
        } else {
          log.warn('LINEAR_WEBHOOK_SECRET not configured - skipping signature verification in development')
        }
      } else {
        if (!verifyWebhookSignature(body, signature, webhookSecret)) {
          log.warn('Invalid webhook signature')
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }
      }

      const payload: LinearWebhookPayload = JSON.parse(body)

      log.info('Webhook received', {
        webhookType: payload.type,
        webhookAction: payload.action,
        workspaceId: payload.organizationId,
      })

      const rawPayload = payload as unknown as Record<string, unknown>

      // Handle agent session 'create' events
      if (isAgentSessionCreated(payload)) {
        const result = await handleSessionCreated(config, payload, rawPayload, log)
        if (result) return result
      }

      // Handle agent session 'update' events (stop signal)
      if (isAgentSessionUpdated(payload)) {
        const result = await handleSessionUpdated(config, payload, rawPayload, log)
        if (result) return result
      }

      // Handle agent session 'prompted' events (follow-up messages)
      if (isAgentSessionPrompted(payload)) {
        const result = await handleSessionPrompted(config, payload, rawPayload, log)
        if (result) return result
      }

      // Handle Issue update events (status transitions)
      if (isIssueUpdate(payload)) {
        const result = await handleIssueUpdated(config, payload, log)
        if (result) return result
      }

      const durationMs = Date.now() - startTime
      log.info('Webhook processed', { durationMs })

      return NextResponse.json({ success: true, duration: durationMs, requestId })
    } catch (err) {
      const durationMs = Date.now() - startTime
      log.error('Webhook error', { error: err, durationMs })
      return NextResponse.json(
        { error: 'Internal server error', requestId },
        { status: 500 }
      )
    }
  }

  async function GET() {
    baseLogger.debug('Health check requested')
    return NextResponse.json({
      status: 'ok',
      endpoint: '/webhook',
      description: 'Linear webhook receiver',
    })
  }

  return { POST, GET }
}
