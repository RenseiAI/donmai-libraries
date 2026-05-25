/**
 * LinearFrontendAdapter
 *
 * Implements the WorkSchedulingFrontend interface (defined in @donmai/core)
 * by wrapping the LinearAgentClient. This adapter translates between abstract,
 * frontend-agnostic types and Linear-specific concepts.
 *
 * Structural typing note: This class structurally satisfies the WorkSchedulingFrontend
 * interface from @donmai/core without an explicit `implements` clause, avoiding
 * a circular package dependency (core depends on linear at runtime, linear depends on
 * core only for types). Consumers who import both packages can assign this to
 * WorkSchedulingFrontend.
 */

import type { Issue, Comment } from '@linear/sdk'
import type { LinearWorkflowStatus, ThoughtActivityContent } from './types.js'
import type { LinearAgentClient } from './agent-client.js'
import { resolveSDKLabelNames } from './utils.js'

// ---------------------------------------------------------------------------
// Abstract types (structurally identical to @donmai/core frontend types)
// ---------------------------------------------------------------------------

/**
 * Abstract workflow statuses that map to Linear-specific status names.
 */
export type AbstractStatus =
  | 'icebox'
  | 'backlog'
  | 'started'
  | 'finished'
  | 'delivered'
  | 'accepted'
  | 'rejected'
  | 'canceled'

/**
 * Minimal issue representation shared across frontends.
 */
export interface AbstractIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  status: AbstractStatus
  priority: number
  labels: string[]
  parentId?: string
  project?: string
  createdAt: Date
}

/**
 * Minimal comment representation.
 */
export interface AbstractComment {
  id: string
  body: string
  userId?: string
  userName?: string
  createdAt: Date
}

/**
 * External URL for agent sessions.
 */
export interface ExternalUrl {
  label: string
  url: string
}

/**
 * Input for creating an issue.
 */
export interface CreateIssueInput {
  title: string
  teamId?: string
  description?: string
  projectId?: string
  status?: AbstractStatus
  labels?: string[]
  parentId?: string
  priority?: number
}

/**
 * Input for creating a blocker issue.
 */
export interface CreateBlockerInput {
  title: string
  description?: string
  teamId?: string
  projectId?: string
  assignee?: string
}

/**
 * Input for updating an agent session.
 */
