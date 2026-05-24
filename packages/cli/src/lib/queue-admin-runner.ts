/**
 * Queue Admin Runner -- Programmatic API for the queue admin CLI.
 *
 * Extracts ALL command handlers from the queue-admin bin script so they can be
 * invoked programmatically (e.g. from a Next.js route handler or test) without
 * process.exit / dotenv / argv coupling.
 */

import {
  getRedisClient,
  redisKeys,
  redisDel,
  redisGet,
  redisSet,
  redisZRangeByScore,
  redisZRem,
  redisHGetAll,
  disconnectRedis,
} from '@donmai/server'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type QueueAdminCommand =
  | 'list'
  | 'sessions'
  | 'workers'
  | 'clear-claims'
  | 'clear-queue'
  | 'clear-all'
  | 'reset'
  | 'remove'

export interface QueueAdminRunnerConfig {
  /** Command to execute */
  command: QueueAdminCommand
  /** Session ID for 'remove' command (partial match) */
  sessionId?: string
}

// ---------------------------------------------------------------------------
// Redis key constants
// ---------------------------------------------------------------------------

const WORK_QUEUE_KEY = 'work:queue'
const WORK_ITEMS_KEY = 'work:items'
const WORK_CLAIM_PREFIX = 'work:claim:'
const SESSION_KEY_PREFIX = 'agent:session:'
const WORKER_PREFIX = 'work:worker:'

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
  // Initialize the Redis client
  getRedisClient()
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function listQueue(): Promise<void> {
  ensureRedis()

  // Get items from sorted set (current queue format)
  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  const workItemCount = Object.keys(workItems).length

  console.log(`\n${C.cyan}Work Queue${C.reset} (${Math.max(queuedSessionIds.length, workItemCount)} items):`)
  console.log('='.repeat(60))

  if (workItemCount === 0 && queuedSessionIds.length === 0) {
    console.log('(empty)')
  } else {
    for (const [sessionId, itemJson] of Object.entries(workItems)) {
      try {
        const work = JSON.parse(itemJson) as {
          issueIdentifier?: string
          priority?: number
          queuedAt?: number
          workType?: string
          prompt?: string
          providerSessionId?: string
        }
        console.log(`- ${work.issueIdentifier ?? sessionId.slice(0, 8)} (session: ${sessionId.slice(0, 8)}...)`)
        console.log(`  Priority: ${work.priority ?? 'none'}, WorkType: ${work.workType ?? 'development'}`)
        if (work.queuedAt) {
          console.log(`  Queued: ${new Date(work.queuedAt).toISOString()}`)
        }
        if (work.providerSessionId) {
          console.log(`  ${C.yellow}Has providerSessionId: ${work.providerSessionId.substring(0, 12)}${C.reset}`)
        }
        if (work.prompt) {
          console.log(`  Prompt: "${work.prompt.slice(0, 50)}..."`)
        }
      } catch {
        console.log(`- [invalid JSON]: ${sessionId}`)
      }
    }
  }

  await disconnectRedis()
}

async function listSessions(): Promise<void> {
  ensureRedis()

  const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)

  console.log(`\n${C.cyan}Sessions${C.reset} (${keys.length} total):`)
  console.log('='.repeat(60))

  if (keys.length === 0) {
    console.log('(none)')
  } else {
    for (const key of keys) {
      const session = await redisGet<{
        status: string
        issueIdentifier?: string
        issueId: string
        trackerSessionId?: string
        /** @deprecated use trackerSessionId */
        linearSessionId?: string
        updatedAt: number
        workerId?: string
        workType?: string
      }>(key)

      if (session) {
        const statusColors: Record<string, string> = {
          pending: C.yellow,
          claimed: C.cyan,
          running: C.cyan,
          completed: C.green,
          failed: C.red,
          stopped: C.yellow,
        }
        const statusColor = statusColors[session.status] || ''
        const sessionId = session.trackerSessionId ?? session.linearSessionId ?? 'unknown'

        console.log(`- ${session.issueIdentifier || session.issueId.slice(0, 8)} [${statusColor}${session.status}${C.reset}]`)
        console.log(`  Session: ${sessionId.slice(0, 12)}...`)
        if (session.workType) {
          console.log(`  WorkType: ${session.workType}`)
        }
        console.log(`  Updated: ${new Date(session.updatedAt * 1000).toISOString()}`)
        if (session.workerId) {
          console.log(`  Worker: ${session.workerId}`)
        }
      }
    }
  }

  await disconnectRedis()
}

