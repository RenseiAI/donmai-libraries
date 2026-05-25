/**
 * Webhook Utility Functions
 *
 * Shared helpers used by webhook sub-handlers.
 */

import type { AgentWorkType } from '@donmai/core'
import type { LinearAgentClient } from '@donmai/plugin-linear'
import { STATUS_WORK_TYPE_MAP } from '@donmai/plugin-linear'
import {
  getSessionState,
  updateSessionStatus,
  removeFromQueue,
  removeParkedWorkBySessionId,
  releaseClaim,
  getIssueLock,
  releaseIssueLock,
  promoteNextPendingWork,
  createLogger,
} from '@donmai/server'
import type { ResolvedWebhookConfig } from '../types.js'

const baseLogger = createLogger('webhook')

/**
 * Activity types for Linear Agent API
 */
type ActivityType = 'thought' | 'response' | 'error'

/**
 * Emit an activity to the agent session.
 * Uses Linear's native Agent API.
 */
export async function emitActivity(
  client: LinearAgentClient,
  sessionId: string,
  type: ActivityType,
  body: string,
  ephemeral?: boolean
): Promise<void> {
  const isEphemeral = ephemeral ?? type === 'thought'

  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type, body },
    ephemeral: isEphemeral,
  })
}

/**
 * Consolidated stop signal handler.
 *
 * Handles stops for sessions in any non-terminal state:
 * - running/claimed: Worker will detect the status change and stop the agent
 * - pending: Removes from global work queue and/or issue-pending queue
 * - Any other non-terminal state: Updates status and cleans up
 */
export async function handleStopSignal(
  config: ResolvedWebhookConfig,
  sessionId: string,
  issueId: string,
  organizationId?: string
): Promise<void> {
  const stopLog = baseLogger.child({ sessionId, issueId, handler: 'handleStopSignal' })

  const session = await getSessionState(sessionId)

  if (session && ['completed', 'failed', 'stopped'].includes(session.status)) {
    stopLog.info('Session already in terminal state, skipping stop', {
      status: session.status,
    })
    return
  }

  if (session) {
    stopLog.info('Stopping session', {
      previousStatus: session.status,
      workerId: session.workerId,
    })
    await updateSessionStatus(sessionId, 'stopped')
  } else {
    stopLog.info('No session state found, cleaning up queues only')
  }

  await removeFromQueue(sessionId)
  await removeParkedWorkBySessionId(issueId, sessionId)
  await releaseClaim(sessionId)

  const lock = await getIssueLock(issueId)
  if (lock && lock.sessionId === sessionId) {
    await releaseIssueLock(issueId)
    await promoteNextPendingWork(issueId)
    stopLog.info('Released issue lock and promoted next pending work')
  }

  try {
    const linearClient = await config.linearClient.getClient(organizationId)

    const statusMsg = session?.status === 'pending'
      ? 'Stop signal received. Queued work has been cancelled.'
      : 'Stop signal received. Agent will stop shortly.'

    await emitActivity(linearClient, sessionId, 'response', statusMsg)
  } catch (err) {
    stopLog.error('Failed to emit stop activity', { error: err })
  }
}

/**
 * Resolve a state ID to its name using the Linear API.
 */
export async function resolveStateName(
  config: ResolvedWebhookConfig,
  organizationId: string | undefined,
  issueId: string,
  stateId: string
): Promise<string | undefined> {
  try {
    const linearClient = await config.linearClient.getClient(organizationId)

    const issue = await linearClient.getIssue(issueId)
    const team = await issue.team
    if (team) {
      const statuses = await linearClient.getTeamStatuses(team.id)
      const entry = Object.entries(statuses).find(([, id]) => id === stateId)
      return entry?.[0]
    }
    return undefined
  } catch (err) {
    baseLogger.warn('Failed to resolve state name', { issueId, stateId, error: err })
    return undefined
  }
}

/**
 * Check if a project is allowed for auto-trigger.
 */
