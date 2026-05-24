/**
 * Handle agent session 'create' events — new session initiated.
 */

import { NextResponse } from 'next/server'
import type { AgentWorkType } from '@donmai/core'
import type { LinearWebhookPayload } from '@donmai/plugin-linear'
import {
  TERMINAL_STATUSES,
  validateWorkTypeForStatus,
  WORK_TYPE_ALLOWED_STATUSES,
  STATUS_WORK_TYPE_MAP,
  getValidWorkTypesForStatus,
  buildFailureContextBlock,
  type WorkflowContext,
} from '@donmai/plugin-linear'
import {
  generateIdempotencyKey,
  isWebhookProcessed,
  storeSessionState,
  getSessionState,
  updateSessionStatus,
  dispatchWork,
  type QueuedWork,
  getWorkflowState,
  checkSessionFailureBackoff,
  clearSessionFailures,
  getTotalSessionCount,
  MAX_TOTAL_SESSIONS,
  incrementDispatchCount,
  getDispatchCount,
} from '@donmai/server'
import type { ResolvedWebhookConfig } from '../../types.js'
import {
  emitActivity,
  determineWorkType,
  isProjectAllowed,
  getAppUrl,
  getPriority,
  WORK_TYPE_MESSAGES,
} from '../utils.js'
import type { createLogger } from '@donmai/server'

