/**
 * Proxy Issue Tracker Adapter
 *
 * Implements the platform-agnostic IssueTrackerClient interface by wrapping
 * ProxyIssueTrackerClient (which routes calls through the remote API proxy).
 *
 * Used when LINEAR_API_KEY is not available but AGENTFACTORY_API_URL is set,
 * allowing workers to perform issue tracker operations via the centralized proxy.
 */

import { ProxyIssueTrackerClient } from './proxy-client.js'
import type { ProxyClientConfig } from './proxy-client.js'
import type { SerializedIssue } from './issue-tracker-proxy.js'

export type { ProxyClientConfig } from './proxy-client.js'

// ---------------------------------------------------------------------------
// Platform-agnostic types (structurally identical to @donmai/core)
// Defined locally to avoid circular dependency: core -> linear -> core
// ---------------------------------------------------------------------------

/** Platform-agnostic issue representation. */
export interface IssueTrackerIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  priority: number
  status?: string
  labels: string[]
  teamName?: string
  projectName?: string
  parentId?: string
}

/** Configuration for creating an issue tracker session. */
export interface SessionConfig {
  issueId: string
  sessionId: string
  autoTransition?: boolean
}

/** Platform-agnostic session for streaming agent activities. */
export interface IssueTrackerSession {
  emitThought(content: string, ephemeral?: boolean): Promise<void>
  emitAction(tool: string, input: Record<string, unknown>, ephemeral?: boolean, toolCategory?: string): Promise<void>
  emitToolResult(tool: string, output: string, ephemeral?: boolean): Promise<void>
  emitResponse(content: string): Promise<void>
  emitError(error: Error): Promise<void>
  reportEnvironmentIssue(
    title: string,
    description: string,
    options?: unknown
  ): Promise<{ id: string; identifier: string; url: string } | null>
  setPullRequestUrl(url: string): Promise<void>
  addExternalUrl(url: { url: string; label: string }): Promise<void>
  complete(): Promise<void>
}

/** Comment chunk returned by buildCompletionComments. */
export interface CommentChunk {
  body: string
  partNumber: number
  totalParts: number
}

/** Platform-agnostic issue tracker client. */
export interface IssueTrackerClient {
  getIssue(idOrIdentifier: string): Promise<IssueTrackerIssue>
  isParentIssue(issueId: string): Promise<boolean>
  isChildIssue(issueId: string): Promise<boolean>
  createComment(issueId: string, body: string): Promise<{ id: string }>
  updateIssueStatus(issueId: string, status: string): Promise<void>
  unassignIssue(issueId: string): Promise<void>
  queryIssues(options: {
    project?: string
    status?: string
    maxResults?: number
  }): Promise<IssueTrackerIssue[]>
  getProjectRepositoryUrl(projectName: string): Promise<string | null>
  createSession(config: SessionConfig): IssueTrackerSession
  buildCompletionComments(
    resultMessage: string,
    planItems: unknown[],
    sessionId: string | null
  ): CommentChunk[]
}

// ---------------------------------------------------------------------------
// SerializedIssue → IssueTrackerIssue mapping
// ---------------------------------------------------------------------------

function toIssueTrackerIssue(s: SerializedIssue): IssueTrackerIssue {
  return {
    id: s.id,
    identifier: s.identifier,
    title: s.title,
    description: s.description,
    url: s.url,
    priority: s.priority,
    status: s.state?.name,
    labels: s.labels.map(l => l.name),
    teamName: s.team?.name,
    projectName: s.project?.name,
    parentId: s.parent?.id,
  }
}

// ---------------------------------------------------------------------------
// No-op session — activity streaming is handled by ApiActivityEmitter,
// so the IssueTrackerSession methods are not needed in proxy mode.
// ---------------------------------------------------------------------------

class ProxyIssueTrackerSession implements IssueTrackerSession {
  async emitThought(): Promise<void> {}
  async emitAction(): Promise<void> {}
  async emitToolResult(): Promise<void> {}
  async emitResponse(): Promise<void> {}
  async emitError(): Promise<void> {}
  async reportEnvironmentIssue(): Promise<null> { return null }
  async setPullRequestUrl(): Promise<void> {}
  async addExternalUrl(): Promise<void> {}
  async complete(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Proxy Issue Tracker Adapter
// ---------------------------------------------------------------------------

/**
 * Implements IssueTrackerClient by routing all calls through the remote API proxy.
 *
 * Used when LINEAR_API_KEY is not available but AGENTFACTORY_API_URL is set.
 * The proxy handles authentication and credential resolution server-side.
 */
export class ProxyIssueTrackerAdapter implements IssueTrackerClient {
  readonly proxyClient: ProxyIssueTrackerClient

  constructor(config: ProxyClientConfig) {
    this.proxyClient = new ProxyIssueTrackerClient(config)
  }

  async getIssue(idOrIdentifier: string): Promise<IssueTrackerIssue> {
    const issue = await this.proxyClient.getIssue(idOrIdentifier)
    return toIssueTrackerIssue(issue)
  }

  async isParentIssue(issueId: string): Promise<boolean> {
    return this.proxyClient.isParentIssue(issueId)
  }

  async isChildIssue(issueId: string): Promise<boolean> {
    return this.proxyClient.isChildIssue(issueId)
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const comment = await this.proxyClient.createComment(issueId, body)
    return { id: comment.id }
  }

  async updateIssueStatus(issueId: string, status: string): Promise<void> {
    await this.proxyClient.updateIssueStatus(issueId, status as any)
  }

  async unassignIssue(issueId: string): Promise<void> {
    await this.proxyClient.unassignIssue(issueId)
  }

  async queryIssues(options: {
    project?: string
    status?: string
    maxResults?: number
  }): Promise<IssueTrackerIssue[]> {
    if (!options.project) return []

    const items = await this.proxyClient.listProjectIssues(options.project)

    let filtered = items
    if (options.status) {
      const statusLower = options.status.toLowerCase()
      filtered = items.filter(i => i.status.toLowerCase() === statusLower)
    }

    if (options.maxResults) {
      filtered = filtered.slice(0, options.maxResults)
    }

    return filtered.map(i => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description,
      url: '',
      priority: 0,
      status: i.status,
      labels: i.labels,
      projectName: i.project,
      parentId: i.parentId,
    }))
  }

  async getProjectRepositoryUrl(projectName: string): Promise<string | null> {
    try {
      return await this.proxyClient.getProjectRepositoryUrl(projectName)
    } catch {
      return null
    }
  }

  createSession(_config: SessionConfig): IssueTrackerSession {
    return new ProxyIssueTrackerSession()
  }

  buildCompletionComments(
    resultMessage: string,
    _planItems: unknown[],
    _sessionId: string | null
  ): CommentChunk[] {
    // Simple chunking — same as NullIssueTrackerClient
    return [{ body: resultMessage, partNumber: 1, totalParts: 1 }]
  }
}
