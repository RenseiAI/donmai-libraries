import {
  getRedisClient,
  isRedisConfigured,
  redisSet,
  redisGet,
  redisDel,
  redisKeys,
  redisEval,
} from './redis.js'
import { onCostUpdated } from './fleet-quota-hooks.js'
import type { AgentWorkType } from './types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/**
 * Agent session status
 * - pending: Queued, waiting for a worker to claim
 * - claimed: Worker has claimed but not yet started
 * - running: Agent is actively processing
 * - finalizing: Agent work done, cleanup in progress (worktree removal, orchestrator teardown)
 * - completed: Agent finished successfully (all cleanup done)
 * - failed: Agent encountered an error
 * - stopped: Agent was stopped by user
 * - timed_out: Agent exceeded its allotted execution time
 */
export type AgentSessionStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'timed_out'

/**
 * Agent session state stored in Redis for distributed access
 */
export interface AgentSessionState {
  /**
   * Tracker-agnostic session ID (from webhook or self-dispatch).
   * For Linear sessions this is the Linear AgentSession ID;
   * for GitHub Issues sessions it is a UUID assigned at dispatch time.
   */
  trackerSessionId: string
  /**
   * Issue tracker provider that owns this session.
   * Defaults to 'linear' when reading legacy Redis data written before.
   */
  trackerProvider: string
  /**
   * @deprecated Use `trackerSessionId` instead.
   * Kept for one major version to allow zero-downtime rolling upgrades
   * against Redis data written by legacy workers.
   * Will be removed in the next major release.
   */
  linearSessionId?: string
  /** Linear issue ID */
  issueId: string
  /** Issue identifier (e.g., ABC-123) */
  issueIdentifier?: string
  /** Provider CLI session ID for resuming with --resume */
  providerSessionId: string | null
  /** Git worktree path */
  worktreePath: string
  /** Current agent status */
  status: AgentSessionStatus
  /** Unix timestamp in milliseconds when session was created */
  createdAt: number
  /** Unix timestamp in milliseconds of last update */
  updatedAt: number

  // Worker pool fields
  /** Worker ID handling this session (null if pending) */
  workerId?: string | null
  /** Unix timestamp in milliseconds when added to work queue */
  queuedAt?: number | null
  /** Unix timestamp in milliseconds when claimed by worker */
  claimedAt?: number | null
  /** Priority in queue (1-5, lower is higher priority) */
  priority?: number
  /** Prompt context for the session */
  promptContext?: string

  // OAuth context for Linear Agent API
  /** Linear organization ID for OAuth token lookup */
  organizationId?: string

  // Work type for status-based routing
  /** Type of work: research, development, inflight, qa, acceptance, refinement (defaults to 'development') */
  workType?: AgentWorkType

  // Agent identification (from Linear webhook)
  /** Linear Agent ID handling this session */
  agentId?: string

  /** Linear project name (for routing and dashboard visibility) */
  projectName?: string

  /** Agent provider name (claude, codex, amp) — set by worker on claim */
  provider?: string

  // Cost tracking (populated from provider result events)
  /** Total cost in USD for this session */
  totalCostUsd?: number
  /** Total input tokens consumed */
  inputTokens?: number
  /** Total output tokens consumed */
  outputTokens?: number

  /** Last tool name reported by worker heartbeat (for tool loop detection) */
  lastToolName?: string
  /** Epoch ms when this tool was first seen continuously */
  lastToolCalledAt?: number
  /** Consecutive calls to the same tool */
  toolCallCount?: number

  /**
   * Workflow instance ID that initiated this session, when the session was
   * dispatched via the workflow engine (e.g. `agent.dispatch_stage` node).
   * Absent for sessions created by direct webhook dispatch (Linear @-mention
   * with no workflow subscription, governor-generated stages, etc.).
   *
   * Read by per-workflow opt-in surfaces: the platform's activity route
   * uses this to look up the workflow's `workflowConfig` and gate behaviors
   * like Linear activity streaming on the author's per-workflow preference.
   *
   * Plan: runs/2026-05-27-linear-agentsession-integration-plan.md §2.10 (F2)
   */
  workflowInstanceId?: string

