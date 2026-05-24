/**
 * Merge Queue Runner -- Programmatic API for the merge-queue CLI.
 *
 * Extracts ALL command handlers from the merge-queue bin script so they can be
 * invoked programmatically (e.g. from a Next.js route handler or test) without
 * process.exit / dotenv / argv coupling.
 */

import {
  MergeQueueStorage,
  isRedisConfigured,
  disconnectRedis,
  redisSet,
  redisDel,
  type MergeQueueEntry,
} from '@donmai/server'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MergeQueueCommand =
  | 'status'
  | 'list'
  | 'retry'
  | 'skip'
  | 'pause'
  | 'resume'
  | 'priority'

export interface MergeQueueRunnerConfig {
  /** Command to execute */
  command: MergeQueueCommand
  /** Remaining CLI arguments (flags, positional args) */
  args: string[]
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureRedis(): void {
  if (!isRedisConfigured()) {
    throw new Error('REDIS_URL environment variable is not set')
  }
}

export function parseArgs(args: string[]): { repoId: string; prNumber?: number; priority?: number } {
  let repoId = 'default'
  let prNumber: number | undefined
  let priority: number | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) {
      repoId = args[i + 1]
      i++
    } else if (prNumber === undefined && /^\d+$/.test(args[i])) {
      prNumber = parseInt(args[i], 10)
    } else if (prNumber !== undefined && priority === undefined && /^\d+$/.test(args[i])) {
      priority = parseInt(args[i], 10)
    }
  }

  return { repoId, prNumber, priority }
}

export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleStatus(storage: MergeQueueStorage, repoId: string): Promise<void> {
  const status = await storage.getStatus(repoId)

  console.log(`\n${C.bold}Merge Queue Status${C.reset} (repo: ${C.cyan}${repoId}${C.reset})`)
  console.log('\u2500'.repeat(50))
  console.log(`  Queue depth:    ${C.bold}${status.depth}${C.reset}`)
  console.log(
    `  Processing:     ${
      status.processing
        ? `${C.green}PR #${status.processing.prNumber}${C.reset} (${status.processing.sourceBranch})`
        : `${C.dim}none${C.reset}`
    }`,
  )
  console.log(
    `  Failed:         ${status.failedCount > 0 ? `${C.red}${status.failedCount}${C.reset}` : `${C.dim}0${C.reset}`}`,
  )
  console.log(
    `  Blocked:        ${status.blockedCount > 0 ? `${C.yellow}${status.blockedCount}${C.reset}` : `${C.dim}0${C.reset}`}`,
  )
  console.log()
}

async function handleList(storage: MergeQueueStorage, repoId: string): Promise<void> {
  const entries = await storage.list(repoId)

  if (entries.length === 0) {
    console.log(`\n${C.dim}No PRs in merge queue for repo: ${repoId}${C.reset}\n`)
    return
  }

  console.log(`\n${C.bold}Queued PRs${C.reset} (repo: ${C.cyan}${repoId}${C.reset})`)
  console.log('\u2500'.repeat(70))
  console.log(`  ${C.dim}#     PR     Branch                          Priority  Age${C.reset}`)
  console.log('\u2500'.repeat(70))

  entries.forEach((entry: MergeQueueEntry, index: number) => {
    const age = formatAge(Date.now() - entry.enqueuedAt)
    const branch =
      entry.sourceBranch.length > 30
        ? entry.sourceBranch.slice(0, 27) + '...'
        : entry.sourceBranch.padEnd(30)
    console.log(
      `  ${String(index + 1).padStart(2)}    ${C.bold}#${String(entry.prNumber).padEnd(4)}${C.reset} ${branch}  ${entry.priority}         ${age}`,
    )
  })

  // Also show failed
  const failed = await storage.listFailed(repoId)
  if (failed.length > 0) {
    console.log(`\n${C.red}${C.bold}Failed PRs${C.reset}`)
    console.log('\u2500'.repeat(70))
    failed.forEach((entry: MergeQueueEntry & { failureReason: string }) => {
      console.log(
        `  ${C.red}#${entry.prNumber}${C.reset} ${entry.sourceBranch} \u2014 ${entry.failureReason}`,
      )
    })
  }

  // Show blocked
  const blocked = await storage.listBlocked(repoId)
  if (blocked.length > 0) {
    console.log(`\n${C.yellow}${C.bold}Blocked PRs${C.reset}`)
    console.log('\u2500'.repeat(70))
    blocked.forEach((entry: MergeQueueEntry & { blockReason: string }) => {
      console.log(
        `  ${C.yellow}#${entry.prNumber}${C.reset} ${entry.sourceBranch} \u2014 ${entry.blockReason}`,
      )
    })
  }

  console.log()
}

async function handleRetry(storage: MergeQueueStorage, repoId: string, prNumber: number): Promise<void> {
  await storage.retry(repoId, prNumber)
  console.log(`${C.green}PR #${prNumber} moved back to queue${C.reset}`)
}

async function handleSkip(storage: MergeQueueStorage, repoId: string, prNumber: number): Promise<void> {
  await storage.skip(repoId, prNumber)
  console.log(`${C.yellow}PR #${prNumber} removed from queue${C.reset}`)
}

async function handlePause(repoId: string): Promise<void> {
  await redisSet(`merge:paused:${repoId}`, 'true')
  console.log(`${C.yellow}Merge queue paused for repo: ${repoId}${C.reset}`)
}

async function handleResume(repoId: string): Promise<void> {
  await redisDel(`merge:paused:${repoId}`)
  console.log(`${C.green}Merge queue resumed for repo: ${repoId}${C.reset}`)
}

async function handlePriority(
  storage: MergeQueueStorage,
  repoId: string,
  prNumber: number,
  priority: number,
): Promise<void> {
  await storage.reorder(repoId, prNumber, priority)
  console.log(`${C.green}PR #${prNumber} priority updated to ${priority}${C.reset}`)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a merge-queue command programmatically.
 *
 * Throws if REDIS_URL is not set or if required arguments are missing.
 */
export async function runMergeQueueCommand(config: MergeQueueRunnerConfig): Promise<void> {
  ensureRedis()

  const storage = new MergeQueueStorage()
  const { repoId, prNumber, priority } = parseArgs(config.args)

  try {
    switch (config.command) {
      case 'status':
        await handleStatus(storage, repoId)
        break
      case 'list':
        await handleList(storage, repoId)
        break
      case 'retry':
        if (!prNumber) {
          console.error(
            `${C.red}Error: PR number required. Usage: af merge-queue retry <prNumber>${C.reset}`,
          )
          process.exit(1)
        }
        await handleRetry(storage, repoId, prNumber)
        break
      case 'skip':
        if (!prNumber) {
          console.error(
            `${C.red}Error: PR number required. Usage: af merge-queue skip <prNumber>${C.reset}`,
          )
          process.exit(1)
        }
        await handleSkip(storage, repoId, prNumber)
        break
      case 'pause':
        await handlePause(repoId)
        break
      case 'resume':
        await handleResume(repoId)
        break
      case 'priority':
        if (!prNumber || priority === undefined) {
          console.error(
            `${C.red}Error: PR number and priority required. Usage: af merge-queue priority <prNumber> <priority>${C.reset}`,
          )
          process.exit(1)
        }
        await handlePriority(storage, repoId, prNumber, priority)
        break
    }
  } finally {
    await disconnectRedis()
  }
}
