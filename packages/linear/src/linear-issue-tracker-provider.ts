/**
 * LinearIssueTrackerProvider
 *
 * Declares the typed IssueTrackerProvider contract for Linear.
 * This is a thin adapter layer on top of LinearAgentClient — it maps
 * the domain-typed verbs from the canonical contract to the Linear SDK.
 *
 * The existing LinearIssueTrackerClient (issue-tracker-adapter.ts) retains
 * its interface for backward compatibility; this class works alongside it.
 *
 * Capability notes:
 * - supportsSubIssues: true  — Linear supports parent/child issues.
 *   IMPORTANT: Rensei agents MUST NOT use parentId. The flag is for the
 *   canonical contract and non-Rensei consumers only.
 * - supportsBlocking: true   — Linear supports "blocks" relations.
 * - identityScheme: 'username' — Linear users addressed by username/key.
 * - webhookProtocol: 'linear' — Linear uses its own signed webhook format.
 */

import type {
  IssueTrackerProvider,
  IssueTrackerCapabilities,
  TrackerIssue,
  TrackerComment,
  IssueTrackerCreateInput,
  IssueTrackerUpdateInput,
  ListIssuesFilter,
  AddRelationInput,
  AddRelationResult,
} from '@donmai/core'

import { createLinearAgentClient } from './agent-client.js'
import { resolveSDKLabelNames } from './utils.js'

type LinearClient = ReturnType<typeof createLinearAgentClient>

/**
 * LinearIssueTrackerProvider implements the canonical IssueTrackerProvider
 * interface, making Linear interchangeable with Jira/Asana/Notion adapters.
 *
 * Construct with a Linear API key:
 *   const provider = new LinearIssueTrackerProvider({ apiKey: process.env.LINEAR_API_KEY })
 */
export class LinearIssueTrackerProvider implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    supportsSubIssues: true,
    supportsLabels: true,
    supportsBlocking: true,
    supportsCustomFields: false,  // Linear does not have user-defined custom fields
    identityScheme: 'username',
    webhookProtocol: 'linear',
  }

  private readonly client: LinearClient

  constructor(config: { apiKey: string }) {
    this.client = createLinearAgentClient({ apiKey: config.apiKey })
  }

  async getIssue(idOrIdentifier: string): Promise<TrackerIssue> {
    const issue = await this.client.getIssue(idOrIdentifier)
    const state = await issue.state
    const team = await issue.team
    const project = await issue.project
    const labels = await issue.labels()
    const parent = await issue.parent

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      url: issue.url,
      priority: issue.priority,
      status: state?.name,
      labels: await resolveSDKLabelNames(labels.nodes),
      teamName: team?.key,
      projectName: project?.name,
      parentId: parent?.id,
    }
  }

  async listIssues(filter: ListIssuesFilter): Promise<TrackerIssue[]> {
    const sdkFilter: Record<string, unknown> = {}

    if (filter.status) {
      sdkFilter.state = { name: { eqIgnoreCase: filter.status } }
    }

    if (filter.project) {
      const projects = await this.client.linearClient.projects({
        filter: { name: { eqIgnoreCase: filter.project } },
      })
      if (projects.nodes.length > 0) {
        sdkFilter.project = { id: { eq: projects.nodes[0].id } }
      }
    }

    if (filter.teamId) {
      sdkFilter.team = { id: { eq: filter.teamId } }
    }

    if (filter.label) {
      sdkFilter.labels = { name: { eqIgnoreCase: filter.label } }
    }

    if (filter.assigneeId) {
      sdkFilter.assignee = { id: { eq: filter.assigneeId } }
    }

    const issues = await this.client.linearClient.issues({
      filter: sdkFilter,
      first: filter.maxResults ?? 50,
    })

    const results: TrackerIssue[] = []
    for (const issue of issues.nodes) {
      const state = await issue.state
      const team = await issue.team
      const project = await issue.project
      const labels = await issue.labels()
      const parent = await issue.parent

      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        url: issue.url,
        priority: issue.priority,
        status: state?.name,
        labels: await resolveSDKLabelNames(labels.nodes),
        teamName: team?.key,
        projectName: project?.name,
        parentId: parent?.id,
      })
    }

    return results
  }

  async createIssue(input: IssueTrackerCreateInput): Promise<TrackerIssue> {
    const createPayload: Parameters<LinearClient['linearClient']['createIssue']>[0] = {
      teamId: input.teamId ?? '',
      title: input.title,
    }

    if (input.description) createPayload.description = input.description
    if (input.stateId) createPayload.stateId = input.stateId
    if (input.projectId) createPayload.projectId = input.projectId
    if (input.labelIds && input.labelIds.length > 0) createPayload.labelIds = input.labelIds
    // Note: parentId intentionally passed through for contract completeness.
    // Rensei agents MUST NOT set parentId; see capability note in class header.
    if (input.parentId) createPayload.parentId = input.parentId

    const payload = await this.client.linearClient.createIssue(createPayload)
    if (!payload.success) {
      throw new Error('LinearIssueTrackerProvider.createIssue: Linear API returned success=false')
    }

    const issue = await payload.issue
    if (!issue) {
      throw new Error('LinearIssueTrackerProvider.createIssue: issue not returned after creation')
    }

    const state = await issue.state
    const labels = await issue.labels()
    const team = await issue.team

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      url: issue.url,
      priority: issue.priority,
      status: state?.name,
      labels: await resolveSDKLabelNames(labels.nodes),
      teamName: team?.key,
    }
  }

  async updateIssue(idOrIdentifier: string, input: IssueTrackerUpdateInput): Promise<TrackerIssue> {
    const issue = await this.client.getIssue(idOrIdentifier)

    const updateData: Parameters<LinearClient['updateIssue']>[1] = {}
    if (input.title) updateData.title = input.title
    if (input.description) updateData.description = input.description
    if (input.stateId) updateData.stateId = input.stateId
    if (input.labelIds) updateData.labelIds = input.labelIds

    const updatedIssue = await this.client.updateIssue(issue.id, updateData)
    const state = await updatedIssue.state
    const labels = await updatedIssue.labels()
    const team = await updatedIssue.team

    return {
      id: updatedIssue.id,
      identifier: updatedIssue.identifier,
      title: updatedIssue.title,
      description: updatedIssue.description ?? undefined,
      url: updatedIssue.url,
      priority: updatedIssue.priority,
      status: state?.name,
      labels: await resolveSDKLabelNames(labels.nodes),
      teamName: team?.key,
    }
  }

  async listComments(idOrIdentifier: string): Promise<TrackerComment[]> {
    const issue = await this.client.getIssue(idOrIdentifier)
    const comments = await this.client.getIssueComments(issue.id)

    return comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
    }))
  }

  async createComment(idOrIdentifier: string, body: string): Promise<TrackerComment> {
    const issue = await this.client.getIssue(idOrIdentifier)
    const comment = await this.client.createComment(issue.id, body)

    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
    }
  }

  async addRelation(input: AddRelationInput): Promise<AddRelationResult> {
    const result = await this.client.createIssueRelation({
      issueId: input.issueId,
      relatedIssueId: input.relatedIssueId,
      type: input.type,
    })

    return {
      success: result.success,
      relationId: result.relationId,
    }
  }
}