  /**
   * The session row's OWN storage id, derived from its Redis key at read time.
   *
   * Normally equals `trackerSessionId`. It differs for per-dispatch rows:
   * a dispatcher may create a row under its own UUID key and later patch the
   * stored `trackerSessionId` to a shared tracker session. Every lifecycle
   * write (claim/start/complete/requeue) keys off `trackerSessionId`, so
   * such rows can only ever be updated under THIS id. Read paths
   * (`getSessionState`, `getAllSessions`, `getSessionStateByIssue`) always
   * repopulate it from the actual key, so a stale persisted value can never
   * mask the true row identity.
   */
  rowSessionId?: string

  /**
   * Why the session was stopped. Set when orphan cleanup terminal-marks a
   * stranded per-dispatch row that can no longer make progress.
   */
  stoppedReason?: string
}

/**
 * Key prefix for session state in KV
 */
const SESSION_KEY_PREFIX = 'agent:session:'

/**
 * Session state TTL in seconds (24 hours)
 * Sessions older than this are automatically cleaned up by KV
 */
const SESSION_TTL_SECONDS = 24 * 60 * 60

/**
 * Atomically advance the worker-owned lifecycle stored as one Redis JSON row.
 *
 * Both transitions execute their predicate and write in the same Redis command:
 * - claim: pending -> claimed, binding workerId and sampling claimedAt once
 * - start: claimed -> running, only for that worker and with claimedAt present
 *
 * Keeping start conditional is load-bearing. A delayed start that read pending
 * before another worker claimed the row must never overwrite the durable claim
 * with a running snapshot that has no claimedAt or the wrong owner.
 */
const ATOMIC_WORKER_LIFECYCLE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end

local decoded, session = pcall(cjson.decode, raw)
if not decoded or type(session) ~= 'table' then return -2 end

local transition = ARGV[1]
local workerId = ARGV[2]
local value = ARGV[3]
local now = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])
if not now or not ttlSeconds then return -2 end

if transition == 'claim' then
  if session.status ~= 'pending' then return 0 end
  session.status = 'claimed'
  session.workerId = workerId
  session.claimedAt = now
elseif transition == 'start' then
  if session.status ~= 'claimed' then return 0 end
  if session.workerId ~= workerId then return 0 end
  if type(session.claimedAt) ~= 'number' then return 0 end
  session.status = 'running'
  session.worktreePath = value
else
  return -2
end

if not session.trackerSessionId and session.linearSessionId then
  session.trackerSessionId = session.linearSessionId
end
if not session.trackerProvider then
  session.trackerProvider = 'linear'
end
session.updatedAt = now

redis.call('SETEX', KEYS[1], ttlSeconds, cjson.encode(session))
return 1
`

/**
 * Lossless raw-string compare-and-set for one session row.
 *
 * Reads the exact stored bytes, applies the patch in JS (where JSON keeps
 * nested empty arrays and full numeric precision), then commits with a Lua
 * guard that writes only when the row still holds those exact bytes. A
 * mismatch means a concurrent writer won: nothing is written and the patch
 * is rebuilt from the fresh row, bounded by CAS_MAX_ATTEMPTS. A transport
 * failure is never silently retried here — the caller sees the error rather
 * than risking a duplicate commit of a non-idempotent write.
 *
 * Returns true on commit, false when the row is missing (before or during
 * the write). Throws on malformed rows instead of rewriting them.
 */
const ATOMIC_RAW_CAS_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
if raw ~= ARGV[1] then return 0 end
redis.call('SETEX', KEYS[1], tonumber(ARGV[3]), ARGV[2])
return 1
`

const CAS_MAX_ATTEMPTS = 8