export interface UpdateSessionInput {
  externalUrls?: ExternalUrl[]
  plan?: Array<{ content: string; status: 'pending' | 'inProgress' | 'completed' | 'canceled' }>
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

const ABSTRACT_TO_LINEAR: Record<AbstractStatus, LinearWorkflowStatus | 'Icebox'> = {
  icebox: 'Icebox',
  backlog: 'Backlog',
  started: 'Started',
  finished: 'Finished',
  delivered: 'Delivered',
  accepted: 'Accepted',
  rejected: 'Rejected',
  canceled: 'Canceled',
}

const LINEAR_TO_ABSTRACT: Record<string, AbstractStatus> = {
  Icebox: 'icebox',
  Backlog: 'backlog',
  Started: 'started',
  Finished: 'finished',
  Delivered: 'delivered',
  Accepted: 'accepted',
  Rejected: 'rejected',
  Canceled: 'canceled',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Linear SDK Issue to an AbstractIssue.
 */
async function toAbstractIssue(issue: Issue): Promise<AbstractIssue> {
  const state = await issue.state
  const labels = await issue.labels()
  const parent = await issue.parent
  const project = await issue.project

  const nativeStatus = state?.name ?? 'Backlog'
  const status: AbstractStatus = LINEAR_TO_ABSTRACT[nativeStatus] ?? 'backlog'

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    url: issue.url,
    status,
    priority: issue.priority,
    labels: await resolveSDKLabelNames(labels.nodes),
    parentId: parent?.id,
    project: project?.name,
    createdAt: issue.createdAt,
  }
}

/**
 * Map a Linear SDK Comment to an AbstractComment.
 */
async function toAbstractComment(comment: Comment): Promise<AbstractComment> {
  const user = await comment.user

  return {
    id: comment.id,
    body: comment.body,
    userId: user?.id,
    userName: user?.name,
    createdAt: comment.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Linear frontend adapter that wraps LinearAgentClient.
 *
 * Structurally satisfies WorkSchedulingFrontend from @donmai/core.
 */
export class LinearFrontendAdapter {
  readonly name = 'linear' as const

  constructor(private readonly client: LinearAgentClient) {}

  // ---- Status mapping ----

  /**
   * Resolve an abstract status to its Linear-native name.
   */
  resolveStatus(abstract: AbstractStatus): string {
    return ABSTRACT_TO_LINEAR[abstract]
  }

  /**
   * Map a Linear-native status name to its abstract equivalent.
   * Defaults to 'backlog' for unknown statuses.
   */
  abstractStatus(nativeStatus: string): AbstractStatus {
    return LINEAR_TO_ABSTRACT[nativeStatus] ?? 'backlog'
  }

  // ---- Read operations ----

  /**
   * Fetch an issue by ID or identifier and map to AbstractIssue.
   */
  async getIssue(id: string): Promise<AbstractIssue> {
    const issue = await this.client.getIssue(id)
    return toAbstractIssue(issue)
  }

  /**
   * List issues in a project filtered by abstract status.
   *
   * Uses the underlying LinearClient directly since LinearAgentClient
   * does not expose a project-scoped issue listing method.
   */
  async listIssuesByStatus(project: string, status: AbstractStatus): Promise<AbstractIssue[]> {
    const nativeStatus = this.resolveStatus(status)
    const linearClient = this.client.linearClient

    const issueConnection = await linearClient.issues({
      filter: {
        project: { name: { eq: project } },
        state: { name: { eq: nativeStatus } },
      },
    })

    const results: AbstractIssue[] = []
    for (const issue of issueConnection.nodes) {
      results.push(await toAbstractIssue(issue))
    }
    return results
  }

  /**
   * Get comments for an issue and map to AbstractComment[].
   */
  async getIssueComments(id: string): Promise<AbstractComment[]> {
    const comments = await this.client.getIssueComments(id)
    const results: AbstractComment[] = []
    for (const comment of comments) {
      results.push(await toAbstractComment(comment))
    }
    return results
  }

  /**
   * List issues in a project filtered by abstract status, excluding
   * those that are blocked by other issues (have incoming "blocks" relations).
   */
  async getUnblockedIssues(project: string, status: AbstractStatus): Promise<AbstractIssue[]> {
    const allIssues = await this.listIssuesByStatus(project, status)
    const results: AbstractIssue[] = []

    for (const issue of allIssues) {
      const relations = await this.client.getIssueRelations(issue.id)
      // An issue is blocked if another issue has an outgoing "blocks" relation to it
      // (appears as an inverse relation with type "blocks")
      const isBlocked = relations.inverseRelations.some((r) => r.type === 'blocks')
      if (!isBlocked) {
        results.push(issue)
      }
    }

    return results
  }

  /**
   * Check if an issue has child issues (is a parent issue).
   */
  async isParentIssue(id: string): Promise<boolean> {
    return this.client.isParentIssue(id)
  }

  /**
   * Check if an issue has a parent (is a child/sub-issue).
   */
  async isChildIssue(id: string): Promise<boolean> {
    return this.client.isChildIssue(id)
  }

  /**
   * Get sub-issues of a parent issue, mapped to AbstractIssue[].
   */
  async getSubIssues(id: string): Promise<AbstractIssue[]> {
    const subIssues = await this.client.getSubIssues(id)
    const results: AbstractIssue[] = []
    for (const issue of subIssues) {
      results.push(await toAbstractIssue(issue))
    }
    return results
  }

  // ---- Write operations ----

  /**
   * Transition an issue to a new status.
   */
  async transitionIssue(id: string, status: AbstractStatus): Promise<void> {
    const nativeStatus = this.resolveStatus(status)
    // LinearAgentClient.updateIssueStatus expects LinearWorkflowStatus
    // which does not include 'Icebox', so we handle that case via updateIssue
    if (nativeStatus === 'Icebox') {
      const issue = await this.client.getIssue(id)
      const team = await issue.team
      if (team) {
        const statuses = await this.client.getTeamStatuses(team.id)
        const stateId = statuses['Icebox']
        if (stateId) {
          await this.client.updateIssue(id, { stateId })
          return
        }
      }
      throw new Error(`Cannot transition issue ${id} to Icebox: status not found`)
    }
    await this.client.updateIssueStatus(id, nativeStatus as LinearWorkflowStatus)
  }

  /**
   * Create a comment on an issue.
   */
  async createComment(id: string, body: string): Promise<void> {
    await this.client.createComment(id, body)
  }

  /**
   * Create a blocker issue that blocks the source issue.
   * Creates the issue in Icebox with a "Needs Human" label (if found),
   * then creates a "blocks" relation from the blocker to the source.
   */
  async createBlockerIssue(sourceId: string, data: CreateBlockerInput): Promise<AbstractIssue> {
    // Determine the team — use provided teamId or look it up from the source issue
    let teamId = data.teamId
    if (!teamId) {
      const sourceIssue = await this.client.getIssue(sourceId)
      const team = await sourceIssue.team
      if (!team) {
        throw new Error(`Cannot create blocker: source issue ${sourceId} has no team`)
      }
      teamId = team.id
    }

    // Find the Icebox state
    const statuses = await this.client.getTeamStatuses(teamId)
    const iceboxStateId = statuses['Icebox']

    // Find the "Needs Human" label
    const allLabels = await this.client.linearClient.issueLabels()
    const needsHumanLabel = allLabels.nodes.find(
      (l) => l.name.toLowerCase() === 'needs human'
    )

    const issue = await this.client.createIssue({
      title: data.title,
      description: data.description,
      teamId,
      projectId: data.projectId,
      ...(iceboxStateId && { stateId: iceboxStateId }),
      ...(needsHumanLabel && { labelIds: [needsHumanLabel.id] }),
    })

    // Create blocking relation: blocker blocks source issue
    await this.client.createIssueRelation({
      issueId: issue.id,
      relatedIssueId: sourceId,
      type: 'blocks',
    })

    return toAbstractIssue(issue)
  }

  /**
   * Create a new issue and return it as AbstractIssue.
   */
  async createIssue(data: CreateIssueInput): Promise<AbstractIssue> {
    // Resolve status name to state ID if provided
    let stateId: string | undefined
    if (data.status && data.teamId) {
      const nativeStatus = this.resolveStatus(data.status)
      const statuses = await this.client.getTeamStatuses(data.teamId)
      stateId = statuses[nativeStatus]
    }

    const issue = await this.client.createIssue({
      title: data.title,
      teamId: data.teamId!,
      description: data.description,
      projectId: data.projectId,
      stateId,
      parentId: data.parentId,
      priority: data.priority,
    })

    return toAbstractIssue(issue)
  }

  // ---- Agent session operations ----

  /**
   * Create an agent session on an issue.
   * Returns the session ID.
   */
  async createAgentSession(issueId: string, externalUrls?: ExternalUrl[]): Promise<string> {
    const result = await this.client.createAgentSessionOnIssue({
      issueId,
      externalUrls,
    })

    if (!result.sessionId) {
      throw new Error(`Failed to create agent session on issue: ${issueId}`)
    }

    return result.sessionId
  }

  /**
   * Update an existing agent session.
   */
  async updateAgentSession(sessionId: string, data: UpdateSessionInput): Promise<void> {
    await this.client.updateAgentSession({
      sessionId,
      externalUrls: data.externalUrls,
      plan: data.plan,
    })
  }

  /**
   * Create an activity on an agent session.
   * Wraps the content as a ThoughtActivityContent.
   */
  async createActivity(sessionId: string, type: string, content: string): Promise<void> {
    const activityContent: ThoughtActivityContent = {
      type: 'thought',
      body: content,
    }

    await this.client.createAgentActivity({
      agentSessionId: sessionId,
      content: activityContent,
    })
  }
}