async function listWorkersFn(): Promise<void> {
  ensureRedis()

  const keys = await redisKeys(`${WORKER_PREFIX}*`)

  console.log(`\n${C.cyan}Workers${C.reset} (${keys.length} total):`)
  console.log('='.repeat(60))

  if (keys.length === 0) {
    console.log('(none)')
  } else {
    for (const key of keys) {
      const worker = await redisGet<{
        id: string
        hostname?: string
        status: string
        capacity?: number
        activeCount?: number
        lastHeartbeat?: number
      }>(key)

      if (worker) {
        const statusColor = worker.status === 'active' ? C.green : C.yellow
        console.log(`- ${worker.id.slice(0, 12)} [${statusColor}${worker.status}${C.reset}]`)
        if (worker.hostname) {
          console.log(`  Hostname: ${worker.hostname}`)
        }
        console.log(`  Capacity: ${worker.activeCount ?? 0}/${worker.capacity ?? '?'}`)
        if (worker.lastHeartbeat) {
          const ago = Math.round((Date.now() - worker.lastHeartbeat) / 1000)
          console.log(`  Last heartbeat: ${ago}s ago`)
        }
      }
    }
  }

  await disconnectRedis()
}

async function clearClaims(): Promise<void> {
  ensureRedis()

  console.log('Clearing work claims...')
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  console.log(`Found ${claimKeys.length} claim(s)`)

  if (claimKeys.length === 0) {
    console.log('No claims to clear')
    await disconnectRedis()
    return
  }

  let deleted = 0
  for (const key of claimKeys) {
    const result = await redisDel(key)
    if (result > 0) {
      console.log(`  Deleted: ${key}`)
      deleted++
    }
  }

  console.log(`\nCleared ${deleted} claim(s)`)
  await disconnectRedis()
}

async function clearQueue(): Promise<void> {
  ensureRedis()

  console.log('Clearing work queue...')

  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  console.log(`Found ${queuedSessionIds.length} item(s) in queue sorted set`)

  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  const workItemCount = Object.keys(workItems).length
  console.log(`Found ${workItemCount} item(s) in work items hash`)

  // Show what we're clearing
  for (const [sessionId, itemJson] of Object.entries(workItems)) {
    try {
      const work = JSON.parse(itemJson) as { issueIdentifier?: string; workType?: string; providerSessionId?: string }
      console.log(`  - ${work.issueIdentifier ?? sessionId.slice(0, 8)} (workType: ${work.workType || 'development'})`)
      if (work.providerSessionId) {
        console.log(`    ${C.yellow}Has providerSessionId: ${work.providerSessionId.substring(0, 12)}${C.reset}`)
      }
    } catch {
      console.log(`  - [invalid JSON]: ${sessionId}`)
    }
  }

  let cleared = 0
  if (queuedSessionIds.length > 0) {
    await redisDel(WORK_QUEUE_KEY)
    cleared++
  }
  if (workItemCount > 0) {
    await redisDel(WORK_ITEMS_KEY)
    cleared++
  }

  const totalItems = Math.max(queuedSessionIds.length, workItemCount)
  if (cleared > 0) {
    console.log(`\nCleared ${totalItems} item(s) from work queue`)
  } else {
    console.log('\nQueue was already empty')
  }

  await disconnectRedis()
}

async function clearAll(): Promise<void> {
  ensureRedis()

  console.log('Clearing ALL state...\n')

  // Clear work queue
  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  if (queuedSessionIds.length > 0) await redisDel(WORK_QUEUE_KEY)
  if (Object.keys(workItems).length > 0) await redisDel(WORK_ITEMS_KEY)
  console.log(`Cleared ${Math.max(queuedSessionIds.length, Object.keys(workItems).length)} queue items`)

  // Clear all sessions
  const sessionKeys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  for (const key of sessionKeys) {
    await redisDel(key)
  }
  console.log(`Cleared ${sessionKeys.length} sessions`)

  // Clear all claims
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  for (const key of claimKeys) {
    await redisDel(key)
  }
  console.log(`Cleared ${claimKeys.length} claims`)

  // Clear all workers
  const workerKeys = await redisKeys(`${WORKER_PREFIX}*`)
  for (const key of workerKeys) {
    await redisDel(key)
  }
  console.log(`Cleared ${workerKeys.length} worker registrations`)

  console.log('\nAll cleared!')
  await disconnectRedis()
}

