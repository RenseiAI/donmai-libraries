/**
 * Real Linear client adapter for cleanup-sub-issues.
 *
 * Separated into its own file so the test suite (cleanup-sub-issues.test.ts)
 * never imports this module — it only imports cleanup-sub-issues.ts which
 * lazily delegates here via the `linearClient` injection point.
 */

import { createLinearAgentClient } from '@donmai/plugin-linear'
import type { LinearClientInterface, LinearIssue } from './cleanup-sub-issues.js'

const PROCESSED_LABEL = 'cleanup:processed'

/**
 * Build a real LinearClientInterface from an API key.
 */
export async function buildLinearClient(apiKey: string): Promise<LinearClientInterface> {
  const rawClient = createLinearAgentClient({ apiKey })

  // Shared helper: ensure the PROCESSED_LABEL exists and add it to the issue
  async function addLabelToIssue(issueId: string, labelName: string): Promise<void> {
    const allLabels = await rawClient.linearClient.issueLabels({ first: 250 })
    let labelId: string | undefined = allLabels.nodes.find(
      (l) => l.name.toLowerCase() === labelName.toLowerCase()
    )?.id

    if (!labelId) {
      const issue = await rawClient.getIssue(issueId)
      const team = await issue.team
      if (team) {
        const payload = await rawClient.linearClient.createIssueLabel({
          name: labelName,
          teamId: team.id,
        })
        const created = await payload.issueLabel
        labelId = created?.id
      }
    }

    if (labelId) {
      const issue = await rawClient.getIssue(issueId)
      const existingLabels = await issue.labels()
      const existingIds = existingLabels.nodes.map((l) => l.id)
      if (!existingIds.includes(labelId)) {
        await rawClient.updateIssue(issueId, { labelIds: [...existingIds, labelId] })
      }
    }
  }

  return {
    async listProjectIssues(projectName: string): Promise<LinearIssue[]> {
      const issues = await rawClient.listProjectIssues(projectName)
      return issues.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        description: i.description,
        status: i.status,
        createdAt: i.createdAt,
        parentId: i.parentId,
        childCount: i.childCount,
        labels: i.labels,
        authorId: undefined,
      }))
    },

    async getIssueFull(issueId: string) {
      type RawClient = {
        client: {
          rawRequest(q: string, vars: Record<string, unknown>): Promise<{ data: unknown }>
        }
      }
      const inner = rawClient as unknown as RawClient

      const query = `
        query CleanupIssueDetail($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            creator { id name }
            labels { nodes { name } }
            attachments { nodes { id } }
            history(first: 50) {
              nodes {
                actor { id }
                updatedDescription
              }
            }
          }
        }
      `

      const result = await inner.client.rawRequest(query, { id: issueId })
      const data = result.data as {
        issue: {
          id: string
          identifier: string
          title: string
          description?: string | null
          creator?: { id: string; name: string } | null
          labels: { nodes: Array<{ name: string }> }
          attachments: { nodes: Array<{ id: string }> }
          history: {
            nodes: Array<{
              actor?: { id: string } | null
              updatedDescription?: boolean | null
            }>
          }
        } | null
      }

      if (!data.issue) throw new Error(`Issue not found: ${issueId}`)
      const iss = data.issue

      const authorId = iss.creator?.id
      const hasLinkedResources = iss.attachments.nodes.length > 0
      const editedByHuman = iss.history.nodes.some(
        (h) => h.actor?.id && h.actor.id !== authorId
      )

      return {
        id: iss.id,
        identifier: iss.identifier,
        title: iss.title,
        description: iss.description,
        authorId,
        hasLinkedResources,
        editedByHuman,
        labels: iss.labels.nodes.map((l) => l.name),
      }
    },

    async closeIssue(issueId: string, comment: string): Promise<void> {
      await addLabelToIssue(issueId, PROCESSED_LABEL)
      await rawClient.createComment(issueId, comment)
      await rawClient.updateIssueStatus(issueId, 'Canceled')
    },

    async detachFromParent(issueId: string, comment: string): Promise<void> {
      await addLabelToIssue(issueId, PROCESSED_LABEL)
      await rawClient.createComment(issueId, comment)
      await rawClient.updateIssue(issueId, { parentId: null })
    },

    async addLabel(issueId: string, labelName: string): Promise<void> {
      await addLabelToIssue(issueId, labelName)
    },

    async hasLabel(issueId: string, labelName: string): Promise<boolean> {
      const issue = await rawClient.getIssue(issueId)
      const labels = await issue.labels()
      return labels.nodes.some((l) => l.name.toLowerCase() === labelName.toLowerCase())
    },

    async createComment(issueId: string, body: string): Promise<void> {
      await rawClient.createComment(issueId, body)
    },
  }
}