export function isProjectAllowed(projectName: string | undefined, allowedProjects: string[]): boolean {
  if (allowedProjects.length === 0) return true
  if (!projectName) return false
  return allowedProjects.includes(projectName)
}

/**
 * Check if an issue has any excluded labels.
 */
export function hasExcludedLabel(labels: Array<{ name: string }> | undefined, excludedLabels: string[]): boolean {
  if (excludedLabels.length === 0) return false
  if (!labels || labels.length === 0) return false
  return labels.some(label => excludedLabels.includes(label.name))
}

/**
 * Determine work type from issue status.
 */
export function determineWorkType(status: string | undefined): AgentWorkType {
  if (!status) return 'development'
  return STATUS_WORK_TYPE_MAP[status] ?? 'development'
}

/**
 * Default priority for work types (lower = higher priority).
 */
export function defaultGetPriority(workType: AgentWorkType): number {
  switch (workType) {
    case 'qa': return 2
    case 'acceptance': return 2
    case 'refinement': return 2
    case 'refinement-coordination': return 2
    case 'inflight': return 2
    case 'backlog-creation': return 3
    case 'development': return 3
    case 'research': return 4
    default: return 3
  }
}

/**
 * Get the app URL for constructing dashboard links.
 */
export function getAppUrl(config: ResolvedWebhookConfig): string {
  return config.appUrl
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    ?? (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`)
    ?? 'https://agent.rensei.dev'
}

/**
 * Get the priority for a work type, using config override if available.
 */
export function getPriority(config: ResolvedWebhookConfig, workType: AgentWorkType): number {
  return config.getPriority?.(workType) ?? defaultGetPriority(workType)
}

/**
 * Work type messages for queuing acknowledgment.
 */
export const WORK_TYPE_MESSAGES: Record<AgentWorkType, string> = {
  research: 'Research work queued. Agent will analyze and flesh out story requirements...',
  'backlog-creation': 'Backlog creation queued. Agent will break down the story into separate issues...',
  'backlog-groomer': 'Backlog grooming queued. Agent will triage one icebox issue (discard/refine/escalate)...',
  development: 'Development work queued. Agent will implement the feature/fix, coordinating sub-agents when needed...',
  inflight: 'Resuming in-flight work. Agent will continue where it left off, coordinating sub-agents when needed...',
  qa: 'QA work queued. Agent will validate the implementation, coordinating sub-agents when needed...',
  acceptance: 'Acceptance testing queued. Agent will verify and merge, coordinating sub-agents when needed...',
  refinement: 'Refinement work queued. Agent will address rejection feedback...',
  'refinement-coordination': 'Refinement coordination queued. Agent will triage QA/acceptance failures to sub-issues...',
  merge: 'Merge work queued. Agent will handle PR merge queue operations...',
  security: 'Security scan queued. Agent will run SAST and dependency audit...',
  'outcome-auditor': 'Outcome audit queued. Agent will verify accepted issues delivered their stated intent and author follow-up issues for gaps...',
  'improvement-loop': 'Improvement Loop queued. Agent will analyze recent sessions and author meta-issues for systemic patterns...',
  'ga-readiness': 'GA-readiness assessment queued. Agent will evaluate feature readiness for production: AC coverage, architectural drift, observability, and security review status...',
  'documentation-steward': 'Documentation steward queued. Agent will scan docs for stale references and undocumented surfaces, author refinement issues for gaps...',
  'operational-scanner-vercel': 'Vercel operational scan queued. Agent will scan deploy logs for failures, timeouts, and cold-start regressions, then author bug-report issues (live binding pending REN-1311)...',
  'operational-scanner-audit': 'Audit chain scan queued. Agent will scan audit chains for anomalies per 006 Seam 6 (broken chains, unexpected actors) and author bug-report issues...',
  'operational-scanner-ci': 'CI operational scan queued. Agent will scan CI runs for flaky tests, slow steps, and optimization opportunities, then author bug-report and chore issues...',
}
