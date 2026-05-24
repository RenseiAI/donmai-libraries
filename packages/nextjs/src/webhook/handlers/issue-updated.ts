/**
 * Handle Issue update events — status transition triggers.
 *
 * Handles:
 * - Finished → auto-QA trigger (with circuit breaker)
 * - → Rejected → escalation ladder (circuit breaker, decomposition, human escalation)
 * - (Icebox|Rejected|Canceled) → Backlog → auto-development trigger (with circuit breaker)
 * - Finished → Delivered → auto-acceptance trigger
 */

import { NextResponse } from 'next/server'
import type { AgentWorkType } from '@donmai/core'
import { buildFailureContextBlock, type WorkflowContext } from '@donmai/plugin-linear'
import type { LinearWebhookPayload } from '@donmai/plugin-linear'
import {
  checkIssueDeploymentStatus,
  formatFailedDeployments,
  eventTimestamp,
} from '@donmai/core'
import type { GovernorIssue } from '@donmai/core'
import { publishGovernorEvent } from '../governor-bridge.js'
import {
  generateIdempotencyKey,
  isWebhookProcessed,
  storeSessionState,
  getSessionStateByIssue,
  dispatchWork,
  clearAllParkedWork,
  type QueuedWork,
  wasAgentWorked,
  didJustFailQA,
  getQAAttemptCount,
  recordQAAttempt,
  clearQAFailed,
  didJustQueueDevelopment,
  markDevelopmentQueued,
  didJustQueueAcceptance,
  markAcceptanceQueued,
  getWorkflowState,
  getTotalSessionCount,
  MAX_TOTAL_SESSIONS,
  didAcceptanceJustComplete,
  incrementDispatchCount,
} from '@donmai/server'
import type { ResolvedWebhookConfig } from '../../types.js'
import {
  emitActivity,
  resolveStateName,
  isProjectAllowed,
  hasExcludedLabel,
  getAppUrl,
} from '../utils.js'
import type { createLogger } from '@donmai/server'

