/**
 * Handle agent session 'prompted' events — follow-up messages or stop/continue signals.
 */

import { NextResponse } from 'next/server'
import type { AgentWorkType } from '@donmai/core'
import type { LinearWebhookPayload } from '@donmai/plugin-linear'
import {
  getSessionState,
  updateSessionStatus,
  storeSessionState,
  releaseClaim,
  removeWorkerSession,
  dispatchWork,
  type QueuedWork,
  publishUrgent,
  generateIdempotencyKey,
  isWebhookProcessed,
} from '@donmai/server'
import type { ResolvedWebhookConfig } from '../../types.js'
import { handleStopSignal, emitActivity, determineWorkType } from '../utils.js'
import type { createLogger } from '@donmai/server'

/**
 * Strip @mention triggers from comment body to extract actual user instructions.
 * Returns empty string if the comment is only @mentions with no real content.
 */
export function stripMentionTriggers(text: string): string {
  return text.replace(/@\w+/g, '').trim()
}

export async function handleSessionPrompted(
  config: ResolvedWebhookConfig,
  payload: LinearWebhookPayload,
  rawPayload: Record<string, unknown>,
  log: ReturnType<typeof createLogger>
): Promise<NextResponse | null> {
  const agentSession = rawPayload.agentSession as Record<string, unknown>

  if (!agentSession) {
    log.warn('AgentSessionEvent prompted missing agentSession field')
    return NextResponse.json({ success: true, skipped: true, reason: 'missing_agent_session' })
  }

  const sessionId = agentSession.id as string
  const issue = agentSession.issue as Record<string, unknown> | undefined
  const issueId = (agentSession.issueId as string) || issue?.id as string
  const promptText = (rawPayload.promptContext as string) || ''
  const webhookId = rawPayload.webhookId as string
  const user = rawPayload.user as Record<string, unknown> | undefined
  const agentActivity = rawPayload.agentActivity as Record<string, unknown> | undefined
  const comment = rawPayload.comment as Record<string, unknown> | undefined
  const commentBody = (comment?.body as string) || ''

  const promptLog = log.child({ sessionId, issueId })

  // Check for stop/continue signals
  const activitySignal = agentActivity?.signal as string | undefined
  const isStopSignal = activitySignal === 'stop'
  const isContinueSignal = activitySignal === 'continue'

  promptLog.info('Agent session prompted', {
    hasPromptContext: !!promptText,
    promptContextLength: promptText?.length,
    userName: user?.name,
    hasAgentActivity: !!agentActivity,
    activitySignal,
    isStopSignal,
    isContinueSignal,
    hasComment: !!comment,
    commentBodyLength: commentBody?.length,
  })

  // Handle stop signal
  if (isStopSignal) {
    promptLog.info('Stop signal received via prompted webhook')
    await handleStopSignal(config, sessionId, issueId, payload.organizationId)
    return NextResponse.json({ success: true, action: 'stopped', sessionId })
  }

  // Handle continue signal
  if (isContinueSignal) {
    promptLog.info('Continue signal received via prompted webhook')

    const existingSession = await getSessionState(sessionId)
    const workType: AgentWorkType = existingSession?.workType || 'inflight'
    let resumePrompt = promptText || commentBody || ''

    const issueIdentifier =
      existingSession?.issueIdentifier ||
      (issue?.identifier as string) ||
      issueId.slice(0, 8)

    promptLog.info('Session state for continue', {
      hasExistingSession: !!existingSession,
      sessionStatus: existingSession?.status,
      workType,
    })

    if (!resumePrompt.trim()) {
      resumePrompt = config.generatePrompt(issueIdentifier, workType)
    }

    // Reset session status if in terminal state
    if (existingSession && ['completed', 'failed', 'stopped'].includes(existingSession.status)) {
      await releaseClaim(sessionId)
      if (existingSession.workerId) {
        await removeWorkerSession(existingSession.workerId, sessionId)
      }
      await updateSessionStatus(sessionId, 'pending')
    }

    // Update organizationId if missing
    if (existingSession && !existingSession.organizationId && payload.organizationId) {
      await storeSessionState(sessionId, {
        ...existingSession,
        organizationId: payload.organizationId,
        status: 'pending',
      })
    }

    // Queue work to resume
    const work: QueuedWork = {
      sessionId,
      issueId,
      issueIdentifier,
      priority: 2,
      queuedAt: Date.now(),
      prompt: resumePrompt,
      providerSessionId: existingSession?.providerSessionId || undefined,
      workType,
      projectName: existingSession?.projectName,
    }

    await dispatchWork(work)

    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      await emitActivity(
        linearClient,
        sessionId,
        'thought',
        'Session resume requested. Waiting for an available worker...'
      )
    } catch (err) {
      promptLog.error('Failed to emit continue acknowledgment activity', { error: err })
    }

    return NextResponse.json({ success: true, action: 'continue_queued', sessionId })
  }

  // Generate idempotency key for prompted events
  const idempotencyKey = generateIdempotencyKey(
    webhookId,
    `${sessionId}:prompt:${payload.createdAt}`
  )

  if (await isWebhookProcessed(idempotencyKey)) {
    promptLog.info('Duplicate prompted webhook ignored', { idempotencyKey })
    return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_prompt' })
  }

  const existingSession = await getSessionState(sessionId)
  const issueIdentifier =
    existingSession?.issueIdentifier ||
    (issue?.identifier as string) ||
    issueId.slice(0, 8)

  // Determine effective prompt with cascading fallbacks.
  // Key: strip @mention triggers from comment body so bare mentions (e.g., "@rensei")
  // fall through to generatePrompt instead of being treated as instructions.
  let effectivePrompt = promptText.trim()

  if (!effectivePrompt && commentBody.trim()) {
    const strippedComment = stripMentionTriggers(commentBody)
    if (strippedComment) {
      effectivePrompt = strippedComment
      promptLog.info('Using comment body (stripped) as prompt fallback')
    }
  }

  if (!effectivePrompt) {
    // No user instructions — derive work type from current issue status
    // (not the stale session work type) and generate a proper work prompt.
    let derivedWorkType: AgentWorkType = existingSession?.workType || 'inflight'

    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      const issueDetails = await linearClient.getIssue(issueId)
      const currentState = await issueDetails.state
      const currentStatus = currentState?.name

      if (currentStatus) {
        derivedWorkType = determineWorkType(currentStatus)

        // No coordination variant upgrade needed — parent/leaf issues use the same work type

        promptLog.info('Derived work type from current issue status', {
          currentStatus,
          derivedWorkType,
          previousWorkType: existingSession?.workType,
        })
      }
    } catch (err) {
      promptLog.warn('Failed to derive work type from issue status, using session fallback', { error: err })
    }

    effectivePrompt = config.generatePrompt(issueIdentifier, derivedWorkType)
    promptLog.info('Generated work prompt for bare mention', { derivedWorkType })
  }

  // If session is running, publish as urgent directive to agent inbox
  if (existingSession?.status === 'running' || existingSession?.status === 'claimed') {
    const agentId = existingSession.agentId
    if (!agentId) {
      promptLog.error('Session has no agentId, cannot publish to inbox', { sessionId })
    } else {
      try {
        const streamId = await publishUrgent(agentId, {
          type: 'directive',
          sessionId,
          payload: effectivePrompt,
          userId: user?.id as string | undefined,
          userName: user?.name as string | undefined,
          createdAt: Date.now(),
        })

        promptLog.info('Directive published to agent inbox', {
          streamId,
          sessionId,
          issueIdentifier,
          agentId,
          workerId: existingSession.workerId,
        })
      } catch (err) {
        promptLog.error('Failed to publish directive to inbox', { error: err })
      }
    }
  } else {
    // Session not running — queue as work
    promptLog.info('Queuing follow-up for non-running session', {
      sessionStatus: existingSession?.status,
    })

    if (existingSession && ['completed', 'failed', 'stopped'].includes(existingSession.status)) {
      await releaseClaim(sessionId)
      if (existingSession.workerId) {
        await removeWorkerSession(existingSession.workerId, sessionId)
      }
      await updateSessionStatus(sessionId, 'pending')
    }

    if (existingSession && !existingSession.organizationId && payload.organizationId) {
      await storeSessionState(sessionId, {
        ...existingSession,
        organizationId: payload.organizationId,
        status: 'pending',
      })
    }

    const work: QueuedWork = {
      sessionId,
      issueId,
      issueIdentifier,
      priority: 2,
      queuedAt: Date.now(),
      prompt: effectivePrompt,
      providerSessionId: existingSession?.providerSessionId || undefined,
      workType: existingSession?.workType || 'inflight',
      projectName: existingSession?.projectName,
    }

    const dispatchResult = await dispatchWork(work)

    if (dispatchResult.dispatched || dispatchResult.parked) {
      promptLog.info('Follow-up prompt dispatched', {
        sessionId,
        issueIdentifier,
        dispatched: dispatchResult.dispatched,
        parked: dispatchResult.parked,
      })
    } else {
      promptLog.error('Failed to dispatch follow-up prompt')
    }
  }

  // Acknowledge prompt receipt
  try {
    const linearClient = await config.linearClient.getClient(payload.organizationId)
    const truncatedPrompt =
      effectivePrompt.length > 100
        ? `${effectivePrompt.substring(0, 100)}...`
        : effectivePrompt

    await emitActivity(
      linearClient,
      sessionId,
      'thought',
      `Follow-up received: "${truncatedPrompt}" - Processing...`
    )
  } catch (err) {
    promptLog.error('Failed to emit prompt acknowledgment activity', { error: err })
  }

  return null // Continue processing
}