export async function handleSessionCreated(
  config: ResolvedWebhookConfig,
  payload: LinearWebhookPayload,
  rawPayload: Record<string, unknown>,
  log: ReturnType<typeof createLogger>
): Promise<NextResponse | null> {
  const agentSession = rawPayload.agentSession as Record<string, unknown>

  log.debug('AgentSessionEvent payload structure', {
    payloadKeys: Object.keys(rawPayload),
    agentSessionKeys: agentSession ? Object.keys(agentSession) : [],
    hasAgentSession: !!agentSession,
  })

  if (!agentSession) {
    log.error('AgentSessionEvent missing agentSession field', {
      payloadKeys: Object.keys(rawPayload),
    })
    return NextResponse.json(
      { error: 'Missing agentSession in webhook payload', success: false },
      { status: 400 }
    )
  }

  const sessionId = agentSession.id as string
  const issue = agentSession.issue as Record<string, unknown> | undefined
  const issueId = (agentSession.issueId as string) || issue?.id as string
  const webhookId = rawPayload.webhookId as string
  const agentId = agentSession.agentId as string | undefined

  if (!sessionId || !issueId) {
    log.error('Missing sessionId or issueId in webhook payload', {
      sessionId,
      issueId,
      agentSessionKeys: Object.keys(agentSession),
    })
    return NextResponse.json(
      { error: 'Invalid payload structure', success: false },
      { status: 400 }
    )
  }

  const sessionLog = log.child({ sessionId, issueId })

  const promptContext = rawPayload.promptContext as string | undefined
  const user = rawPayload.user as Record<string, unknown> | undefined
  const comment = rawPayload.comment as Record<string, unknown> | undefined

  const isMention = !!comment
  const initiationType = isMention ? 'mention' : 'delegation'

  sessionLog.info('Agent session created', {
    initiationType,
    isMention,
    hasPromptContext: !!promptContext,
    promptContextLength: promptContext?.length,
    userName: user?.name,
  })

  // Idempotency check
  const idempotencyKey = generateIdempotencyKey(webhookId, sessionId)

  if (await isWebhookProcessed(idempotencyKey)) {
    sessionLog.info('Duplicate webhook ignored', { idempotencyKey })
    return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_webhook' })
  }

  const existingSession = await getSessionState(sessionId)
  if (existingSession) {
    sessionLog.info('Session already exists', { status: existingSession.status })
    return NextResponse.json({ success: true, skipped: true, reason: 'session_already_exists' })
  }

  const issueIdentifier = (issue?.identifier as string) || issueId.slice(0, 8)

  // Determine work type
  let workType: AgentWorkType = 'development'
  let currentStatus: string | undefined
  let projectName: string | undefined
  let workTypeSource: 'mention' | 'status' = 'status'

  // Fetch current issue status
  try {
    const linearClient = await config.linearClient.getClient(payload.organizationId)
    const issueDetails = await linearClient.getIssue(issueId)
    const currentState = await issueDetails.state
    currentStatus = currentState?.name
    sessionLog.debug('Fetched current issue status', { currentStatus })

    // Extract project name for routing
    const project = await issueDetails.project
    projectName = project?.name
  } catch (err) {
    sessionLog.warn('Failed to fetch issue status', { error: err })
  }

  // Server-level project filter
  if (!isProjectAllowed(projectName, config.projects ?? [])) {
    sessionLog.debug('Project not handled by this server, skipping', { projectName })
    return NextResponse.json({ success: true, skipped: true, reason: 'project_not_allowed' })
  }

  // Phase 1: Mention-based routing
  if (isMention && promptContext && config.detectWorkTypeFromPrompt) {
    // For mentions: unconstrained detection (pass all work types)
    const allWorkTypes: AgentWorkType[] = [
      'backlog-creation', 'research', 'qa', 'inflight',
      'acceptance', 'refinement', 'refinement-coordination', 'development',
    ]
    const mentionWorkType = config.detectWorkTypeFromPrompt(promptContext, allWorkTypes)
    if (mentionWorkType) {
      workType = mentionWorkType
      workTypeSource = 'mention'
      sessionLog.info('Detected work type from mention prompt', {
        workType,
        currentStatus,
        promptPreview: promptContext.substring(0, 50),
      })
    }
  }

  // For non-mentions or when mention detection failed: constrained detection
  if (workTypeSource === 'status' && promptContext && currentStatus && config.detectWorkTypeFromPrompt) {
    const validWorkTypes = getValidWorkTypesForStatus(currentStatus)
    const constrainedWorkType = config.detectWorkTypeFromPrompt(promptContext, validWorkTypes)

    if (constrainedWorkType) {
      workType = constrainedWorkType
      workTypeSource = 'mention'
      sessionLog.info('Detected work type from promptContext (constrained)', {
        workType,
        currentStatus,
        validWorkTypes,
      })
    }
  }

  // Phase 2: Fall back to status-based routing
  if (workTypeSource === 'status') {
    workType = determineWorkType(currentStatus)
    sessionLog.info('Detected work type from issue status', {
      currentStatus,
      workType,
    })
  }

  // Phase 2.5: Skip child/sub-issues for non-mention sessions.
  // Sub-issues are managed by the parent issue's agent, not dispatched independently.
  if (workTypeSource === 'status' && workType === 'development') {
    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      const isChild = await linearClient.isChildIssue(issueId)
      if (isChild) {
        sessionLog.info('Sub-issue detected, skipping independent agent dispatch', {
          issueIdentifier,
        })

        try {
          await emitActivity(
            linearClient,
            sessionId,
            'response',
            `This is a sub-issue. Work will be coordinated by the parent issue's agent.`
          )
        } catch (err) {
          sessionLog.warn('Failed to emit sub-issue skip activity', { error: err })
        }

        return NextResponse.json({
          success: true,
          skipped: true,
          reason: 'sub_issue_managed_by_parent',
        })
      }
    } catch (err) {
      sessionLog.warn('Failed to check issue child status', { error: err })
    }
  }

  // Check terminal state
  if (currentStatus && TERMINAL_STATUSES.includes(currentStatus as typeof TERMINAL_STATUSES[number])) {
    sessionLog.info('Issue in terminal state, acknowledging mention', { currentStatus })

    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      await emitActivity(
        linearClient,
        sessionId,
        'response',
        `This issue is in **${currentStatus}** status and has been completed. No further agent work is needed.\n\n` +
        `If you need additional help, please create a new issue or reopen this one by moving it back to an active status.`
      )
    } catch (err) {
      sessionLog.error('Failed to emit terminal state response', { error: err })
    }

    return NextResponse.json({ success: true, skipped: true, reason: 'terminal_state', currentStatus })
  }

  // Validate work type for status
  if (currentStatus) {
    const validation = validateWorkTypeForStatus(workType, currentStatus)
    if (!validation.valid) {
      sessionLog.warn('Work type validation failed', { workType, currentStatus, error: validation.error })

      try {
        const linearClient = await config.linearClient.getClient(payload.organizationId)
        const allowedStatuses = WORK_TYPE_ALLOWED_STATUSES[workType]
        const expectedWorkType = STATUS_WORK_TYPE_MAP[currentStatus]

        await emitActivity(
          linearClient,
          sessionId,
          'error',
          `Cannot perform ${workType} work on this issue.\n\n` +
          `**Current status:** ${currentStatus}\n` +
          `**${workType} requires status:** ${allowedStatuses.join(' or ')}\n\n` +
          (expectedWorkType
            ? `For issues in ${currentStatus} status, use ${expectedWorkType} commands instead.`
            : `This issue's status (${currentStatus}) is not handled by the agent.`)
        )
      } catch (err) {
        sessionLog.error('Failed to emit validation error activity', { error: err })
      }

      return NextResponse.json({
        success: false,
        error: 'work_type_invalid_for_status',
        message: validation.error,
      })
    }
  }

  // Session failure circuit breaker — prevent runaway retry loops.
  // Mentions bypass the backoff timer (user explicitly asked for a retry)
  // but NOT the hard stop (too many consecutive failures need human investigation).
  const failureCheck = await checkSessionFailureBackoff(issueId)
  if (!failureCheck.allowed) {
    const isHardStop = failureCheck.reason === 'hard_stop'
    const canBypass = isMention && !isHardStop

    if (!canBypass) {
      sessionLog.warn('Session dispatch blocked by failure circuit breaker', {
        reason: failureCheck.reason,
        failureCount: failureCheck.failureCount,
        backoffRemainingS: failureCheck.backoffRemainingS,
        isMention,
      })

      try {
        const linearClient = await config.linearClient.getClient(payload.organizationId)
        await emitActivity(
          linearClient,
          sessionId,
          'response',
          failureCheck.message ?? 'Agent dispatch paused due to repeated failures.'
        )
      } catch (err) {
        sessionLog.warn('Failed to emit circuit breaker activity', { error: err })
      }

      return NextResponse.json({
        success: true,
        skipped: true,
        reason: `session_failure_${failureCheck.reason}`,
        failureCount: failureCheck.failureCount,
        backoffRemainingS: failureCheck.backoffRemainingS,
      })
    }

    // Mention bypassing backoff — clear failures so the retry starts fresh
    sessionLog.info('Mention bypassing session failure backoff', {
      failureCount: failureCheck.failureCount,
    })
    await clearSessionFailures(issueId)
  }

  // Total session hard cap — prevent infinite dispatch loops.
  // Uses two counters: workflow-state-based (tracks phase-recorded sessions)
  // and dispatch counter (tracks ALL dispatches including no-op sessions).
  // When an issue accumulates too many sessions (e.g., agent keeps completing
  // without producing a WORK_RESULT marker, leaving the issue in a non-terminal
  // state that triggers new auto-sessions), this cap stops the cycle.
  // Mentions bypass only if under 2× the cap (absolute safety valve).
  try {
    const [totalSessions, dispatchCount] = await Promise.all([
      getTotalSessionCount(issueId),
      getDispatchCount(issueId),
    ])
    const effectiveCount = Math.max(totalSessions, dispatchCount)

    if (effectiveCount >= MAX_TOTAL_SESSIONS) {
      const canBypassCap = isMention && effectiveCount < MAX_TOTAL_SESSIONS * 2
      if (!canBypassCap) {
        sessionLog.warn('Session hard cap reached, blocking dispatch', {
          totalSessions,
          dispatchCount,
          effectiveCount,
          maxTotalSessions: MAX_TOTAL_SESSIONS,
          isMention,
        })

        try {
          const linearClient = await config.linearClient.getClient(payload.organizationId)
          await emitActivity(
            linearClient,
            sessionId,
            'response',
            `⚠️ **Session hard cap reached** (${effectiveCount}/${MAX_TOTAL_SESSIONS}). ` +
            `No more automated sessions will be created for this issue. Manual intervention required.`
          )
        } catch (err) {
          sessionLog.warn('Failed to emit session cap activity', { error: err })
        }

        return NextResponse.json({
          success: true,
          skipped: true,
          reason: 'session_hard_cap',
          totalSessions: effectiveCount,
        })
      }
    }
  } catch (err) {
    sessionLog.warn('Failed to check total session count', { error: err })
  }

  // Extract PR info for QA/acceptance agents so they know which PRs to validate
  let prContext = ''
  const needsPrContext =
    workType === 'qa' ||
    workType === 'acceptance'

  if (needsPrContext) {
    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      const issueForAttachments = await linearClient.getIssue(issueId)
      const attachments = await issueForAttachments.attachments()

      const prLinks = attachments.nodes
        .filter((a) => a.url?.includes('github.com') && a.url?.includes('/pull/'))
        .map((a) => {
          const match = a.url.match(/\/pull\/(\d+)/)
          return match ? { url: a.url, number: parseInt(match[1], 10), title: a.title ?? '' } : null
        })
        .filter((pr): pr is { url: string; number: number; title: string } => pr !== null)

      if (prLinks.length > 0) {
        prContext = '\n\nLinked PRs:\n'
        prContext += prLinks.map((pr) => `- PR #${pr.number}: ${pr.title} (${pr.url})`).join('\n')
        if (prLinks.length > 1) {
          prContext +=
            '\n\nNote: Multiple PRs are linked. Check each PR state (open/merged/closed) and validate the most recent OPEN one.'
        }
      }

      sessionLog.debug('Extracted PR context for QA/acceptance', {
        prLinksCount: prLinks.length,
        hasPrContext: prContext.length > 0,
      })
    } catch (err) {
      sessionLog.warn('Failed to extract PR info from issue attachments', { error: err })
    }
  }

  const enhancedPromptContext = prContext
    ? promptContext
      ? promptContext + prContext
      : prContext
    : promptContext

  const priority = getPriority(config, workType)

  await storeSessionState(sessionId, {
    issueId,
    issueIdentifier,
    providerSessionId: null,
    worktreePath: '',
    status: 'pending',
    queuedAt: Date.now(),
    promptContext: promptContext,
    priority,
    organizationId: payload.organizationId,
    workType,
    agentId,
    projectName,
  })

  // Enrich prompt with workflow failure context for retries
  // Applies to: refinement, development (rework from Backlog), coordination (rework from Started)
  let workflowContextBlock = ''
  let wfContext: WorkflowContext | undefined
  const needsFailureContext =
    workType === 'refinement' || workType === 'refinement-coordination' ||
    (workType === 'development' && (currentStatus === 'Backlog' || currentStatus === 'Started'))
  if (needsFailureContext) {
    try {
      const workflowState = await getWorkflowState(issueId)
      if (workflowState && workflowState.cycleCount > 0) {
        wfContext = {
          cycleCount: workflowState.cycleCount,
          strategy: workflowState.strategy,
          failureSummary: workflowState.failureSummary,
        }
        workflowContextBlock = buildFailureContextBlock(workType, wfContext)
        if (workflowContextBlock) {
          sessionLog.info('Prompt enriched with workflow failure context', {
            workType,
            cycleCount: workflowState.cycleCount,
            strategy: workflowState.strategy,
          })
        }
      }
    } catch (err) {
      sessionLog.warn('Failed to enrich prompt with workflow context', { error: err })
    }
  }

  // Queue work
  const work: QueuedWork = {
    sessionId,
    issueId,
    issueIdentifier,
    priority,
    queuedAt: Date.now(),
    workType,
    prompt: config.generatePrompt(issueIdentifier, workType, enhancedPromptContext, wfContext) + workflowContextBlock,
    projectName,
  }

  const result = await dispatchWork(work)

  if (result.dispatched || result.parked) {
    // Increment per-issue dispatch counter for hard cap enforcement
    try {
      await incrementDispatchCount(issueId)
    } catch (err) {
      sessionLog.warn('Failed to increment dispatch count', { error: err })
    }

    sessionLog.info('Work dispatched', {
      sessionId,
      issueIdentifier,
      workType,
      dispatched: result.dispatched,
      parked: result.parked,
      replaced: result.replaced,
    })
  } else {
    sessionLog.error('Failed to dispatch work')
    await updateSessionStatus(sessionId, 'failed')
  }

  // Update session with externalUrl and acknowledge
  try {
    const linearClient = await config.linearClient.getClient(payload.organizationId)
    const appUrl = getAppUrl(config)

    await linearClient.updateAgentSession({
      sessionId,
      externalUrls: [
        {
          label: 'Agent Dashboard',
          url: `${appUrl}/sessions/${sessionId}`,
        },
      ],
    })

    const activityText = WORK_TYPE_MESSAGES[workType]
    await emitActivity(linearClient, sessionId, 'thought', activityText)
    sessionLog.debug('Session updated and activity emitted')
  } catch (err) {
    sessionLog.error('Failed to update session or create comment', { error: err })
  }

  return null // Continue processing
}
