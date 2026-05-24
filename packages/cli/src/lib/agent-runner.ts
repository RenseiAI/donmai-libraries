/**
 * Agent Runner -- Programmatic API for the af-agent CLI.
 *
 * Provides stop, chat, status, and reconnect commands for managing running
 * agent sessions. Works by updating Redis state directly — workers poll for
 * status changes and pending prompts every 5 seconds.
 */

import {
  getRedisClient,
  getAllSessions,
  updateSessionStatus,
  storeSessionState,
  publishUrgent,
  disconnectRedis,
  type AgentSessionState,
} from '@donmai/server'
import { createLinearAgentClient } from '@donmai/plugin-linear'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentCommand = 'stop' | 'chat' | 'status' | 'reconnect' | 'list'

export interface AgentRunnerConfig {
  /** Command to execute */
  command: AgentCommand
  /** Issue identifier (e.g., SUP-674) or partial session ID — not required for 'list' */
  issueId?: string
  /** Message text for 'chat' command */
  message?: string
  /** Show all sessions including completed/failed (for 'list' command) */
  all?: boolean
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

export const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureRedis(): void {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL environment variable is not set')
  }
  getRedisClient()
}

/**
 * Find a session by issue identifier (e.g., SUP-674) or partial session ID.
 * Prefers active sessions (running/claimed) over inactive ones.
 */
async function findSession(issueId: string): Promise<AgentSessionState | null> {
  const sessions = await getAllSessions()
  const normalizedInput = issueId.toUpperCase()

  const activeStatuses = new Set(['running', 'claimed', 'pending'])

  let activeMatch: AgentSessionState | null = null
  let fallback: AgentSessionState | null = null

  for (const session of sessions) {
    const matchesIdentifier = session.issueIdentifier?.toUpperCase() === normalizedInput
    const matchesSessionId = session.trackerSessionId.includes(issueId)

    if (!matchesIdentifier && !matchesSessionId) continue

    if (activeStatuses.has(session.status)) {
      activeMatch = session
      break
    }

    if (!fallback) {
      fallback = session
    }
  }

  return activeMatch ?? fallback
}

