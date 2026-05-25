/**
 * Handle agent session 'update' events — stop signal from user.
 */

import { NextResponse } from 'next/server'
import type { LinearWebhookPayload } from '@donmai/plugin-linear'
import type { ResolvedWebhookConfig } from '../../types.js'
import { handleStopSignal } from '../utils.js'
import type { createLogger } from '@donmai/server'

export async function handleSessionUpdated(
  config: ResolvedWebhookConfig,
  payload: LinearWebhookPayload,
  rawPayload: Record<string, unknown>,
  log: ReturnType<typeof createLogger>
): Promise<NextResponse | null> {
  const agentSession = rawPayload.agentSession as Record<string, unknown>

  if (!agentSession) {
    log.warn('AgentSessionEvent updated missing agentSession field')
    return NextResponse.json({ success: true, skipped: true, reason: 'missing_agent_session' })
  }

  const sessionId = agentSession.id as string
  const issue = agentSession.issue as Record<string, unknown> | undefined
  const issueId = (agentSession.issueId as string) || issue?.id as string
  const newState = agentSession.state as string
  const updatedFrom = rawPayload.updatedFrom as Record<string, unknown> | undefined
  const previousState = updatedFrom?.state as string | undefined

  const updateLog = log.child({ sessionId, issueId })

  updateLog.info('Agent session updated', {
    newState,
    previousState,
  })

  // Check if this is a stop signal (state changed to completed/failed)
  if (newState === 'completed' || newState === 'failed') {
    updateLog.info('Stop signal received via updated webhook', { previousState })
    await handleStopSignal(config, sessionId, issueId, payload.organizationId)
  }

  return null // Continue processing other handlers
}
