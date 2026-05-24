/**
 * LinearPlatformAdapter
 *
 * Extends LinearFrontendAdapter with Governor event integration methods.
 * Structurally satisfies the PlatformAdapter interface from @donmai/core
 * without an explicit `implements` clause, avoiding a circular package dependency
 * (core depends on linear, so linear cannot import core).
 *
 * Responsibilities:
 * - Normalize Linear webhook payloads into GovernorEvents
 * - Scan Linear projects for non-terminal issues
 * - Convert Linear SDK Issue objects to GovernorIssue
 */

import type { Issue } from '@linear/sdk'
import { LinearFrontendAdapter } from './frontend-adapter.js'
import { resolveSDKLabelNames } from './utils.js'
import type { LinearAgentClient } from './agent-client.js'
import type {
  WebhookIssue,
  WebhookIssueState,
  WebhookUser,
} from './webhook-types.js'

// ---------------------------------------------------------------------------
// Governor types (structurally identical to @donmai/core governor types)
// Defined locally to avoid circular dependency: core -> linear -> core
// ---------------------------------------------------------------------------

/**
 * Minimal issue representation used by the Governor.
 * Structurally identical to GovernorIssue in @donmai/core.
 */
export interface GovernorIssue {
  id: string
  identifier: string
  title: string
  description?: string
  status: string
  labels: string[]
  createdAt: number
  parentId?: string
  project?: string
}

/** Where an event originated. */
type EventSource = 'webhook' | 'poll' | 'manual'

/**
 * Fired when an issue's workflow status changes.
 * Structurally identical to IssueStatusChangedEvent in @donmai/core.
 */
interface IssueStatusChangedEvent {
  type: 'issue-status-changed'
  issueId: string
  issue: GovernorIssue
  previousStatus?: string
  newStatus: string
  timestamp: string
  source: EventSource
}

/**
 * Fired when a comment is added to an issue.
 * Structurally identical to CommentAddedEvent in @donmai/core.
 */
interface CommentAddedEvent {
  type: 'comment-added'
  issueId: string
  issue: GovernorIssue
  commentId: string
  commentBody: string
  userId?: string
  userName?: string
  timestamp: string
  source: EventSource
}

/** Union of events this adapter can produce. */
type GovernorEvent = IssueStatusChangedEvent | CommentAddedEvent

// ---------------------------------------------------------------------------
// Linear webhook payload shapes (internal to this module)
// ---------------------------------------------------------------------------

/** Linear issue webhook payload with state change. */
interface LinearIssueWebhookPayload {
  action: string
  type: 'Issue'
  data: WebhookIssue & {
    state: WebhookIssueState
    createdAt?: string
    [key: string]: unknown
  }
  updatedFrom?: {
    stateId?: string
    [key: string]: unknown
  }
  createdAt?: string
}

/** Linear comment webhook payload. */
interface LinearCommentWebhookPayload {
  action: string
  type: 'Comment'
  data: {
    id: string
    body: string
    issue: WebhookIssue & {
      state?: WebhookIssueState
      createdAt?: string
      [key: string]: unknown
    }
    user?: WebhookUser
    [key: string]: unknown
  }
  createdAt?: string
}

// ---------------------------------------------------------------------------
// Terminal statuses
// ---------------------------------------------------------------------------

/**
 * Statuses that represent terminal states in Linear.
 * Issues in these states are excluded from project scans.
 */
const TERMINAL_STATUSES = ['Accepted', 'Canceled', 'Duplicate'] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate an ISO-8601 timestamp for the current moment.
 * Equivalent to `eventTimestamp()` from @donmai/core.
 */
function eventTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Build a GovernorIssue from Linear webhook issue data.
 * Does not make API calls -- uses only the data present in the webhook payload.
 */
function webhookIssueToGovernorIssue(
  issueData: WebhookIssue & {
    state?: WebhookIssueState
    createdAt?: string
    [key: string]: unknown
  }
): GovernorIssue {
  return {
    id: issueData.id,
    identifier: issueData.identifier,
    title: issueData.title,
    description: issueData.description ?? undefined,
    status: issueData.state?.name ?? 'Backlog',
    labels: issueData.labels?.map((l) => l.name) ?? [],
    createdAt: issueData.createdAt
      ? new Date(issueData.createdAt).getTime()
      : Date.now(),
    parentId: issueData.parent?.id,
    project: issueData.project?.name,
  }
}

/**
 * Convert a Linear SDK Issue object to a GovernorIssue.
 * Resolves lazy-loaded relations (state, labels, parent, project).
 */
async function sdkIssueToGovernorIssue(issue: Issue): Promise<GovernorIssue> {
  const state = await issue.state
  const labels = await issue.labels()
  const parent = await issue.parent
  const project = await issue.project

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    status: state?.name ?? 'Backlog',
    labels: await resolveSDKLabelNames(labels.nodes),
    createdAt: issue.createdAt.getTime(),
    parentId: parent?.id,
    project: project?.name,
  }
}

// ---------------------------------------------------------------------------
// Type guards for webhook payloads
// ---------------------------------------------------------------------------

/**
 * Check if a payload looks like a Linear issue webhook.
 */
function isIssuePayload(payload: unknown): payload is LinearIssueWebhookPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return (
    p.type === 'Issue' &&
    typeof p.action === 'string' &&
    typeof p.data === 'object' &&
    p.data !== null
  )
}

/**
 * Check if a payload looks like a Linear comment webhook.
 */