function formatSession(session: AgentSessionState): string {
  const statusColors: Record<string, string> = {
    pending: C.yellow,
    claimed: C.cyan,
    running: C.green,
    completed: C.gray,
    failed: C.red,
    stopped: C.yellow,
    finalizing: C.cyan,
  }
  const color = statusColors[session.status] ?? ''
  const identifier = session.issueIdentifier ?? session.issueId.slice(0, 8)
  const sessionShort = session.trackerSessionId.slice(0, 12)
  const worker = session.workerId ? ` worker:${session.workerId.slice(0, 8)}` : ''
  const workType = session.workType ? ` (${session.workType})` : ''

  return `${identifier} [${color}${session.status}${C.reset}]${workType} session:${sessionShort}${worker}`
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function stopWork(issueId: string): Promise<void> {
  ensureRedis()

  const session = await findSession(issueId)
  if (!session) {
    console.error(`${C.red}No session found for: ${issueId}${C.reset}`)
    await disconnectRedis()
    return
  }

  console.log(`Found: ${formatSession(session)}`)

  if (session.status === 'stopped') {
    console.log(`${C.yellow}Session already stopped${C.reset}`)
    await disconnectRedis()
    return
  }

  if (session.status === 'completed' || session.status === 'failed') {
    console.log(`${C.yellow}Session already in terminal state: ${session.status}${C.reset}`)
    await disconnectRedis()
    return
  }

  const updated = await updateSessionStatus(session.trackerSessionId, 'stopped')
  if (updated) {
    console.log(`${C.green}Stop signal sent${C.reset} — worker will abort within ~5 seconds`)
  } else {
    console.error(`${C.red}Failed to update session status${C.reset}`)
  }

  await disconnectRedis()
}

async function chatWithAgent(issueId: string, message: string): Promise<void> {
  ensureRedis()

  const session = await findSession(issueId)
  if (!session) {
    console.error(`${C.red}No session found for: ${issueId}${C.reset}`)
    await disconnectRedis()
    return
  }

  console.log(`Found: ${formatSession(session)}`)

  if (session.status !== 'running' && session.status !== 'claimed') {
    console.error(`${C.red}Cannot chat — session is ${session.status}, not running${C.reset}`)
    await disconnectRedis()
    return
  }

  const agentId = session.agentId
  if (!agentId) {
    console.error(`${C.red}Session has no agentId — cannot publish to inbox${C.reset}`)
    await disconnectRedis()
    return
  }

  try {
    const streamId = await publishUrgent(agentId, {
      type: 'directive',
      sessionId: session.trackerSessionId,
      payload: message,
      createdAt: Date.now(),
    })
    console.log(`${C.green}Message queued${C.reset} (id: ${streamId}) — worker will pick up within ~5 seconds`)
  } catch (err) {
    console.error(`${C.red}Failed to publish to inbox: ${err instanceof Error ? err.message : String(err)}${C.reset}`)
  }

  await disconnectRedis()
}

async function showStatus(issueId: string): Promise<void> {
  ensureRedis()

  const session = await findSession(issueId)
  if (!session) {
    console.error(`${C.red}No session found for: ${issueId}${C.reset}`)
    await disconnectRedis()
    return
  }

  console.log(`\n${C.cyan}Session Details${C.reset}`)
  console.log('='.repeat(50))
  console.log(`  Issue:       ${session.issueIdentifier ?? session.issueId}`)
  console.log(`  Status:      ${session.status}`)
  console.log(`  Work Type:   ${session.workType ?? 'development'}`)
  console.log(`  Session:     ${session.trackerSessionId}`)
  console.log(`  Worker:      ${session.workerId ?? '(none)'}`)
  console.log(`  Provider:    ${session.provider ?? '(unknown)'}`)
  console.log(`  Worktree:    ${session.worktreePath}`)
  if (session.providerSessionId) {
    console.log(`  Provider ID: ${session.providerSessionId}`)
  }
  if (session.totalCostUsd !== undefined) {
    console.log(`  Cost:        $${session.totalCostUsd.toFixed(4)}`)
  }
  console.log(`  Created:     ${new Date(session.createdAt * 1000).toISOString()}`)
  console.log(`  Updated:     ${new Date(session.updatedAt * 1000).toISOString()}`)

  await disconnectRedis()
}

async function reconnectSession(issueId: string): Promise<void> {
  ensureRedis()

  const session = await findSession(issueId)
  if (!session) {
    console.error(`${C.red}No session found for: ${issueId}${C.reset}`)
    await disconnectRedis()
    return
  }

  console.log(`Found: ${formatSession(session)}`)

  // Create a new Linear agent session on the issue
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    console.error(`${C.red}LINEAR_API_KEY is required for reconnect${C.reset}`)
    await disconnectRedis()
    return
  }

  const linearClient = createLinearAgentClient({ apiKey })

  console.log('Creating new Linear agent session...')
  const result = await linearClient.createAgentSessionOnIssue({
    issueId: session.issueId,
  })

  if (!result.success || !result.sessionId) {
    console.error(`${C.red}Failed to create Linear agent session${C.reset}`)
    await disconnectRedis()
    return
  }

  const newSessionId = result.sessionId
  console.log(`New Linear session: ${newSessionId.slice(0, 12)}...`)

  // Store a new Redis session state with the new Linear session ID,
  // preserving the existing state (worktree, worker, provider session, etc.)
  await storeSessionState(newSessionId, {
    issueId: session.issueId,
    issueIdentifier: session.issueIdentifier,
    providerSessionId: session.providerSessionId,
    worktreePath: session.worktreePath,
    status: session.status,
    trackerProvider: session.trackerProvider,
    workerId: session.workerId,
    queuedAt: session.queuedAt,
    claimedAt: session.claimedAt,
    priority: session.priority,
    promptContext: session.promptContext,
    organizationId: session.organizationId,
    workType: session.workType,
    agentId: session.agentId,
    projectName: session.projectName,
    provider: session.provider,
    totalCostUsd: session.totalCostUsd,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
  })

  // Mark the old session as stopped so the worker picks up the new one
  await updateSessionStatus(session.trackerSessionId, 'stopped')

  console.log(`${C.green}Reconnected${C.reset}`)
  console.log(`  Old session: ${session.trackerSessionId.slice(0, 12)}... (stopped)`)
  console.log(`  New session: ${newSessionId.slice(0, 12)}... (${session.status})`)
  console.log('')
  console.log(`The agent's Linear issue view will now show a fresh session.`)
  console.log(`Worker activities will be reported to the new session.`)

  await disconnectRedis()
}

async function listSessions(showAll: boolean): Promise<void> {
  ensureRedis()

  const sessions = await getAllSessions()
  const activeStatuses = new Set(['running', 'claimed', 'pending', 'finalizing'])

  const filtered = showAll
    ? sessions
    : sessions.filter((s) => activeStatuses.has(s.status))

  const label = showAll ? 'All Sessions' : 'Active Sessions'
  console.log(`\n${C.cyan}${label}${C.reset} (${filtered.length}${showAll ? '' : ` of ${sessions.length}`})`)
  console.log('='.repeat(60))

  if (filtered.length === 0) {
    console.log(showAll ? '(none)' : '(no active sessions)')
    await disconnectRedis()
    return
  }

  for (const session of filtered) {
    const elapsed = Math.round(Date.now() / 1000 - session.createdAt)
    const mins = Math.floor(elapsed / 60)
    const duration = mins < 60
      ? `${mins}m`
      : `${Math.floor(mins / 60)}h${mins % 60}m`

    const cost = session.totalCostUsd !== undefined
      ? ` $${session.totalCostUsd.toFixed(2)}`
      : ''

    console.log(`  ${formatSession(session)} ${C.gray}${duration}${cost}${C.reset}`)
  }

  await disconnectRedis()
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runAgent(config: AgentRunnerConfig): Promise<void> {
  switch (config.command) {
    case 'list':
      await listSessions(config.all ?? false)
      break
    case 'stop':
      if (!config.issueId) throw new Error('stop command requires an issue ID')
      await stopWork(config.issueId)
      break
    case 'chat':
      if (!config.issueId) throw new Error('chat command requires an issue ID')
      if (!config.message) throw new Error('chat command requires a message')
      await chatWithAgent(config.issueId, config.message)
      break
    case 'status':
      if (!config.issueId) throw new Error('status command requires an issue ID')
      await showStatus(config.issueId)
      break
    case 'reconnect':
      if (!config.issueId) throw new Error('reconnect command requires an issue ID')
      await reconnectSession(config.issueId)
      break
  }
}
