import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getAllSessions,
  getSessionsByStatus,
  getSessionState,
  getSessionStateByIssue,
  storeSessionState,
  updateSessionStatus,
  publishUrgent,
} from '@renseiai/agentfactory-server'
import type { AgentSessionStatus } from '@renseiai/agentfactory-server'

// Work type values for zod enum validation
const WORK_TYPES = [
  'research',
  'backlog-creation',
  'development',
  'inflight',
  'qa',
  'acceptance',
  'refinement',
  'refinement-coordination',
  'ga-readiness',
] as const

// Session status values for zod enum validation
const SESSION_STATUSES = [
  'pending',
  'claimed',
  'running',
  'finalizing',
  'completed',
  'failed',
  'stopped',
] as const

/**
 * Register all fleet management tools on the MCP server.
 *
 * Tools registered:
 * - submit-task: Submit a development task to the fleet work queue
 * - get-task-status: Get current status of a task by session or issue ID
 * - list-fleet: List agents and their statuses with optional filtering
 * - get-cost-report: Get cost/token usage for a task or the entire fleet
 * - stop-agent: Request to stop a running agent
 * - forward-prompt: Forward a follow-up prompt to a running agent session
 */
export function registerFleetTools(server: McpServer): void {
  // ─── submit-task ───────────────────────────────────────────────────
  server.tool(
    'submit-task',
    'Submit a development task to the fleet work queue. Creates a pending session that a worker will pick up.',
    {
      issueId: z.string().describe('Linear issue ID to work on'),
      description: z.string().optional().describe('Optional description or prompt context for the task'),
      workType: z.enum(WORK_TYPES).optional().describe('Type of work to perform (defaults to development)'),
      priority: z.number().min(1).max(5).optional().describe('Priority 1-5 where 1 is highest (defaults to 3)'),
    },
    async (args) => {
      try {
        const sessionId = `mcp-${Date.now()}-${args.issueId}`
        const session = await storeSessionState(sessionId, {
          issueId: args.issueId,
          providerSessionId: null,
          worktreePath: '',
          status: 'pending',
          priority: args.priority ?? 3,
          promptContext: args.description,
          workType: args.workType ?? 'development',
          queuedAt: Math.floor(Date.now() / 1000),
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  submitted: true,
                  taskId: session.trackerSessionId,
                  issueId: session.issueId,
                  status: session.status,
                  priority: session.priority,
                  workType: session.workType,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    },
  )

  // ─── get-task-status ───────────────────────────────────────────────
  server.tool(
    'get-task-status',
    'Get the current status of a task. Accepts either a session ID (taskId) or a Linear issue ID.',
    {
      taskId: z.string().describe('Session ID or Linear issue ID to look up'),
    },
    async (args) => {
      try {
        // Try direct session lookup first
        let session = await getSessionState(args.taskId)

        // Fall back to issue-based lookup
        if (!session) {
          session = await getSessionStateByIssue(args.taskId)
        }

        if (!session) {
          return {
            content: [{ type: 'text' as const, text: `Error: No task found for ID "${args.taskId}"` }],
            isError: true,
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(session, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    },
  )

  // ─── list-fleet ────────────────────────────────────────────────────
  server.tool(
    'list-fleet',
    'List agents in the fleet with optional status filtering and result limiting.',
    {
      status: z.array(z.enum(SESSION_STATUSES)).optional().describe('Filter by one or more statuses'),
      limit: z.number().min(1).optional().describe('Maximum number of results to return (defaults to 20)'),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20

        let sessions
        if (args.status && args.status.length > 0) {
          sessions = await getSessionsByStatus(args.status as AgentSessionStatus[])
        } else {
          sessions = await getAllSessions()
        }

        const limited = sessions.slice(0, limit)

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  total: sessions.length,
                  returned: limited.length,
                  sessions: limited,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    },
  )

  // ─── get-cost-report ───────────────────────────────────────────────
  server.tool(
    'get-cost-report',
    'Get cost and token usage report. If a taskId is provided, returns cost for that specific task. Otherwise, returns aggregate fleet costs.',
    {
      taskId: z.string().optional().describe('Session ID or issue ID for a specific task (omit for fleet-wide report)'),
    },
    async (args) => {
      try {
        if (args.taskId) {
          // Single-task cost report
          let session = await getSessionState(args.taskId)
          if (!session) {
            session = await getSessionStateByIssue(args.taskId)
          }

          if (!session) {
            return {
              content: [{ type: 'text' as const, text: `Error: No task found for ID "${args.taskId}"` }],
              isError: true,
            }
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    taskId: session.trackerSessionId,
                    issueId: session.issueId,
                    issueIdentifier: session.issueIdentifier,
                    status: session.status,
                    totalCostUsd: session.totalCostUsd ?? 0,
                    inputTokens: session.inputTokens ?? 0,
                    outputTokens: session.outputTokens ?? 0,
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }

        // Fleet-wide cost report
        const sessions = await getAllSessions()
        let totalCostUsd = 0
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let sessionsWithCost = 0

        for (const session of sessions) {
          if (session.totalCostUsd != null) {
            totalCostUsd += session.totalCostUsd
            sessionsWithCost++
          }
          if (session.inputTokens != null) {
            totalInputTokens += session.inputTokens
          }
          if (session.outputTokens != null) {
            totalOutputTokens += session.outputTokens
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  totalSessions: sessions.length,
                  sessionsWithCostData: sessionsWithCost,
                  totalCostUsd,
                  totalInputTokens,
                  totalOutputTokens,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    },
  )

  // ─── forward-prompt ────────────────────────────────────────────────
  server.tool(
    'forward-prompt',
    'Forward a follow-up prompt to a running agent session. The prompt is queued and delivered to the agent via its message injection mechanism.',
    {
      taskId: z.string().describe('Session ID or Linear issue ID of the running agent'),
      message: z.string().describe('The follow-up prompt or message to send to the agent'),
    },
    async (args) => {
      try {
        // Resolve the session — try direct lookup, then issue-based
        let session = await getSessionState(args.taskId)
        if (!session) {
          session = await getSessionStateByIssue(args.taskId)
        }

        if (!session) {
          return {
            content: [{ type: 'text' as const, text: `Error: No task found for ID "${args.taskId}"` }],
            isError: true,
          }
        }

        // Only allow forwarding to active sessions
        const forwardableStatuses: AgentSessionStatus[] = ['running', 'claimed']
        if (!forwardableStatuses.includes(session.status)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Task "${session.trackerSessionId}" is in status "${session.status}". Prompts can only be forwarded to running or claimed sessions.`,
              },
            ],
            isError: true,
          }
        }

        const agentId = session.agentId
        if (!agentId) {
          return {
            content: [{ type: 'text' as const, text: `Error: Session has no agentId. Cannot publish to agent inbox.` }],
            isError: true,
          }
        }

        const streamId = await publishUrgent(agentId, {
          type: 'directive',
          sessionId: session.trackerSessionId,
          payload: args.message,
          createdAt: Date.now(),
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  forwarded: true,
                  streamId,
                  taskId: session.trackerSessionId,
                  issueId: session.issueId,
                  sessionStatus: session.status,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    },
  )

  // ─── stop-agent ────────────────────────────────────────────────────
  server.tool(
    'stop-agent',
    'Request to stop a running agent. Updates the session status to stopped.',
    {
      taskId: z.string().describe('Session ID of the task to stop'),
    },
    async (args) => {
      try {
        // Verify the session exists and is in a stoppable state
        let session = await getSessionState(args.taskId)
        if (!session) {
          session = await getSessionStateByIssue(args.taskId)
        }

        if (!session) {
          return {
            content: [{ type: 'text' as const, text: `Error: No task found for ID "${args.taskId}"` }],
            isError: true,
          }
        }

        const stoppableStatuses: AgentSessionStatus[] = ['pending', 'claimed', 'running']
        if (!stoppableStatuses.includes(session.status)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Task "${session.trackerSessionId}" is in status "${session.status}" and cannot be stopped. Only pending, claimed, or running tasks can be stopped.`,
              },
            ],
            isError: true,
          }
        }

        const updated = await updateSessionStatus(session.trackerSessionId, 'stopped')

        if (!updated) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to update task status. Redis may not be configured.` }],
            isError: true,
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  stopped: true,
                  taskId: session.trackerSessionId,
                  issueId: session.issueId,
                  previousStatus: session.status,
                  newStatus: 'stopped',
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    },
  )
}