async function resetWorkState(): Promise<void> {
  ensureRedis()

  console.log('Resetting work state...')
  console.log('-'.repeat(60))

  let totalCleared = 0

  // 1. Clear work claims
  console.log('\nClearing work claims...')
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  console.log(`  Found ${claimKeys.length} claim(s)`)
  for (const key of claimKeys) {
    const result = await redisDel(key)
    if (result > 0) {
      console.log(`  Deleted: ${key}`)
      totalCleared++
    }
  }

  // 2. Clear work queue
  console.log('\nClearing work queue...')
  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  console.log(`  Found ${queuedSessionIds.length} queued item(s) in sorted set`)

  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  const workItemCount = Object.keys(workItems).length
  console.log(`  Found ${workItemCount} item(s) in work items hash`)

  for (const [sessionId, itemJson] of Object.entries(workItems)) {
    try {
      const work = JSON.parse(itemJson) as { issueIdentifier?: string; workType?: string }
      console.log(`  - ${work.issueIdentifier ?? sessionId.slice(0, 8)} (workType: ${work.workType || 'development'})`)
    } catch {
      console.log(`  - [invalid item: ${sessionId}]`)
    }
  }

  if (queuedSessionIds.length > 0 || workItemCount > 0) {
    await redisDel(WORK_QUEUE_KEY)
    await redisDel(WORK_ITEMS_KEY)
    totalCleared += Math.max(queuedSessionIds.length, workItemCount)
    console.log(`  Cleared queue and items hash`)
  }

  // 3. Reset stuck sessions
  console.log('\nResetting stuck sessions...')
  const sessionKeys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  console.log(`  Found ${sessionKeys.length} session(s)`)

  let sessionsReset = 0
  for (const key of sessionKeys) {
    const session = await redisGet<{
      trackerSessionId?: string
      /** @deprecated use trackerSessionId */
      linearSessionId?: string
      issueIdentifier?: string
      status: string
      workerId?: string
      providerSessionId?: string
      [key: string]: unknown
    }>(key)

    if (!session) continue

    if (session.status === 'running' || session.status === 'claimed') {
      const sessionId = session.trackerSessionId ?? session.linearSessionId ?? 'unknown'
      console.log(`  Resetting: ${session.issueIdentifier || sessionId}`)
      console.log(`    Status: ${session.status}, WorkerId: ${session.workerId || 'none'}`)

      const updated = {
        ...session,
        status: 'pending',
        workerId: undefined,
        claimedAt: undefined,
        providerSessionId: undefined,
        updatedAt: Math.floor(Date.now() / 1000),
      }

      await redisSet(key, updated, 24 * 60 * 60)
      sessionsReset++
      console.log(`    Reset to pending`)
    }
  }

  console.log('\n' + '-'.repeat(60))
  console.log(`\nReset complete:`)
  console.log(`   - Claims cleared: ${claimKeys.length}`)
  console.log(`   - Queue items cleared: ${Math.max(queuedSessionIds.length, workItemCount)}`)
  console.log(`   - Sessions reset: ${sessionsReset}`)

  await disconnectRedis()
}

async function removeSession(sessionId: string): Promise<void> {
  ensureRedis()

  let found = false

  // Find session by partial ID match
  const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  for (const key of keys) {
    if (key.includes(sessionId)) {
      await redisDel(key)
      console.log(`Removed session: ${key.replace(SESSION_KEY_PREFIX, '')}`)
      found = true
    }
  }

  // Also remove from queue if present
  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  for (const [sid, itemJson] of Object.entries(workItems)) {
    if (sid.includes(sessionId)) {
      // Remove from hash via direct Redis command
      const redis = getRedisClient()
      await redis.hdel(WORK_ITEMS_KEY, sid)
      // Remove from sorted set
      await redisZRem(WORK_QUEUE_KEY, sid)
      const work = JSON.parse(itemJson) as { issueIdentifier?: string }
      console.log(`Removed from queue: ${work.issueIdentifier ?? sid.slice(0, 8)}`)
      found = true
    }
  }

  // Remove claim if present
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  for (const key of claimKeys) {
    if (key.includes(sessionId)) {
      await redisDel(key)
      console.log(`Removed claim: ${key}`)
      found = true
    }
  }

  if (!found) {
    console.log(`No session found matching: ${sessionId}`)
  }

  await disconnectRedis()
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a queue admin command programmatically.
 *
 * Throws if REDIS_URL is not set or if the 'remove' command is called without
 * a sessionId.
 */
export async function runQueueAdmin(config: QueueAdminRunnerConfig): Promise<void> {
  switch (config.command) {
    case 'list':
      await listQueue()
      break
    case 'sessions':
      await listSessions()
      break
    case 'workers':
      await listWorkersFn()
      break
    case 'clear-claims':
      await clearClaims()
      break
    case 'clear-queue':
      await clearQueue()
      break
    case 'clear-all':
      await clearAll()
      break
    case 'reset':
      await resetWorkState()
      break
    case 'remove':
      if (!config.sessionId) {
        throw new Error('remove command requires a sessionId')
      }
      await removeSession(config.sessionId)
      break
  }
}