export async function handleIssueUpdated(
  config: ResolvedWebhookConfig,
  payload: LinearWebhookPayload,
  log: ReturnType<typeof createLogger>
): Promise<NextResponse | null> {
  const { data, updatedFrom, actor } = payload as unknown as {
    data: Record<string, unknown>
    updatedFrom?: Record<string, unknown>
    actor?: Record<string, unknown>
  }

  const issueId = data.id as string
  const issueIdentifier = data.identifier as string
  const currentStateName = (data.state as Record<string, unknown> | undefined)?.name as string | undefined
  const webhookId = (payload as unknown as Record<string, unknown>).webhookId as string

  const issueLog = log.child({ issueId, issueIdentifier })

  // Server-level project filter (applies to all paths)
  const projectName = (data.project as Record<string, unknown> | undefined)?.name as string | undefined

  if (!isProjectAllowed(projectName, config.projects ?? [])) {
    issueLog.debug('Project not handled by this server, skipping', { projectName })
    return NextResponse.json({ success: true, skipped: true, reason: 'project_not_allowed' })
  }

  const autoTrigger = config.autoTrigger

  // --- Governor event bridge (deferred until after auto-trigger processing) ---
  // We capture the event here but don't publish until we know whether an auto-trigger
  // dispatched work. If work was dispatched, the session is already stored in Redis
  // and the governor will see it on its next poll — publishing would cause a duplicate.
  let deferredGovernorEvent: Parameters<typeof publishGovernorEvent>[0] | null = null
  let workDispatched = false
  if (currentStateName && updatedFrom?.stateId) {
    const governorIssue: GovernorIssue = {
      id: issueId,
      identifier: issueIdentifier,
      title: (data.title as string) ?? '',
      description: (data.description as string) ?? undefined,
      status: currentStateName,
      labels: ((data.labels as Array<{ name: string }>) ?? []).map(l => l.name),
      createdAt: data.createdAt ? new Date(data.createdAt as string).getTime() : Date.now(),
      parentId: (data.parent as Record<string, unknown>)?.id as string | undefined,
      project: projectName,
    }

    deferredGovernorEvent = {
      type: 'issue-status-changed',
      issueId,
      issue: governorIssue,
      previousStatus: (updatedFrom.state as Record<string, unknown>)?.name as string | undefined,
      newStatus: currentStateName,
      timestamp: eventTimestamp(),
      source: 'webhook',
    }
  }

  // Clear stale parked work on any status change.
  // This prevents a race where both webhook and governor dispatch the same work type,
  // one gets parked, and then gets promoted after the issue has moved to a new state.
  if (currentStateName && updatedFrom?.stateId) {
    try {
      const cleared = await clearAllParkedWork(issueId)
      if (cleared > 0) {
        issueLog.info('Cleared stale parked work on status change', {
          clearedCount: cleared,
          newStatus: currentStateName,
        })
      }
    } catch (err) {
      issueLog.warn('Failed to clear parked work on status change', { error: err })
    }
  }

  if (config.governorMode === 'governor-only') {
    if (deferredGovernorEvent) {
      await publishGovernorEvent(deferredGovernorEvent)
    }
    issueLog.info('Governor-only mode: skipping direct dispatch', { currentStateName })
    return NextResponse.json({ success: true, governorMode: 'governor-only' })
  }

  // === Handle Finished transition (auto-QA) ===
  if (currentStateName === 'Finished' && updatedFrom?.stateId) {
    issueLog.info('Issue transitioned to Finished', {
      previousStateId: updatedFrom.stateId,
      currentState: currentStateName,
      actorName: actor?.name,
    })

    // Skip QA for sub-issues
    let isChild = !!(data.parent)
    if (!isChild) {
      try {
        const checkClient = await config.linearClient.getClient(payload.organizationId)
        isChild = await checkClient.isChildIssue(issueId)
      } catch (err) {
        issueLog.warn('Failed to check if issue is a child', { error: err })
      }
    }

    if (isChild) {
      issueLog.info('Sub-issue detected, skipping individual QA trigger')
      return NextResponse.json({ success: true, skipped: true, reason: 'sub_issue_skipped' })
    }

    if (!autoTrigger?.enableAutoQA) {
      issueLog.debug('Auto-QA disabled, skipping QA trigger')
      return NextResponse.json({ success: true, skipped: true, reason: 'auto_qa_disabled' })
    }

    if (!isProjectAllowed(projectName, autoTrigger.autoQAProjects)) {
      issueLog.debug('Project not in auto-QA list, skipping', { projectName })
      return NextResponse.json({ success: true, skipped: true, reason: 'project_not_allowed' })
    }

    const labels = data.labels as Array<{ name: string }> | undefined
    if (hasExcludedLabel(labels, autoTrigger.autoQAExcludeLabels)) {
      issueLog.debug('Issue has excluded label, skipping QA trigger')
      return NextResponse.json({ success: true, skipped: true, reason: 'excluded_label' })
    }

    if (autoTrigger.autoQARequireAgentWorked) {
      const workRecord = await wasAgentWorked(issueId)
      if (!workRecord) {
        issueLog.debug('Issue not worked by agent, skipping QA trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'not_agent_worked' })
      }
    }

    const justFailed = await didJustFailQA(issueId)
    if (justFailed) {
      issueLog.info('Issue in QA cooldown period, skipping')
      return NextResponse.json({ success: true, skipped: true, reason: 'qa_cooldown' })
    }

    // Check workflow state for circuit breaker before QA
    try {
      const workflowState = await getWorkflowState(issueId)
      if (workflowState?.strategy === 'escalate-human') {
        issueLog.warn('Circuit breaker: escalate-human strategy, blocking QA', {
          cycleCount: workflowState.cycleCount,
          strategy: workflowState.strategy,
        })
        return NextResponse.json({ success: true, skipped: true, reason: 'circuit_breaker_escalate_human' })
      }
    } catch (err) {
      issueLog.warn('Failed to check workflow state for circuit breaker', { error: err })
    }

    const attemptCount = await getQAAttemptCount(issueId)
    if (attemptCount >= 3) {
      issueLog.warn('QA attempt limit reached', { attemptCount })
      try {
        const linearClient = await config.linearClient.getClient(payload.organizationId)
        await linearClient.createComment(
          issueId,
          `## QA Limit Reached\n\nThis issue has failed automated QA ${attemptCount} times. Manual review is required.\n\nPlease review the previous QA failures and address the underlying issues before requesting another automated QA pass.`
        )
      } catch (err) {
        issueLog.error('Failed to post QA limit comment', { error: err })
      }
      return NextResponse.json({ success: true, skipped: true, reason: 'qa_limit_reached' })
    }

    const totalSessionsQA = await getTotalSessionCount(issueId)
    if (totalSessionsQA >= MAX_TOTAL_SESSIONS) {
      const agentClient = await config.linearClient.getClient(payload.organizationId)
      await agentClient.createComment(issueId, `\u26a0\ufe0f **Session hard cap reached** (${totalSessionsQA}/${MAX_TOTAL_SESSIONS}). No more automated sessions will be created for this issue. Manual intervention required.`)
      return NextResponse.json({ success: true, skipped: true, reason: 'session_hard_cap' })
    }

    const idempotencyKey = generateIdempotencyKey(webhookId, `qa:${issueId}:${Date.now()}`)
    if (await isWebhookProcessed(idempotencyKey)) {
      issueLog.info('Duplicate QA trigger ignored', { idempotencyKey })
      return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_qa_trigger' })
    }

    // Check deployment status before QA
    try {
      const deploymentResult = await checkIssueDeploymentStatus(issueIdentifier)

      if (deploymentResult?.anyFailed) {
        issueLog.info('Deployment failed, blocking QA', {
          commitSha: deploymentResult.commitSha,
        })

        const linearClient = await config.linearClient.getClient(payload.organizationId)
        await linearClient.createComment(
          issueId,
          `## QA Blocked: Deployment Failed\n\n` +
          `Cannot proceed with QA until Vercel deployment succeeds.\n\n` +
          formatFailedDeployments(deploymentResult) +
          `\n\n**PR:** ${deploymentResult.pr.url}\n` +
          `**Commit:** \`${deploymentResult.commitSha.slice(0, 7)}\`\n\n` +
          `Please fix the deployment issues and move the issue back to Finished to retry QA.`
        )

        return NextResponse.json({ success: true, skipped: true, reason: 'deployment_failed' })
      }
    } catch (err) {
      issueLog.warn('Deployment check failed, proceeding with QA', { error: err })
    }

    await clearQAFailed(issueId)

    const linearClient = await config.linearClient.getClient(payload.organizationId)

    // QA work type — same for parent and leaf issues (coordinator behavior is runtime-decided)
    const qaWorkType: AgentWorkType = 'qa'
    let qaPrompt = `QA ${issueIdentifier}`
    try {
      qaPrompt = config.generatePrompt(issueIdentifier, 'qa')
    } catch (err) {
      issueLog.warn('Failed to generate QA prompt', { error: err })
    }

    // Enrich QA prompt with previous failure context
    if (attemptCount > 0) {
      try {
        const workflowState = await getWorkflowState(issueId)
        if (workflowState && workflowState.failureSummary) {
          const wfContext: WorkflowContext = {
            cycleCount: workflowState.cycleCount,
            strategy: workflowState.strategy,
            failureSummary: workflowState.failureSummary,
            qaAttemptCount: attemptCount,
          }
          const contextBlock = buildFailureContextBlock(qaWorkType, wfContext)
          if (contextBlock) {
            qaPrompt += contextBlock
            issueLog.info('QA prompt enriched with failure context', {
              cycleCount: workflowState.cycleCount,
              attemptCount,
            })
          }
        }
      } catch (err) {
        issueLog.warn('Failed to enrich QA prompt with failure context', { error: err })
      }
    }

    // Create Linear AgentSession for QA
    let qaSessionId: string
    try {
      const appUrl = getAppUrl(config)
      const sessionResult = await linearClient.createAgentSessionOnIssue({
        issueId,
        externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/pending` }],
      })

      if (!sessionResult.success || !sessionResult.sessionId) {
        issueLog.error('Failed to create Linear AgentSession for QA', { sessionResult })
        return NextResponse.json({ success: false, error: 'Failed to create agent session for QA' })
      }

      qaSessionId = sessionResult.sessionId
      issueLog.info('Linear AgentSession created for QA', { sessionId: qaSessionId })
    } catch (err) {
      issueLog.error('Error creating Linear AgentSession for QA', { error: err })
      return NextResponse.json({ success: false, error: 'Error creating agent session for QA' })
    }

    // Store session state IMMEDIATELY after creation so that the session-created
    // webhook handler finds it and skips (prevents duplicate dispatch).
    await storeSessionState(qaSessionId, {
      issueId,
      issueIdentifier,
      providerSessionId: null,
      worktreePath: '',
      status: 'pending',
      queuedAt: Date.now(),
      promptContext: qaPrompt,
      priority: 2,
      organizationId: payload.organizationId,
      workType: qaWorkType,
      projectName,
    })

    await recordQAAttempt(issueId, qaSessionId)

    const qaWork: QueuedWork = {
      sessionId: qaSessionId,
      issueId,
      issueIdentifier,
      priority: 2,
      queuedAt: Date.now(),
      prompt: qaPrompt,
      workType: qaWorkType,
      projectName,
    }

    const qaResult = await dispatchWork(qaWork)

    if (qaResult.dispatched || qaResult.parked) {
      workDispatched = true
      try { await incrementDispatchCount(issueId) } catch {}
      issueLog.info('QA work dispatched', {
        sessionId: qaSessionId,
        attemptNumber: attemptCount + 1,
      })

      try {
        const appUrl = getAppUrl(config)
        await linearClient.updateAgentSession({
          sessionId: qaSessionId,
          externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/${qaSessionId}` }],
        })
      } catch (err) {
        issueLog.warn('Failed to update QA session externalUrl', { error: err })
      }

      try {
        await emitActivity(linearClient, qaSessionId, 'thought', `QA work queued (attempt #${attemptCount + 1}). Waiting for an available worker...`)
      } catch (err) {
        issueLog.warn('Failed to emit QA queued activity', { error: err })
      }

      try {
        await linearClient.createComment(
          issueId,
          `## Automated QA Started\n\nQA attempt #${attemptCount + 1} has been queued.\n\nThe QA agent will:\n1. Checkout the PR branch\n2. Run tests and validation\n3. Verify implementation against requirements\n4. Promote to Delivered (pass) or return to Backlog (fail)`
        )
      } catch (err) {
        issueLog.error('Failed to post QA start comment', { error: err })
      }
    } else {
      issueLog.error('Failed to queue QA work')
    }
  }

  // === Handle → Rejected transition (escalation ladder) ===
  // When QA/acceptance fails, the orchestrator transitions the issue to Rejected.
  // Check the escalation strategy and act accordingly.
  if (currentStateName === 'Rejected' && updatedFrom?.stateId) {
    try {
      const workflowState = await getWorkflowState(issueId)
      if (workflowState) {
        const { strategy, cycleCount, failureSummary } = workflowState

        if (strategy === 'escalate-human') {
          issueLog.warn('Escalation ladder: escalate-human — creating blocker and stopping loop', {
            cycleCount,
            strategy,
          })

          const linearClient = await config.linearClient.getClient(payload.organizationId)

          // Post escalation summary comment
          const totalCostLine = workflowState.phases
            ? (() => {
                const allPhases = [
                  ...workflowState.phases.development,
                  ...workflowState.phases.qa,
                  ...workflowState.phases.refinement,
                  ...workflowState.phases.acceptance,
                ]
                const totalCost = allPhases.reduce((sum, p) => sum + (p.costUsd ?? 0), 0)
                return totalCost > 0 ? `\n**Total cost across all attempts:** $${totalCost.toFixed(2)}` : ''
              })()
            : ''

          try {
            await linearClient.createComment(
              issueId,
              `## Circuit Breaker: Human Intervention Required\n\n` +
              `This issue has gone through **${cycleCount} dev-QA-rejected cycles** without passing.\n` +
              `The automated system is stopping further attempts.\n` +
              totalCostLine +
              `\n\n### Failure History\n\n${failureSummary ?? 'No failure details recorded.'}\n\n` +
              `### Recommended Actions\n` +
              `1. Review the failure patterns above\n` +
              `2. Consider if the acceptance criteria need clarification\n` +
              `3. Investigate whether there's an architectural issue\n` +
              `4. Manually fix or decompose the issue before re-enabling automation`
            )
          } catch (err) {
            issueLog.error('Failed to post escalation comment', { error: err })
          }

          // Create a blocker issue in Icebox with 'Needs Human' label
          try {
            const issue = await linearClient.getIssue(issueId)
            const team = await issue.team
            if (team) {
              const statuses = await linearClient.getTeamStatuses(team.id)
              const iceboxStateId = statuses['Icebox']

              // Find 'Needs Human' label
              const allLabels = await linearClient.linearClient.issueLabels()
              const needsHumanLabel = allLabels.nodes.find(
                (l) => l.name.toLowerCase() === 'needs human'
              )

              const blockerTitle = `Human review needed: ${issueIdentifier} failed ${cycleCount} automated cycles`
              const blockerDescription = [
                `This issue has failed **${cycleCount} automated dev-QA-rejected cycles** and requires human intervention.`,
                '',
                '### Failure History',
                failureSummary ?? 'No failure details recorded.',
                '',
                '---',
                `*Source issue: ${issueIdentifier}*`,
              ].join('\n')

              const createPayload: Parameters<typeof linearClient.createIssue>[0] = {
                title: blockerTitle,
                description: blockerDescription,
                teamId: team.id,
                ...(iceboxStateId && { stateId: iceboxStateId }),
                ...(needsHumanLabel && { labelIds: [needsHumanLabel.id] }),
              }

              // Add project if available
              const project = await issue.project
              if (project) {
                createPayload.projectId = project.id
              }

              const blockerIssue = await linearClient.createIssue(createPayload)

              // Create blocking relation: blocker blocks source issue
              await linearClient.createIssueRelation({
                issueId: blockerIssue.id,
                relatedIssueId: issueId,
                type: 'blocks',
              })

              issueLog.info('Escalation ladder: blocker issue created', {
                issueId,
                blockerIssueId: blockerIssue.id,
                blockerIdentifier: blockerIssue.identifier,
                cycleCount,
              })
            } else {
              issueLog.warn('Escalation ladder: could not resolve team for blocker creation', { issueId })
            }
          } catch (err) {
            issueLog.error('Failed to create blocker issue for escalation', { error: err })
          }

        } else if (strategy === 'decompose') {
          issueLog.info('Escalation ladder: decompose strategy — refinement will attempt decomposition', {
            cycleCount,
            strategy,
          })
          // The decomposition strategy will be handled via prompt enrichment (SUP-713)
          // by injecting decomposition instructions into the refinement prompt
        }
      }
    } catch (err) {
      issueLog.warn('Failed to check workflow state for escalation ladder', { error: err })
    }
  }

  // === Handle → Backlog transition (auto-development) ===
  // Triggers from: Icebox → Backlog (new issues), Rejected → Backlog (post-refinement retries), etc.
  if (currentStateName === 'Backlog' && updatedFrom?.stateId) {
    const previousStateName = await resolveStateName(
      config,
      payload.organizationId,
      issueId,
      updatedFrom.stateId as string
    )

    // Skip transitions from states that don't indicate readiness for development
    // (e.g., Backlog → Backlog is a no-op, Started → Backlog means work was abandoned)
    // Finished → Backlog is a QA failure (QA fail status is now Backlog instead of Rejected)
    const allowedPreviousStates = ['Icebox', 'Rejected', 'Canceled', 'Finished']
    if (!allowedPreviousStates.includes(previousStateName ?? '')) {
      issueLog.debug('Issue transitioned to Backlog from non-triggering state', { previousStateName })
    } else {
      const isRetry = previousStateName === 'Rejected' || previousStateName === 'Finished'

      issueLog.info('Issue transitioned to Backlog', {
        previousStateName,
        isRetry,
        actorName: actor?.name,
      })

      // Skip development for sub-issues — coordinator manages sub-issue lifecycle via parent
      let isChildForDev = !!(data.parent)
      if (!isChildForDev) {
        try {
          const checkClient = await config.linearClient.getClient(payload.organizationId)
          isChildForDev = await checkClient.isChildIssue(issueId)
        } catch (err) {
          issueLog.warn('Failed to check if issue is a child', { error: err })
        }
      }

      if (isChildForDev) {
        issueLog.info('Sub-issue detected, skipping individual development trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'sub_issue_skipped' })
      }

      // Circuit breaker: check workflow state for escalate-human strategy
      if (isRetry) {
        try {
          const workflowState = await getWorkflowState(issueId)
          if (workflowState && workflowState.strategy === 'escalate-human') {
            issueLog.warn('Circuit breaker: issue at escalate-human strategy, skipping auto-development', {
              cycleCount: workflowState.cycleCount,
              strategy: workflowState.strategy,
            })
            return NextResponse.json({ success: true, skipped: true, reason: 'circuit_breaker_escalate_human' })
          }
          if (workflowState) {
            issueLog.info('Workflow state found for retry', {
              cycleCount: workflowState.cycleCount,
              strategy: workflowState.strategy,
            })
          }
        } catch (err) {
          issueLog.warn('Failed to check workflow state for circuit breaker', { error: err })
        }
      }

      const totalSessionsDev = await getTotalSessionCount(issueId)
      if (totalSessionsDev >= MAX_TOTAL_SESSIONS) {
        const agentClient = await config.linearClient.getClient(payload.organizationId)
        await agentClient.createComment(issueId, `\u26a0\ufe0f **Session hard cap reached** (${totalSessionsDev}/${MAX_TOTAL_SESSIONS}). No more automated sessions will be created for this issue. Manual intervention required.`)
        return NextResponse.json({ success: true, skipped: true, reason: 'session_hard_cap' })
      }

      const existingSession = await getSessionStateByIssue(issueId)
      if (existingSession && ['running', 'claimed', 'pending'].includes(existingSession.status)) {
        issueLog.info('Session already active, skipping development trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'session_already_active' })
      }

      if (await didJustQueueDevelopment(issueId)) {
        issueLog.info('Issue in development cooldown period, skipping')
        return NextResponse.json({ success: true, skipped: true, reason: 'development_cooldown' })
      }

      const idempotencyKey = generateIdempotencyKey(webhookId, `dev:${issueId}:${Date.now()}`)
      if (await isWebhookProcessed(idempotencyKey)) {
        issueLog.info('Duplicate development trigger ignored', { idempotencyKey })
        return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_dev_trigger' })
      }

      const linearClient = await config.linearClient.getClient(payload.organizationId)

      await markDevelopmentQueued(issueId)

      // Parent and leaf issues use the same work type — coordinator behavior is runtime-decided
      const workType: AgentWorkType = 'development'

      let prompt = config.generatePrompt(issueIdentifier, workType)

      // Enrich prompt with failure context for retries
      if (isRetry) {
        try {
          const workflowState = await getWorkflowState(issueId)
          if (workflowState && workflowState.cycleCount > 0) {
            const wfContext: WorkflowContext = {
              cycleCount: workflowState.cycleCount,
              strategy: workflowState.strategy,
              failureSummary: workflowState.failureSummary,
            }
            const contextBlock = buildFailureContextBlock(workType, wfContext)
            if (contextBlock) {
              prompt += contextBlock
              issueLog.info('Development prompt enriched with failure context', {
                cycleCount: workflowState.cycleCount,
                strategy: workflowState.strategy,
              })
            }
          }
        } catch (err) {
          issueLog.warn('Failed to enrich development prompt with failure context', { error: err })
        }
      }

      let devSessionId: string
      try {
        const appUrl = getAppUrl(config)
        const sessionResult = await linearClient.createAgentSessionOnIssue({
          issueId,
          externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/pending` }],
        })

        if (!sessionResult.success || !sessionResult.sessionId) {
          issueLog.error('Failed to create Linear AgentSession', { sessionResult })
          return NextResponse.json({ success: false, error: 'Failed to create agent session' })
        }

        devSessionId = sessionResult.sessionId
        issueLog.info('Linear AgentSession created', { sessionId: devSessionId })
      } catch (err) {
        issueLog.error('Error creating Linear AgentSession', { error: err })
        return NextResponse.json({ success: false, error: 'Error creating agent session' })
      }

      // Store session state IMMEDIATELY after creation so that the session-created
      // webhook handler finds it and skips (prevents duplicate dispatch).
      await storeSessionState(devSessionId, {
        issueId,
        issueIdentifier,
        providerSessionId: null,
        worktreePath: '',
        status: 'pending',
        queuedAt: Date.now(),
        promptContext: prompt,
        priority: 3,
        organizationId: payload.organizationId,
        workType,
        projectName,
      })

      const devWork: QueuedWork = {
        sessionId: devSessionId,
        issueId,
        issueIdentifier,
        priority: 3,
        queuedAt: Date.now(),
        prompt,
        workType,
        projectName,
      }

      const devResult = await dispatchWork(devWork)

      if (devResult.dispatched || devResult.parked) {
        workDispatched = true
        try { await incrementDispatchCount(issueId) } catch {}
        const retryLabel = isRetry ? ' (retry)' : ''
        issueLog.info(`Development work dispatched${retryLabel}`, { sessionId: devSessionId })

        try {
          const appUrl = getAppUrl(config)
          await linearClient.updateAgentSession({
            sessionId: devSessionId,
            externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/${devSessionId}` }],
          })
        } catch (err) {
          issueLog.warn('Failed to update session externalUrl', { error: err })
        }

        try {
          const activityMsg = isRetry
            ? 'Development work queued (retry after refinement). Waiting for an available worker...'
            : 'Development work queued. Waiting for an available worker...'
          await emitActivity(linearClient, devSessionId, 'thought', activityMsg)
        } catch (err) {
          issueLog.warn('Failed to emit queued activity', { error: err })
        }
      } else {
        issueLog.error('Failed to queue development work')
      }
    }
  }

  // === Handle Finished → Delivered transition (auto-acceptance) ===
  if (currentStateName === 'Delivered' && updatedFrom?.stateId) {
    const previousStateName = await resolveStateName(
      config,
      payload.organizationId,
      issueId,
      updatedFrom.stateId as string
    )

    if (previousStateName !== 'Finished') {
      issueLog.debug('Issue transitioned to Delivered but not from Finished', { previousStateName })
    } else {
      issueLog.info('Issue transitioned from Finished to Delivered', {
        previousStateName,
        actorName: actor?.name,
      })

      // Skip acceptance for sub-issues
      let isChildForAcceptance = !!(data.parent)
      if (!isChildForAcceptance) {
        try {
          const checkClient = await config.linearClient.getClient(payload.organizationId)
          isChildForAcceptance = await checkClient.isChildIssue(issueId)
        } catch (err) {
          issueLog.warn('Failed to check if issue is a child', { error: err })
        }
      }

      if (isChildForAcceptance) {
        issueLog.info('Sub-issue detected, skipping individual acceptance trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'sub_issue_skipped' })
      }

      if (!autoTrigger?.enableAutoAcceptance) {
        issueLog.debug('Auto-acceptance disabled, skipping acceptance trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'auto_acceptance_disabled' })
      }

      if (!isProjectAllowed(projectName, autoTrigger.autoAcceptanceProjects)) {
        issueLog.debug('Project not in auto-acceptance list, skipping', { projectName })
        return NextResponse.json({ success: true, skipped: true, reason: 'project_not_allowed' })
      }

      const labels = data.labels as Array<{ name: string }> | undefined
      if (hasExcludedLabel(labels, autoTrigger.autoAcceptanceExcludeLabels)) {
        issueLog.debug('Issue has excluded label, skipping acceptance trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'excluded_label' })
      }

      if (autoTrigger.autoAcceptanceRequireAgentWorked) {
        const workRecord = await wasAgentWorked(issueId)
        if (!workRecord) {
          issueLog.debug('Issue not worked by agent, skipping acceptance trigger')
          return NextResponse.json({ success: true, skipped: true, reason: 'not_agent_worked' })
        }
      }

      if (await didJustQueueAcceptance(issueId)) {
        issueLog.info('Issue in acceptance cooldown period, skipping')
        return NextResponse.json({ success: true, skipped: true, reason: 'acceptance_cooldown' })
      }

      if (await didAcceptanceJustComplete(issueId)) {
        return NextResponse.json({ success: true, skipped: true, reason: 'acceptance_recently_completed' })
      }

      const totalSessionsAcc = await getTotalSessionCount(issueId)
      if (totalSessionsAcc >= MAX_TOTAL_SESSIONS) {
        const agentClient = await config.linearClient.getClient(payload.organizationId)
        await agentClient.createComment(issueId, `\u26a0\ufe0f **Session hard cap reached** (${totalSessionsAcc}/${MAX_TOTAL_SESSIONS}). No more automated sessions will be created for this issue. Manual intervention required.`)
        return NextResponse.json({ success: true, skipped: true, reason: 'session_hard_cap' })
      }

      const idempotencyKey = generateIdempotencyKey(webhookId, `acceptance:${issueId}:${Date.now()}`)
      if (await isWebhookProcessed(idempotencyKey)) {
        issueLog.info('Duplicate acceptance trigger ignored', { idempotencyKey })
        return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_acceptance_trigger' })
      }

      // Check deployment status
      try {
        const deploymentResult = await checkIssueDeploymentStatus(issueIdentifier)

        if (deploymentResult?.anyFailed) {
          issueLog.info('Deployment failed, blocking acceptance')

          const linearClient = await config.linearClient.getClient(payload.organizationId)
          await linearClient.createComment(
            issueId,
            `## Acceptance Blocked: Deployment Failed\n\n` +
            `Cannot proceed with acceptance testing until Vercel deployment succeeds.\n\n` +
            formatFailedDeployments(deploymentResult) +
            `\n\n**PR:** ${deploymentResult.pr.url}\n` +
            `**Commit:** \`${deploymentResult.commitSha.slice(0, 7)}\`\n\n` +
            `Please fix the deployment issues. The issue will remain in Delivered status.`
          )

          return NextResponse.json({ success: true, skipped: true, reason: 'deployment_failed' })
        }
      } catch (err) {
        issueLog.warn('Deployment check failed, proceeding with acceptance', { error: err })
      }

      await markAcceptanceQueued(issueId)

      const linearClient = await config.linearClient.getClient(payload.organizationId)

      // Detect parent → acceptance-coordination (only if sub-issues were actually worked)
      // Acceptance work type — same for parent and leaf issues (coordinator behavior is runtime-decided)
      const acceptanceWorkType: AgentWorkType = 'acceptance'
      const acceptancePrompt = config.generatePrompt(issueIdentifier, 'acceptance')

      // Create Linear AgentSession for acceptance
      let acceptanceSessionId: string
      try {
        const appUrl = getAppUrl(config)
        const sessionResult = await linearClient.createAgentSessionOnIssue({
          issueId,
          externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/pending` }],
        })

        if (!sessionResult.success || !sessionResult.sessionId) {
          issueLog.error('Failed to create Linear AgentSession for acceptance', { sessionResult })
          return NextResponse.json({ success: false, error: 'Failed to create agent session for acceptance' })
        }

        acceptanceSessionId = sessionResult.sessionId
        issueLog.info('Linear AgentSession created for acceptance', { sessionId: acceptanceSessionId })
      } catch (err) {
        issueLog.error('Error creating Linear AgentSession for acceptance', { error: err })
        return NextResponse.json({ success: false, error: 'Error creating agent session for acceptance' })
      }

      await storeSessionState(acceptanceSessionId, {
        issueId,
        issueIdentifier,
        providerSessionId: null,
        worktreePath: '',
        status: 'pending',
        queuedAt: Date.now(),
        promptContext: acceptancePrompt,
        priority: 2,
        organizationId: payload.organizationId,
        workType: acceptanceWorkType,
        projectName,
      })

      const acceptanceWork: QueuedWork = {
        sessionId: acceptanceSessionId,
        issueId,
        issueIdentifier,
        priority: 2,
        queuedAt: Date.now(),
        prompt: acceptancePrompt,
        workType: acceptanceWorkType,
        projectName,
      }

      const accResult = await dispatchWork(acceptanceWork)

      if (accResult.dispatched || accResult.parked) {
        workDispatched = true
        try { await incrementDispatchCount(issueId) } catch {}
        issueLog.info('Acceptance work dispatched', { sessionId: acceptanceSessionId })

        try {
          const appUrl = getAppUrl(config)
          await linearClient.updateAgentSession({
            sessionId: acceptanceSessionId,
            externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/${acceptanceSessionId}` }],
          })
        } catch (err) {
          issueLog.warn('Failed to update acceptance session externalUrl', { error: err })
        }

        try {
          await emitActivity(linearClient, acceptanceSessionId, 'thought', 'Acceptance work queued. Waiting for an available worker...')
        } catch (err) {
          issueLog.warn('Failed to emit acceptance queued activity', { error: err })
        }

        try {
          await linearClient.createComment(
            issueId,
            `## Acceptance Processing Started\n\nQA passed. Validating work completion and preparing to merge PR...\n\nThe acceptance handler will:\n1. Verify the preview deployment is working\n2. Check PR is ready to merge (CI passing, no conflicts)\n3. Merge the PR\n4. Clean up local resources\n5. Move issue to Accepted on success`
          )
        } catch (err) {
          issueLog.error('Failed to post acceptance start comment', { error: err })
        }
      } else {
        issueLog.error('Failed to queue acceptance work')
      }
    }
  }

  // Publish deferred governor event only if no auto-trigger dispatched work.
  // When work is dispatched, the session is already stored in Redis, so the
  // governor will see it and skip — no need to also send an event.
  if (deferredGovernorEvent && !workDispatched) {
    await publishGovernorEvent(deferredGovernorEvent)
  }

  return null // Continue processing
}