async function casSessionRow(
  key: string,
  sessionId: string,
  verb: string,
  mutate: (current: AgentSessionState, now: number) => AgentSessionState,
  onAttempt?: (current: AgentSessionState) => void
): Promise<boolean> {
  const redis = getRedisClient()
  for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS; attempt += 1) {
    const observed = await redis.get(key)
    if (observed === null) {
      return false
    }
    let current: unknown
    try {
      current = JSON.parse(observed)
    } catch {
      throw new Error(
        `Session row for ${sessionId} is malformed; refusing ${verb}`
      )
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error(
        `Session row for ${sessionId} is malformed; refusing ${verb}`
      )
    }
    const now = Date.now()
    onAttempt?.(current as AgentSessionState)
    const desired = JSON.stringify(mutate(current as AgentSessionState, now))
    const result = await redisEval(
      ATOMIC_RAW_CAS_SCRIPT,
      [key],
      [observed, desired, SESSION_TTL_SECONDS]
    )
    if (result === 1) {
      return true
    }
    if (result === -1) {
      return false
    }
    // result === 0: a concurrent writer replaced the row after our read and
    // this attempt wrote nothing — rebuild the patch from a fresh read.
  }
  throw new Error(
    `Session row for ${sessionId} changed under concurrent writers; refusing ${verb} after ${CAS_MAX_ATTEMPTS} attempts`
  )
}

/**
 * Historical note: earlier revisions of this change decoded/re-encoded the
 * whole row inside Lua (cjson), which changed untouched nested `[]` to `{}`
 * and rounded precise numbers. All metadata writers now use the lossless
 * raw-string CAS helper above; the only Lua that still decodes a row is the
 * pre-existing claim/start lifecycle script, whose authority is unchanged.
 * The retired script constants below are kept (unused) so the diff reviews
 * as deletion-only and no other module can still reference the old path.
 */
const ATOMIC_SESSION_PATCH_SCRIPT: string = 'retired: metadata writes use raw-string CAS'
const ATOMIC_SESSION_STATUS_SCRIPT: string = 'retired: status writes use raw-string CAS'
const ATOMIC_SESSION_TOUCH_SCRIPT: string = 'retired: heartbeat writes use raw-string CAS'
const ATOMIC_SESSION_RESET_SCRIPT: string = 'retired: reset writes use raw-string CAS'
const ATOMIC_SESSION_TRANSFER_SCRIPT: string = 'retired: transfer writes use raw-string CAS'

/**
 * Build the KV key for a session
 */
function buildSessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`
}

/**
 * Migrate legacy Redis data written before.
 *
 * legacy workers stored sessions with `linearSessionId` as the primary
 * field. This helper promotes the value to `trackerSessionId` / `trackerProvider`
 * so all code can use the new shape uniformly.  The raw `linearSessionId` field
 * is left in place so it can still satisfy the deprecated optional.
 */
function migrateSessionState(raw: AgentSessionState): AgentSessionState {
  if (!raw.trackerSessionId && raw.linearSessionId) {
    return {
      ...raw,
      trackerSessionId: raw.linearSessionId,
      trackerProvider: raw.trackerProvider ?? 'linear',
    }
  }
  if (!raw.trackerProvider) {
    return { ...raw, trackerProvider: 'linear' }
  }
  return raw
}

/**
 * Hydrate a raw Redis value into session state, stamping the row's own id
 * (derived from the Redis key it was read from). Always overwrites any
 * persisted `rowSessionId` — the key is the source of truth.
 */
function hydrateSessionState(
  raw: AgentSessionState,
  rowSessionId: string
): AgentSessionState {
  return { ...migrateSessionState(raw), rowSessionId }
}

/**
 * Store agent session state in Redis
 *
 * @param sessionId - The tracker session ID (Linear AgentSession ID or self-dispatched UUID)
 * @param state - The session state to store
 */
export async function storeSessionState(
  sessionId: string,
  state: Omit<AgentSessionState, 'trackerSessionId' | 'createdAt' | 'updatedAt' | 'trackerProvider'> & {
    trackerProvider?: AgentSessionState['trackerProvider']
  }
): Promise<AgentSessionState> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, session state will not be persisted')
    const now = Date.now()
    return {
      ...state,
      trackerSessionId: sessionId,
      trackerProvider: state.trackerProvider ?? 'linear',
      rowSessionId: sessionId,
      createdAt: now,
      updatedAt: now,
    }
  }

  const now = Date.now()
  const key = buildSessionKey(sessionId)

  // Check for existing session to preserve createdAt
  const rawExisting = await redisGet<AgentSessionState>(key)
  const existing = rawExisting ? migrateSessionState(rawExisting) : null

  const sessionState: AgentSessionState = {
    ...state,
    trackerSessionId: sessionId,
    trackerProvider: state.trackerProvider ?? 'linear',
    rowSessionId: sessionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await redisSet(key, sessionState, SESSION_TTL_SECONDS)

  log.info('Stored session state', {
    sessionId,
    issueId: state.issueId,
    status: state.status,
    hasProviderSessionId: !!state.providerSessionId,
  })

  return sessionState
}

/**
 * Retrieve agent session state from Redis
 *
 * @param sessionId - The tracker session ID
 * @returns The session state or null if not found
 */
export async function getSessionState(
  sessionId: string
): Promise<AgentSessionState | null> {
  if (!isRedisConfigured()) {
    log.debug('Redis not configured, cannot retrieve session state')
    return null
  }

  const key = buildSessionKey(sessionId)
  const raw = await redisGet<AgentSessionState>(key)
  const state = raw ? hydrateSessionState(raw, sessionId) : null

  if (state) {
    log.debug('Retrieved session state', {
      sessionId,
      issueId: state.issueId,
      status: state.status,
    })
  }

  return state
}

/**
 * Update the provider session ID for a session
 * Called when the Claude init event is received with the session ID
 *
 * @param sessionId - The tracker session ID
 * @param providerSessionId - The Provider CLI session ID
 */
export async function updateProviderSessionId(
  sessionId: string,
  providerSessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update provider session ID')
    return false
  }

  const key = buildSessionKey(sessionId)

  const committed = await casSessionRow(
    key,
    sessionId,
    'provider session ID update',
    (current, now) => {
      const next: AgentSessionState = {
        ...current,
        providerSessionId,
        updatedAt: now,
      }
      if (!next.trackerSessionId && next.linearSessionId) {
        next.trackerSessionId = next.linearSessionId
      }
      if (!next.trackerProvider) {
        next.trackerProvider = 'linear'
      }
      return next
    }
  )
  if (!committed) {
    log.warn('Session not found for provider session ID update', { sessionId })
    return false
  }

  log.info('Updated provider session ID', { sessionId, providerSessionId })

  return true
}

/**
 * Update session status
 *
 * @param sessionId - The tracker session ID
 * @param status - The new status
 */
export async function updateSessionStatus(
  sessionId: string,
  status: AgentSessionState['status'],
  options?: { stoppedReason?: string }
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update session status')
    return false
  }

  const key = buildSessionKey(sessionId)

  const committed = await casSessionRow(
    key,
    sessionId,
    'status update',
    (current, now) => {
      const next: AgentSessionState = {
        ...current,
        status,
        ...(options?.stoppedReason ? { stoppedReason: options.stoppedReason } : {}),
        updatedAt: now,
      }
      if (!next.trackerSessionId && next.linearSessionId) {
        next.trackerSessionId = next.linearSessionId
      }
      if (!next.trackerProvider) {
        next.trackerProvider = 'linear'
      }
      return next
    }
  )
  if (!committed) {
    log.warn('Session not found for status update', { sessionId })
    return false
  }

  log.info('Updated session status', { sessionId, status })

  return true
}

/**
 * Update session cost data (tokens and USD)
 *
 * @param sessionId - The tracker session ID
 * @param costData - Cost fields to persist
 */
export async function updateSessionCostData(
  sessionId: string,
  costData: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number }
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update session cost data')
    return false
  }

  const key = buildSessionKey(sessionId)

  let prevTotalCostUsd = 0
  let projectName: string | undefined
  const committed = await casSessionRow(
    key,
    sessionId,
    'cost update',
    (current, now) => {
      const next: AgentSessionState = { ...current, updatedAt: now }
      if (costData.totalCostUsd !== undefined) next.totalCostUsd = costData.totalCostUsd
      if (costData.inputTokens !== undefined) next.inputTokens = costData.inputTokens
      if (costData.outputTokens !== undefined) next.outputTokens = costData.outputTokens
      if (!next.trackerSessionId && next.linearSessionId) {
        next.trackerSessionId = next.linearSessionId
      }
      if (!next.trackerProvider) {
        next.trackerProvider = 'linear'
      }
      return next
    },
    (current) => {
      // Snapshot the pre-patch total from the compared row, so the quota
      // delta is computed against the state this write actually replaced.
      // Rebuilt on every attempt; only the winning attempt's values are used.
      prevTotalCostUsd = current.totalCostUsd ?? 0
      projectName = current.projectName
    }
  )
  if (!committed) {
    log.warn('Session not found for cost update', { sessionId })
    return false
  }

  // Fleet quota: track the incremental delta against the compared snapshot.
  // Fires only after a confirmed commit, so an ambiguous transport error
  // can never double-count a possibly committed write.
  if (costData.totalCostUsd != null) {
    onCostUpdated(projectName, prevTotalCostUsd, costData.totalCostUsd).catch(
      (err) => {
        log.error('Fleet quota onCostUpdated failed', { sessionId, error: err })
      }
    )
  }

  log.info('Updated session cost data', {
    sessionId,
    totalCostUsd: costData.totalCostUsd,
  })

  return true
}

/**
 * Refresh a session row's `updatedAt` to mark it live, without touching status.
 *
 * Called from the per-step heartbeat loop so a long-running session keeps its
 * row fresh while the runner is alive. Without this, a session that runs longer
 * than the orphan-cleanup staleness threshold (5 min) would have a stale row
 * `updatedAt` and be mistaken for a strand — the exact regression that reaped
 * real agent runs at ~5 minutes.
 *
 * This is the lifecycle half of the strand-safety fix; the orphan sweep's
 * heartbeat-pointer probe is the authoritative half. Together they ensure a
 * live row is never reaped: the row stays fresh AND its liveness is provable.
 *
 * Best-effort and cheap: one atomic Lua mutation keyed off the session id.
 * Returns false (without throwing) when the row is absent, terminal, or
 * Redis is unconfigured, so a heartbeat tick is never disturbed by this
 * write. Malformed rows surface as an error only if Redis itself reports
 * one; a stored non-JSON string yields the script's -2 sentinel which the
 * caller treats as a non-refresh so the pointer path still proves liveness.
 *
 * @param sessionId - The session ID the worker runs/heartbeats under
 */
export async function touchSessionHeartbeat(
  sessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildSessionKey(sessionId)
  const redis = getRedisClient()
  const observed = await redis.get(key)
  if (observed === null) {
    // No row under this id — the heartbeat pointer still proves liveness.
    return false
  }
  let current: AgentSessionState
  try {
    const parsed: unknown = JSON.parse(observed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return false
    }
    current = parsed as AgentSessionState
  } catch {
    // A corrupt row must never disturb the heartbeat loop.
    return false
  }
  // Only refresh non-terminal rows. Touching a terminal row would resurrect
  // a dead session's freshness; the predicate below runs against the same
  // compared snapshot the CAS guard commits, so a terminal commit racing
  // this read wins the predicate race on retry instead of being revived.
  const terminal =
    current.status === 'completed' ||
    current.status === 'failed' ||
    current.status === 'stopped' ||
    current.status === 'timed_out'
  if (terminal) {
    return false
  }
  const desired = JSON.stringify({
    ...current,
    updatedAt: Date.now(),
    trackerProvider: current.trackerProvider ?? 'linear',
    trackerSessionId:
      current.trackerSessionId ?? current.linearSessionId ?? sessionId,
  })
  const result = await redisEval(
    ATOMIC_RAW_CAS_SCRIPT,
    [key],
    [observed, desired, SESSION_TTL_SECONDS]
  )
  if (result === 1) {
    return true
  }
  // Lost the race (row replaced or deleted after our read) or hit a
  // terminal row committed concurrently: report a non-refresh. The retry
  // path that could re-read a now-terminal row as live is deliberately not
  // taken — a heartbeat tick must never revive a dead row.
  return false
}

/**
 * Reset a session for re-queuing after orphan cleanup
 * Clears workerId and resets status to pending so a new worker can claim it
 *
 * @param sessionId - The tracker session ID
 */
export async function resetSessionForRequeue(
  sessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot reset session')
    return false
  }

  const key = buildSessionKey(sessionId)

  let previousWorkerId: unknown
  const committed = await casSessionRow(
    key,
    sessionId,
    'reset',
    (current, now) => {
      const next: AgentSessionState = {
        ...current,
        status: 'pending',
        updatedAt: now,
      }
      // Clear the binding the same way JSON serialization drops undefined:
      // absent keys stay absent, so a reset never writes a literal null
      // where the row previously had no owner.
      delete next.workerId
      delete next.claimedAt
      if (!next.trackerSessionId && next.linearSessionId) {
        next.trackerSessionId = next.linearSessionId
      }
      if (!next.trackerProvider) {
        next.trackerProvider = 'linear'
      }
      return next
    },
    (current) => {
      previousWorkerId = current.workerId
    }
  )
  if (!committed) {
    log.warn('Session not found for reset', { sessionId })
    return false
  }

  log.info('Reset session for requeue', {
    sessionId,
    previousWorkerId,
  })

  return true
}

/**
 * Delete session state from KV
 *
 * @param sessionId - The tracker session ID
 * @returns Whether the deletion was successful
 */
export async function deleteSessionState(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildSessionKey(sessionId)
  const result = await redisDel(key)

  log.info('Deleted session state', { sessionId })

  return result > 0
}

/**
 * Get session state by issue ID
 * Useful when we have the issue but not the session ID
 *
 * When multiple sessions exist for the same issue (e.g., one running + several
 * failed), this function returns the most relevant one — preferring active
 * sessions (running/claimed/pending) over inactive ones. Without this
 * prioritization, an arbitrary first-match could hide a running session behind
 * a failed one, causing the governor to re-dispatch work for an issue that
 * already has an agent in-flight.
 *
 * @param issueId - The Linear issue ID
 * @returns The most relevant session state for this issue or null
 */
export async function getSessionStateByIssue(
  issueId: string
): Promise<AgentSessionState | null> {
  if (!isRedisConfigured()) {
    return null
  }

  // Scan for sessions with this issue ID
  // Note: This is less efficient than direct lookup, use sparingly
  const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  const activeStatuses = ['running', 'claimed', 'pending']
  let fallback: AgentSessionState | null = null

  for (const key of keys) {
    const raw = await redisGet<AgentSessionState>(key)
    const state = raw
      ? hydrateSessionState(raw, key.slice(SESSION_KEY_PREFIX.length))
      : null
    if (state?.issueId === issueId) {
      // Prefer active sessions — return immediately if found
      if (activeStatuses.includes(state.status)) {
        return state
      }
      // Keep first non-active match as fallback
      if (!fallback) {
        fallback = state
      }
    }
  }

  return fallback
}

// ============================================
// Worker Pool Operations
// ============================================

/**
 * Mark a session as claimed by a worker
 *
 * @param sessionId - The tracker session ID
 * @param workerId - The worker claiming the session
 */
export async function claimSession(
  sessionId: string,
  workerId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const result = await redisEval(
    ATOMIC_WORKER_LIFECYCLE_SCRIPT,
    [key],
    ['claim', workerId, '', now, SESSION_TTL_SECONDS]
  )
  if (result !== 1) {
    log.warn('Session claim transition rejected', {
      sessionId,
      workerId,
      result,
    })
    return false
  }

  log.info('Session claimed', { sessionId, workerId })

  return true
}

/**
 * Update session with worker info when work starts
 *
 * @param sessionId - The tracker session ID
 * @param workerId - The worker processing the session
 * @param worktreePath - Path to the git worktree
 */
export async function startSession(
  sessionId: string,
  workerId: string,
  worktreePath: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const result = await redisEval(
    ATOMIC_WORKER_LIFECYCLE_SCRIPT,
    [key],
    ['start', workerId, worktreePath, now, SESSION_TTL_SECONDS]
  )
  if (result !== 1) {
    log.warn('Session start transition rejected', {
      sessionId,
      workerId,
      result,
    })
    return false
  }

  log.info('Session started', { sessionId, workerId, worktreePath })

  return true
}

/**
 * Get all sessions from Redis
 * For dashboard display
 */
export async function getAllSessions(): Promise<AgentSessionState[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
    const sessions: AgentSessionState[] = []

    for (const key of keys) {
      const raw = await redisGet<AgentSessionState>(key)
      if (raw) {
        sessions.push(hydrateSessionState(raw, key.slice(SESSION_KEY_PREFIX.length)))
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    return sessions
  } catch (error) {
    log.error('Failed to get all sessions', { error })
    return []
  }
}

/**
 * Get sessions by status
 */
export async function getSessionsByStatus(
  status: AgentSessionStatus | AgentSessionStatus[]
): Promise<AgentSessionState[]> {
  const allSessions = await getAllSessions()
  const statusArray = Array.isArray(status) ? status : [status]
  return allSessions.filter((s) => statusArray.includes(s.status))
}

/**
 * Transfer session ownership to a new worker
 * Used when a worker re-registers after disconnection and gets a new ID
 *
 * @param sessionId - The tracker session ID
 * @param newWorkerId - The new worker ID to assign
 * @param oldWorkerId - The previous worker ID (for validation)
 * @returns Whether the transfer was successful
 */
export async function transferSessionOwnership(
  sessionId: string,
  newWorkerId: string,
  oldWorkerId: string
): Promise<{ transferred: boolean; reason?: string }> {
  if (!isRedisConfigured()) {
    return { transferred: false, reason: 'Redis not configured' }
  }

  const key = buildSessionKey(sessionId)

  // Null/undefined/empty means unowned: the transfer proceeds, preserving
  // the previous behavior for rows that never recorded an owner. A real
  // mismatched owner refuses BEFORE any write — not even a reserialized
  // SETEX — so a rejection changes neither bytes nor TTL, and the reported
  // reason always agrees with the snapshot this attempt observed.
  const redis = getRedisClient()
  const observed = await redis.get(key)
  if (observed === null) {
    return { transferred: false, reason: 'Session not found' }
  }
  let current: AgentSessionState
  try {
    const parsed: unknown = JSON.parse(observed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('malformed')
    }
    current = parsed as AgentSessionState
  } catch {
    throw new Error(
      `Session row for ${sessionId} is malformed; refusing ownership transfer`
    )
  }
  const owner = current.workerId
  const unowned = owner === null || owner === undefined || owner === ''
  if (!unowned && owner !== oldWorkerId) {
    log.warn('Session ownership transfer rejected - worker ID mismatch', {
      sessionId,
      expectedWorkerId: oldWorkerId,
      actualWorkerId: owner,
    })
    return {
      transferred: false,
      reason: `Session owned by different worker: ${owner}`,
    }
  }
  const now = Date.now()
  const next: AgentSessionState = {
    ...current,
    workerId: newWorkerId,
    updatedAt: now,
  }
  if (!next.trackerSessionId && next.linearSessionId) {
    next.trackerSessionId = next.linearSessionId
  }
  if (!next.trackerProvider) {
    next.trackerProvider = 'linear'
  }
  const desired = JSON.stringify(next)
  const result = await redisEval(
    ATOMIC_RAW_CAS_SCRIPT,
    [key],
    [observed, desired, SESSION_TTL_SECONDS]
  )
  if (result === -1) {
    return { transferred: false, reason: 'Session not found' }
  }
  if (result !== 1) {
    // Lost the race after observing an eligible owner: report the conflict
    // against a fresh read rather than the stale snapshot.
    const fresh = await getSessionState(sessionId)
    const actual = fresh?.workerId ?? owner
    log.warn('Session ownership transfer lost race', {
      sessionId,
      expectedWorkerId: oldWorkerId,
      actualWorkerId: actual,
    })
    return {
      transferred: false,
      reason: `Session owned by different worker: ${actual}`,
    }
  }

  log.info('Session ownership transferred', {
    sessionId,
    oldWorkerId,
    newWorkerId,
  })

  return { transferred: true }
}
