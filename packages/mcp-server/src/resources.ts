import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getAllSessions,
  getSessionState,
  getSessionStateByIssue,
  listWorkers,
  getTotalCapacity,
} from '@donmai/server'

/**
 * Registers MCP resources that expose AgentFactory fleet state to MCP-aware clients.
 *
 * Resources:
 *   - fleet://agents        — Current fleet state (agents, statuses, costs)
 *   - fleet://issues/{id}   — Issue details with agent progress
 *   - fleet://logs/{id}     — Agent activity logs / session info
 *
 * Also starts a polling loop that emits resource-update notifications
 * when fleet state changes, enabling MCP clients to subscribe to updates.
 */
export function registerFleetResources(server: McpServer): void {
  // 1. fleet://agents — Current fleet state
  server.resource(
    'fleet-agents',
    'fleet://agents',
    { description: 'Current fleet state including all agent sessions, workers, and capacity' },
    async (uri) => {
      const [sessions, workers, capacity] = await Promise.all([
        getAllSessions(),
        listWorkers(),
        getTotalCapacity(),
      ])

      const data = { sessions, workers, capacity }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      }
    },
  )

  // 2. fleet://issues/{id} — Issue details with agent progress
  server.resource(
    'fleet-issue',
    new ResourceTemplate('fleet://issues/{id}', { list: undefined }),
    { description: 'Issue details with agent session progress' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id
      const session = await getSessionStateByIssue(id)

      const data = session
        ? session
        : { error: 'not_found', message: `No agent session found for issue: ${id}` }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      }
    },
  )

  // 3. fleet://logs/{id} — Agent activity logs
  server.resource(
    'fleet-logs',
    new ResourceTemplate('fleet://logs/{id}', { list: undefined }),
    { description: 'Agent activity logs and session information' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id

      // Try to find the session by trackerSessionId first, then fall back to issue ID
      let session = await getSessionState(id)
      if (!session) {
        session = await getSessionStateByIssue(id)
      }

      if (!session) {
        const data = { error: 'not_found', message: `No agent session found for id: ${id}` }
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(data, null, 2),
              mimeType: 'application/json',
            },
          ],
        }
      }

      const data: Record<string, unknown> = {
        ...session,
        _logHint: session.worktreePath
          ? `Activity logs may be available on disk at: ${session.worktreePath}/.agent/state.json`
          : 'No worktree path available for this session',
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      }
    },
  )

  // ─── Resource update notifications ────────────────────────────────────
  // Poll fleet state and emit MCP resource-update notifications when changes
  // are detected, so subscribed clients automatically refresh.
  startResourceNotificationPoller(server)
}

// ─── Polling-based resource notifications ─────────────────────────────────

const POLL_INTERVAL_MS = 5_000

/** Lightweight snapshot of fleet state for change detection */
interface FleetSnapshot {
  sessionCount: number
  /** Sorted comma-separated status summary, e.g. "running:3,pending:2" */
  statusSummary: string
}

let pollTimer: ReturnType<typeof setInterval> | null = null

function buildSnapshot(sessions: { status: string }[]): FleetSnapshot {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    counts.set(s.status, (counts.get(s.status) ?? 0) + 1)
  }
  const statusSummary = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(',')
  return { sessionCount: sessions.length, statusSummary }
}

function snapshotsEqual(a: FleetSnapshot | null, b: FleetSnapshot): boolean {
  if (!a) return false
  return a.sessionCount === b.sessionCount && a.statusSummary === b.statusSummary
}

function startResourceNotificationPoller(server: McpServer): void {
  let lastSnapshot: FleetSnapshot | null = null

  pollTimer = setInterval(async () => {
    try {
      const sessions = await getAllSessions()
      const snapshot = buildSnapshot(sessions)

      if (!snapshotsEqual(lastSnapshot, snapshot)) {
        lastSnapshot = snapshot
        // Notify subscribed clients that fleet://agents has changed
        try {
          await server.server.sendResourceUpdated({ uri: 'fleet://agents' })
        } catch {
          // Client may not be subscribed — safe to ignore
        }
      }
    } catch {
      // Redis may be unavailable — skip this tick
    }
  }, POLL_INTERVAL_MS)

  // Ensure the timer doesn't prevent process exit
  if (pollTimer && typeof pollTimer === 'object' && 'unref' in pollTimer) {
    pollTimer.unref()
  }
}

/** Stop the resource notification poller (for graceful shutdown) */
export function stopResourceNotificationPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
