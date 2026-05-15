/**
 * Orphan Cleanup Module
 *
 * Detects and handles orphaned sessions - sessions marked as running/claimed
 * but whose worker is no longer active (heartbeat timeout).
 *
 * When a worker disconnects, the work is re-queued for another worker to resume.
 * The Linear issue status is NOT rolled back - the issue remains in its current
 * workflow state and the next worker will resume from where the previous one left off.
 */

import { createLogger } from './logger.js'
import {
  getAllSessions,
  resetSessionForRequeue,
  type AgentSessionState,
} from './session-storage.js'
import { listWorkers } from './worker-storage.js'
import {
  releaseClaim,
  isSessionInQueue,
  type QueuedWork,
} from './work-queue.js'
import {
  dispatchWork,
  cleanupExpiredLocksWithPendingWork,
  cleanupStaleLocksWithIdleWorkers,
  isSessionParkedForIssue,
  getIssueLock,
  releaseIssueLock,
} from './issue-lock.js'

const log = createLogger('orphan-cleanup')

// How long a session can be running without a valid worker before being considered orphaned
const ORPHAN_THRESHOLD_MS = 120_000 // 2 minutes (worker TTL + buffer)

/**
 * Callback for when an orphaned session is re-queued
 */
export interface OrphanCleanupCallbacks {
  /** Called when an orphaned session is re-queued. Use to post Linear comments, etc. */
  onOrphanRequeued?: (session: AgentSessionState) => Promise<void>
  /** Called when a zombie pending session is recovered. Use to post Linear comments, etc. */
  onZombieRecovered?: (session: AgentSessionState) => Promise<void>
}

export interface OrphanCleanupResult {
  checked: number
  orphaned: number
  requeued: number
  failed: number
  details: Array<{
    sessionId: string
    issueIdentifier: string
    action: 'requeued' | 'failed'
    reason?: string
    /** Path to worktree that may need cleanup (if on worker machine) */
    worktreePath?: string
  }>
  /** Worktree paths that need cleanup on worker machines */
  worktreePathsToCleanup: string[]
}

/**
 * Find sessions that are orphaned (running/claimed but worker is gone)
 */
export async function findOrphanedSessions(): Promise<AgentSessionState[]> {
  const [sessions, workers] = await Promise.all([
    getAllSessions(),
    listWorkers(),
  ])

  // Build set of active worker IDs
  const activeWorkerIds = new Set(
    workers
      .filter((w) => w.status === 'active')
      .map((w) => w.id)
  )

  const orphaned: AgentSessionState[] = []

  for (const session of sessions) {
    // Only check running or claimed sessions
    if (session.status !== 'running' && session.status !== 'claimed') {
      continue
    }

    // Grace period: skip sessions updated recently — prevents race when a worker
    // re-registers with a new ID but hasn't transferred session ownership yet
    const sessionAge = Date.now() - session.updatedAt
    if (sessionAge < ORPHAN_THRESHOLD_MS) {
      log.debug('Session recently updated, skipping orphan check', {
        sessionId: session.trackerSessionId,
        ageMs: sessionAge,
      })
      continue
    }

    // If session has no worker assigned, it's orphaned
    if (!session.workerId) {
      log.debug('Session has no worker assigned', {
        sessionId: session.trackerSessionId,
        status: session.status,
      })
      orphaned.push(session)
      continue
    }

    // If the assigned worker is no longer active, session is orphaned
    if (!activeWorkerIds.has(session.workerId)) {
      log.debug('Session worker is no longer active', {
        sessionId: session.trackerSessionId,
        workerId: session.workerId,
        status: session.status,
      })
      orphaned.push(session)
      continue
    }
  }

  return orphaned
}

// How long a pending session can exist without a queue entry before being considered a zombie
const ZOMBIE_PENDING_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Find zombie pending sessions — sessions stuck in `pending` status
 * that have no corresponding entry in the work queue or any issue-pending queue.
 *
 * These arise when:
 * - claimWork() removes from queue, but claimSession() fails and requeue also fails
 * - Issue lock expires but promotion fails silently
 */