function isCommentPayload(payload: unknown): payload is LinearCommentWebhookPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return (
    p.type === 'Comment' &&
    typeof p.action === 'string' &&
    typeof p.data === 'object' &&
    p.data !== null
  )
}

// ---------------------------------------------------------------------------
// LinearPlatformAdapter
// ---------------------------------------------------------------------------

/**
 * Linear platform adapter for the EventDrivenGovernor.
 *
 * Extends LinearFrontendAdapter to inherit all frontend operations
 * (status mapping, issue read/write, agent sessions) and adds
 * Governor-specific methods for webhook normalization, project scanning,
 * and issue conversion.
 *
 * Structurally satisfies PlatformAdapter from @donmai/core.
 */
export class LinearPlatformAdapter extends LinearFrontendAdapter {
  /**
   * The underlying Linear client, exposed to subclass methods.
   * Re-declared here because the parent's `client` field is private.
   */
  private readonly linearAgentClient: LinearAgentClient

  constructor(client: LinearAgentClient) {
    super(client)
    this.linearAgentClient = client
  }

  // ---- PlatformAdapter methods ----

  /**
   * Normalize a raw Linear webhook payload into GovernorEvents.
   *
   * Handles two payload types:
   * - Issue updates with state changes -> IssueStatusChangedEvent
   * - Comment creations -> CommentAddedEvent
   *
   * Returns `null` for unrecognized payloads (e.g., label changes,
   * AgentSession events, or other resource types).
   *
   * @param payload - Raw Linear webhook payload
   * @returns Array of GovernorEvents, or null if not relevant
   */
  normalizeWebhookEvent(payload: unknown): GovernorEvent[] | null {
    // Handle Issue update with state change
    if (isIssuePayload(payload)) {
      // Only handle updates (not creates/removes)
      if (payload.action !== 'update') return null

      // Only produce an event if the state actually changed
      const hasStateChange = payload.updatedFrom?.stateId !== undefined
      if (!hasStateChange) return null

      const issue = webhookIssueToGovernorIssue(payload.data)

      const event: IssueStatusChangedEvent = {
        type: 'issue-status-changed',
        issueId: payload.data.id,
        issue,
        newStatus: issue.status,
        // Previous status name is not directly available from stateId alone;
        // we only know the stateId changed. The previous status name would
        // require an API call, so we leave it undefined.
        previousStatus: undefined,
        timestamp: eventTimestamp(),
        source: 'webhook',
      }

      return [event]
    }

    // Handle Comment creation
    if (isCommentPayload(payload)) {
      if (payload.action !== 'create') return null

      const commentData = payload.data
      const issueData = commentData.issue

      if (!issueData) return null

      const issue = webhookIssueToGovernorIssue(issueData)

      const event: CommentAddedEvent = {
        type: 'comment-added',
        issueId: issueData.id,
        issue,
        commentId: commentData.id,
        commentBody: commentData.body,
        userId: commentData.user?.id,
        userName: commentData.user?.name,
        timestamp: eventTimestamp(),
        source: 'webhook',
      }

      return [event]
    }

    // Unrecognized payload type
    return null
  }

  /**
   * Scan a Linear project for all non-terminal issues.
   *
   * Uses a single GraphQL query via `listProjectIssues()` to fetch all
   * issue data in one API call, eliminating the N+1 problem of lazy-loading
   * state/labels/parent/project for each issue.
   *
   * @param project - Linear project name to scan
   * @returns Array of GovernorIssue for all active issues
   */
  async scanProjectIssues(project: string): Promise<GovernorIssue[]> {
    const issues = await this.linearAgentClient.listProjectIssues(project)

    return issues.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      labels: issue.labels,
      createdAt: issue.createdAt,
      parentId: issue.parentId,
      project: issue.project,
    }))
  }

  /**
   * Scan a project and return both GovernorIssues and a set of parent issue IDs.
   *
   * The parent issue IDs are derived from `childCount > 0` in the single
   * GraphQL query, allowing callers to skip per-issue `isParentIssue()` API calls.
   *
   * @param project - Linear project name to scan
   * @returns Issues and a set of parent issue IDs
   */
  async scanProjectIssuesWithParents(
    project: string
  ): Promise<{ issues: GovernorIssue[]; parentIssueIds: Set<string> }> {
    const rawIssues = await this.linearAgentClient.listProjectIssues(project)

    const parentIssueIds = new Set<string>()
    const issues: GovernorIssue[] = []

    for (const issue of rawIssues) {
      if (issue.childCount > 0) {
        parentIssueIds.add(issue.id)
      }
      issues.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        labels: issue.labels,
        createdAt: issue.createdAt,
        parentId: issue.parentId,
        project: issue.project,
      })
    }

    return { issues, parentIssueIds }
  }

  /**
   * Convert a Linear SDK Issue object to a GovernorIssue.
   *
   * The `native` parameter is typed as `unknown` to satisfy the
   * PlatformAdapter interface. Internally it is cast to the Linear SDK
   * `Issue` type. Callers must ensure they pass a valid Linear Issue.
   *
   * @param native - Linear SDK Issue object
   * @returns GovernorIssue representation
   * @throws Error if the native object is not a valid Linear Issue
   */
  async toGovernorIssue(native: unknown): Promise<GovernorIssue> {
    const issue = native as Issue
    if (!issue || typeof issue.id !== 'string') {
      throw new Error(
        'LinearPlatformAdapter.toGovernorIssue: expected a Linear SDK Issue object'
      )
    }
    return sdkIssueToGovernorIssue(issue)
  }
}