export async function findZombiePendingSessions(): Promise<AgentSessionState[]> {
  const sessions = await getAllSessions()
  const now = Date.now()
  const zombies: AgentSessionState[] = []

  for (const session of sessions) {
    if (session.status !== 'pending') continue

    // Only consider sessions older than the threshold
    const age = now - session.updatedAt
    if (age < ZOMBIE_PENDING_THRESHOLD_MS) continue

    // Check if session is in the global work queue
    const inQueue = await isSessionInQueue(session.trackerSessionId)
    if (inQueue) continue

    // Check if session is parked in the issue-pending queue
    const parked = await isSessionParkedForIssue(
      session.issueId,
      session.trackerSessionId
    )
    if (parked) continue

    // Session is pending but not in any queue — it's a zombie
    log.warn('Found zombie pending session', {
      sessionId: session.trackerSessionId,
      issueIdentifier: session.issueIdentifier,
      ageMinutes: Math.round(age / 60_000),
    })
    zombies.push(session)
  }

  return zombies
}

/**
 * Clean up orphaned sessions by re-queuing them
 *
 * @param callbacks - Optional callbacks for external integrations (e.g., posting Linear comments)
 */
export async function cleanupOrphanedSessions(
  callbacks?: OrphanCleanupCallbacks
): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = {
    checked: 0,
    orphaned: 0,
    requeued: 0,
    failed: 0,
    details: [],
    worktreePathsToCleanup: [],
  }

  try {
    const sessions = await getAllSessions()
    result.checked = sessions.length

    const orphaned = await findOrphanedSessions()
    result.orphaned = orphaned.length

    if (orphaned.length > 0) {
      log.info('Found orphaned sessions', { count: orphaned.length })
    }

    for (const session of orphaned) {
      try {
        const issueIdentifier = session.issueIdentifier || session.issueId.slice(0, 8)

        log.info('Re-queuing orphaned session', {
          sessionId: session.trackerSessionId,
          issueIdentifier,
          previousWorker: session.workerId,
          previousStatus: session.status,
        })

        // Release any existing claim
        await releaseClaim(session.trackerSessionId)

        // Release the issue lock if held by this orphaned session.
        // Without this, dispatchWork() below would fail to acquire the lock
        // (SET NX) and park the work instead — leaving it stuck until the
        // lock's 2-hour TTL expires, since the session is reset to 'pending'
        // which the stale-lock cleanup doesn't consider terminal.
        const existingLock = await getIssueLock(session.issueId)
        if (existingLock && existingLock.sessionId === session.trackerSessionId) {
          log.info('Releasing issue lock held by orphaned session', {
            sessionId: session.trackerSessionId,
            issueId: session.issueId,
          })
          await releaseIssueLock(session.issueId)
        }

        // Reset session for requeue (clears workerId so new worker can claim)
        await resetSessionForRequeue(session.trackerSessionId)

        // Re-queue the work with higher priority
        // IMPORTANT: Preserve workType to prevent incorrect status transitions
        // NOTE: Do NOT preserve providerSessionId - the old session may be corrupted
        // from the crash that caused the orphan. Starting fresh is safer.
        const work: QueuedWork = {
          sessionId: session.trackerSessionId,
          issueId: session.issueId,
          issueIdentifier,
          priority: Math.max(1, (session.priority || 3) - 1), // Boost priority
          queuedAt: Date.now(),
          prompt: session.promptContext,
          // providerSessionId intentionally omitted - don't resume crashed sessions
          workType: session.workType,
          projectName: session.projectName,
        }

        const dispatchResult = await dispatchWork(work)

        if (dispatchResult.dispatched || dispatchResult.parked) {
          result.requeued++
          result.details.push({
            sessionId: session.trackerSessionId,
            issueIdentifier,
            action: 'requeued',
            worktreePath: session.worktreePath,
          })

          // Track worktree path for cleanup on worker machines
          if (session.worktreePath) {
            result.worktreePathsToCleanup.push(session.worktreePath)
          }

          // Call external callback (e.g., post Linear comment)
          if (callbacks?.onOrphanRequeued) {
            try {
              await callbacks.onOrphanRequeued(session)
            } catch (err) {
              log.warn('onOrphanRequeued callback failed', { error: err })
            }
          }
        } else {
          result.failed++
          result.details.push({
            sessionId: session.trackerSessionId,
            issueIdentifier,
            action: 'failed',
            reason: 'Failed to queue work',
          })
        }
      } catch (err) {
        log.error('Failed to cleanup orphaned session', {
          sessionId: session.trackerSessionId,
          error: err,
        })
        result.failed++
        result.details.push({
          sessionId: session.trackerSessionId,
          issueIdentifier: session.issueIdentifier || 'unknown',
          action: 'failed',
          reason: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    // Check for zombie pending sessions (pending but not in any queue)
    try {
      const zombies = await findZombiePendingSessions()

      if (zombies.length > 0) {
        log.info('Found zombie pending sessions', { count: zombies.length })
      }

      for (const session of zombies) {
        try {
          const issueIdentifier = session.issueIdentifier || session.issueId.slice(0, 8)

          log.info('Re-dispatching zombie pending session', {
            sessionId: session.trackerSessionId,
            issueIdentifier,
          })

          // Release issue lock if held by this zombie session (same rationale as orphan cleanup)
          const existingLock = await getIssueLock(session.issueId)
          if (existingLock && existingLock.sessionId === session.trackerSessionId) {
            log.info('Releasing issue lock held by zombie session', {
              sessionId: session.trackerSessionId,
              issueId: session.issueId,
            })
            await releaseIssueLock(session.issueId)
          }

          const work: QueuedWork = {
            sessionId: session.trackerSessionId,
            issueId: session.issueId,
            issueIdentifier,
            priority: Math.max(1, (session.priority || 3) - 1),
            queuedAt: Date.now(),
            prompt: session.promptContext,
            workType: session.workType,
            projectName: session.projectName,
          }

          const dispatchResult = await dispatchWork(work)

          if (dispatchResult.dispatched || dispatchResult.parked) {
            result.requeued++
            result.details.push({
              sessionId: session.trackerSessionId,
              issueIdentifier,
              action: 'requeued',
              reason: 'Zombie pending session recovered',
            })

            // Call external callback
            if (callbacks?.onZombieRecovered) {
              try {
                await callbacks.onZombieRecovered(session)
              } catch (err) {
                log.warn('onZombieRecovered callback failed', { error: err })
              }
            }
          } else {
            result.failed++
            result.details.push({
              sessionId: session.trackerSessionId,
              issueIdentifier,
              action: 'failed',
              reason: 'Failed to re-dispatch zombie session',
            })
          }
        } catch (err) {
          log.error('Failed to recover zombie session', {
            sessionId: session.trackerSessionId,
            error: err,
          })
          result.failed++
          result.details.push({
            sessionId: session.trackerSessionId,
            issueIdentifier: session.issueIdentifier || 'unknown',
            action: 'failed',
            reason: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      }
    } catch (err) {
      log.error('Failed to find zombie pending sessions', { error: err })
    }

    // Also check for expired issue locks with pending work
    try {
      const promoted = await cleanupExpiredLocksWithPendingWork()
      if (promoted > 0) {
        log.info('Promoted pending work from expired issue locks', { promoted })
      }
    } catch (err) {
      log.error('Failed to cleanup expired issue locks', { error: err })
    }

    // Check for stale locks held by completed sessions when workers have idle capacity.
    // Only runs when workers are online — no point promoting if nobody can pick it up.
    try {
      const workers = await listWorkers()
      const activeWorkers = workers.filter((w) => w.status === 'active')
      const hasIdleWorkers =
        activeWorkers.length > 0 &&
        activeWorkers.some((w) => w.activeCount < w.capacity)

      if (hasIdleWorkers) {
        const promoted = await cleanupStaleLocksWithIdleWorkers(hasIdleWorkers)
        if (promoted > 0) {
          log.info('Promoted parked work from stale issue locks', { promoted })
        }
      }
    } catch (err) {
      log.error('Failed to cleanup stale issue locks', { error: err })
    }

    log.info('Orphan cleanup completed', {
      checked: result.checked,
      orphaned: result.orphaned,
      requeued: result.requeued,
      failed: result.failed,
      worktreePathsToCleanup: result.worktreePathsToCleanup.length,
    })

    // Log worktree cleanup info if any paths need attention
    if (result.worktreePathsToCleanup.length > 0) {
      log.info('Worktree cleanup needed on worker machines', {
        paths: result.worktreePathsToCleanup,
        note: 'Run cleanup-worktrees on each worker machine to remove orphaned worktrees',
      })
    }
  } catch (err) {
    log.error('Orphan cleanup failed', { error: err })
  }

  return result
}

/**
 * Check if cleanup should run based on time since last cleanup
 * Returns true if enough time has passed
 */
let lastCleanupTime = 0
const CLEANUP_INTERVAL_MS = 60_000 // Run at most once per minute

export function shouldRunCleanup(): boolean {
  const now = Date.now()
  if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
    lastCleanupTime = now
    return true
  }
  return false
}

/**
 * Run cleanup if enough time has passed (debounced)
 * Safe to call frequently - will only actually run periodically
 *
 * @param callbacks - Optional callbacks for external integrations
 */
export async function maybeCleanupOrphans(
  callbacks?: OrphanCleanupCallbacks
): Promise<OrphanCleanupResult | null> {
  if (!shouldRunCleanup()) {
    return null
  }
  return cleanupOrphanedSessions(callbacks)
}
