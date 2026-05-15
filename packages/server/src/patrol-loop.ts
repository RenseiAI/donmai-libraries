/**
 * Unified Patrol Loop
 *
 * Single scheduled scan that subsumes orphan cleanup and adds:
 * - Worker health probes (liveness, readiness, startup)
 * - Stuck session detection
 * - Remediation decision tree (nudge → restart → reassign → escalate)
 *
 * The patrol loop runs on a configurable interval (default: 30s) and performs:
 * 1. Health check all registered workers (three-probe model)
 * 2. Scan all active sessions for stuck signals
 * 3. For stuck sessions, consult the decision tree and execute remediation
 * 4. Run orphan cleanup (existing logic, delegated to orphan-cleanup.ts)
 * 5. Record patrol results for observability
 */

import { createLogger } from './logger.js'
import { listWorkers, deregisterWorker, nudgeWorker } from './worker-storage.js'
import {
  getSessionsByStatus,
  resetSessionForRequeue,
} from './session-storage.js'
import { releaseClaim } from './work-queue.js'
import {
  dispatchWork,
  getIssueLock,
  releaseIssueLock,
} from './issue-lock.js'
import { cleanupOrphanedSessions } from './orphan-cleanup.js'
import { runQueueMaintenance } from './scheduler/migration.js'
import { getAllQuotaConfigs } from './fleet-quota-storage.js'
import { cleanupStaleSessions, getConcurrentSessionIds } from './fleet-quota-tracker.js'
import { evaluateWorkerHealth, detectStuckSignals } from './health-probes.js'
import { decideRemediation } from './stuck-decision-tree.js'
import {
  getRemediationRecord,
  recordRemediationAction,
  setWorkerHealthSnapshot,
} from './supervisor-storage.js'
import type { QueuedWork } from './work-queue.js'
import type {
  PatrolConfig,
  PatrolResult,
  PatrolCallbacks,
  RemediationDecision,
  WorkerHealthStatus,
} from './fleet-supervisor-types.js'
import { DEFAULT_PATROL_CONFIG, DEFAULT_NUDGE_PROMPTS } from './fleet-supervisor-types.js'
import type { GovernorEventBus } from '@renseiai/agentfactory'

const log = createLogger('patrol-loop')

export class PatrolLoop {
  private config: PatrolConfig
  private callbacks: PatrolCallbacks
  private eventBus?: GovernorEventBus
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private patrolling = false

  constructor(
    config: Partial<PatrolConfig> = {},
    callbacks: PatrolCallbacks = {},
    eventBus?: GovernorEventBus
  ) {
    this.config = { ...DEFAULT_PATROL_CONFIG, ...config }
    this.callbacks = callbacks
    this.eventBus = eventBus
  }

  /**
   * Start the patrol loop. Runs first patrol immediately,
   * then repeats on the configured interval.
   */
  start(): void {
    if (this.intervalHandle) {
      log.warn('Patrol loop already running')
      return
    }

    log.info('Starting patrol loop', {
      intervalMs: this.config.intervalMs,
      enableOrphanCleanup: this.config.enableOrphanCleanup,
      enableStuckDetection: this.config.enableStuckDetection,
      enableHealthProbes: this.config.enableHealthProbes,
    })

    // Run immediately
    void this.patrolOnce()

    // Schedule recurring patrols
    this.intervalHandle = setInterval(() => {
      void this.patrolOnce()
    }, this.config.intervalMs)

    // Don't block process exit
    if (this.intervalHandle.unref) {
      this.intervalHandle.unref()
    }
  }

  /**
   * Stop the patrol loop.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
      log.info('Patrol loop stopped')
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null
  }

  /**
   * Execute a single patrol pass.
   */
  async patrolOnce(): Promise<PatrolResult> {
    // Prevent overlapping patrols
    if (this.patrolling) {
      log.debug('Patrol already in progress, skipping')
      return this.emptyResult()
    }

    this.patrolling = true
    const result: PatrolResult = this.emptyResult()

    try {
      // Step 1: Health probe all workers
      if (this.config.enableHealthProbes) {
        await this.probeWorkerHealth(result)
      }

      // Step 2: Detect stuck sessions and apply remediation
      if (this.config.enableStuckDetection) {
        await this.detectAndRemediate(result)
      }

      // Step 3: Run orphan cleanup (existing logic)
      if (this.config.enableOrphanCleanup) {
        await this.runOrphanCleanup(result)
      }

      // Step 4: Queue maintenance (scheduling pipeline)
      try {
        const queueResult = await runQueueMaintenance()
        if (!queueResult.skipped && queueResult.stats) {
          // Just log — no need to add to PatrolResult for now
        }
      } catch (err) {
        log.error('queue_maintenance_failed', { error: String(err) })
      }

      // Step 5: Fleet quota stale session cleanup
      try {
        await this.cleanupQuotaStaleSessions()
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.error('Fleet quota stale session cleanup failed', { error: errorMsg })
        result.errors.push({ context: 'quota-stale-cleanup', error: errorMsg })
      }

      // Fire completion callback
      if (this.callbacks.onPatrolComplete) {
        try {
          await this.callbacks.onPatrolComplete(result)
        } catch (err) {
          log.warn('onPatrolComplete callback failed', { error: err })
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('Patrol failed', { error: errorMsg })
      result.errors.push({ context: 'patrol', error: errorMsg })
    } finally {
      this.patrolling = false
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Step 1: Worker Health Probes
  // -------------------------------------------------------------------------

  private async probeWorkerHealth(result: PatrolResult): Promise<void> {
    try {
      const workers = await listWorkers()
      const sessions = await getSessionsByStatus(['running', 'claimed'])
      result.workersChecked = workers.length

      for (const worker of workers) {
        try {
          const health = evaluateWorkerHealth(worker, sessions)

          result.workerHealth.push(health)

          // Persist snapshot for observability
          await setWorkerHealthSnapshot(health)

          // Fire callback for unhealthy workers
          if (!health.healthy && this.callbacks.onWorkerUnhealthy) {
            try {
              await this.callbacks.onWorkerUnhealthy(health)
            } catch (err) {
              log.warn('onWorkerUnhealthy callback failed', {
                workerId: worker.id,
                error: err,
              })
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          result.errors.push({
            context: `health-probe:${worker.id}`,
            error: errorMsg,
          })
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('Failed to probe worker health', { error: errorMsg })
      result.errors.push({ context: 'health-probes', error: errorMsg })
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Stuck Detection & Remediation
  // -------------------------------------------------------------------------

  private async detectAndRemediate(result: PatrolResult): Promise<void> {
    try {
      const sessions = await getSessionsByStatus(['running', 'claimed'])
      const workers = await listWorkers()
      const workerMap = new Map(workers.map((w) => [w.id, w]))

      result.sessionsChecked = sessions.length

      for (const session of sessions) {
        try {
          const worker = session.workerId
            ? workerMap.get(session.workerId) ?? null
            : null

          const signals = detectStuckSignals(
            session,
            worker,
            this.config.stuckDetection,
            Date.now()
          )

          // Check for nudge success: session no longer stuck but has previous nudges
          if (!signals.isStuck) {
            const prevRecord = await getRemediationRecord(session.trackerSessionId)
            if (prevRecord && prevRecord.nudgeCount > 0 && !prevRecord.escalated) {
              await this.publishNudgeEvent(
                'nudge-succeeded',
                session,
                prevRecord.nudgeCount,
                'Activity resumed after nudge'
              )
            }
            continue
          }

          // Record stuck session
          result.stuckSessions.push({
            sessionId: session.trackerSessionId,
            workerId: session.workerId ?? '',
            signals,
          })

          // Fire stuck callback
          if (this.callbacks.onStuckDetected) {
            try {
              await this.callbacks.onStuckDetected(
                session.trackerSessionId,
                signals
              )
            } catch (err) {
              log.warn('onStuckDetected callback failed', { error: err })
            }
          }

          // Get remediation history and decide next action
          const record = await getRemediationRecord(session.trackerSessionId)
          const decision = decideRemediation(
            record,
            signals,
            this.config.stuckDetection,
            Date.now()
          )

          if (!decision) continue

          // Fill in session/worker IDs
          decision.sessionId = session.trackerSessionId
          decision.workerId = session.workerId ?? ''

          // Execute the remediation action
          await this.executeRemediation(decision, session)
          result.remediations.push(decision)

          // Record the action in storage
          await recordRemediationAction(
            session.trackerSessionId,
            session.issueId,
            session.issueIdentifier ?? session.issueId.slice(0, 8),
            decision.action
          )

          // Publish nudge lifecycle events to the governor event bus
          if (decision.action === 'nudge') {
            const nudgeMsg = this.getNudgePrompt(session.workType)
            await this.publishNudgeEvent(
              'nudge-sent',
              session,
              decision.attemptNumber,
              decision.reason,
              nudgeMsg
            )
          }
          if (decision.action === 'restart' && decision.reason.includes('Nudge failed')) {
            await this.publishNudgeEvent(
              'nudge-failed',
              session,
              record?.nudgeCount ?? 0,
              decision.reason
            )
          }

          // Fire remediation callback
          if (this.callbacks.onRemediation) {
            try {
              await this.callbacks.onRemediation(decision)
            } catch (err) {
              log.warn('onRemediation callback failed', { error: err })
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          result.errors.push({
            context: `stuck-detection:${session.trackerSessionId}`,
            error: errorMsg,
          })
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('Failed stuck detection pass', { error: errorMsg })
      result.errors.push({ context: 'stuck-detection', error: errorMsg })
    }
  }

  // -------------------------------------------------------------------------
  // Remediation Action Executors
  // -------------------------------------------------------------------------

  private async executeRemediation(
    decision: RemediationDecision,
    session: import('./session-storage.js').AgentSessionState
  ): Promise<void> {
    log.info('Executing remediation', {
      action: decision.action,
      sessionId: decision.sessionId,
      workerId: decision.workerId,
      attempt: `${decision.attemptNumber}/${decision.maxAttempts}`,
      reason: decision.reason,
    })

    switch (decision.action) {
      case 'nudge':
        await this.executeNudge(decision.workerId, session.workType)
        break
      case 'restart':
        await this.executeRestart(decision.workerId, session)
        break
      case 'reassign':
        await this.executeReassign(session)
        break
      case 'escalate':
        await this.executeEscalation(decision, session)
        break
    }
  }

  /**
   * Resolve the nudge prompt for a given work type.
   * Falls back to configured default, then to built-in default.
   */
  private getNudgePrompt(workType?: string): string {
    const config = this.config.stuckDetection.nudgePrompts
    if (workType && config?.prompts?.[workType]) {
      return config.prompts[workType]
    }
    return config?.defaultPrompt ?? DEFAULT_NUDGE_PROMPTS.default
  }

  /**
   * Nudge: Send a redirect message to the worker via Redis.
   * The worker picks it up and injects it into the agent conversation
   * via AgentHandle.injectMessage().
   */
  private async executeNudge(workerId: string, workType?: string): Promise<void> {
    if (workerId) {
      const prompt = this.getNudgePrompt(workType)
      await nudgeWorker(workerId, prompt)
    }
    log.info('Nudge sent', { workerId })
  }

  /**
   * Restart: Deregister the worker from Redis, release claims,
   * and re-queue the work. The fleet runner's auto-restart handles
   * actual process restart.
   */
  private async executeRestart(
    workerId: string,
    session: import('./session-storage.js').AgentSessionState
  ): Promise<void> {
    if (workerId) {
      await deregisterWorker(workerId)
    }

    await releaseClaim(session.trackerSessionId)

    // Release issue lock if held by this session
    const lock = await getIssueLock(session.issueId)
    if (lock && lock.sessionId === session.trackerSessionId) {
      await releaseIssueLock(session.issueId)
    }

    await resetSessionForRequeue(session.trackerSessionId)

    const work: QueuedWork = {
      sessionId: session.trackerSessionId,
      issueId: session.issueId,
      issueIdentifier: session.issueIdentifier ?? session.issueId.slice(0, 8),
      priority: Math.max(1, (session.priority || 3) - 1),
      queuedAt: Date.now(),
      prompt: session.promptContext,
      workType: session.workType,
      projectName: session.projectName,
    }

    await dispatchWork(work)
    log.info('Restart completed — session re-queued', {
      sessionId: session.trackerSessionId,
      workerId,
    })
  }

  /**
   * Reassign: Release locks/claims, reset session, and re-dispatch.
   * A different worker will pick up the work.
   */
  private async executeReassign(
    session: import('./session-storage.js').AgentSessionState
  ): Promise<void> {
    await releaseClaim(session.trackerSessionId)

    const lock = await getIssueLock(session.issueId)
    if (lock && lock.sessionId === session.trackerSessionId) {
      await releaseIssueLock(session.issueId)
    }

    await resetSessionForRequeue(session.trackerSessionId)

    const work: QueuedWork = {
      sessionId: session.trackerSessionId,
      issueId: session.issueId,
      issueIdentifier: session.issueIdentifier ?? session.issueId.slice(0, 8),
      priority: Math.max(1, (session.priority || 3) - 1),
      queuedAt: Date.now(),
      prompt: session.promptContext,
      workType: session.workType,
      projectName: session.projectName,
    }

    await dispatchWork(work)
    log.info('Reassign completed — session re-queued for different worker', {
      sessionId: session.trackerSessionId,
    })
  }

  /**
   * Escalate: Mark the record as escalated and fire the escalation callback.
   * Human intervention is required.
   */
  private async executeEscalation(
    decision: RemediationDecision,
    session: import('./session-storage.js').AgentSessionState
  ): Promise<void> {
    log.warn('Escalating to human', {
      sessionId: session.trackerSessionId,
      issueIdentifier: session.issueIdentifier,
      reason: decision.reason,
    })

    if (this.callbacks.onEscalation) {
      try {
        await this.callbacks.onEscalation(decision)
      } catch (err) {
        log.warn('onEscalation callback failed', { error: err })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Orphan Cleanup
  // -------------------------------------------------------------------------

  private async runOrphanCleanup(result: PatrolResult): Promise<void> {
    try {
      const cleanupResult = await cleanupOrphanedSessions()
      result.orphanCleanupResult = {
        orphaned: cleanupResult.orphaned,
        requeued: cleanupResult.requeued,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('Orphan cleanup failed during patrol', { error: errorMsg })
      result.errors.push({ context: 'orphan-cleanup', error: errorMsg })
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Fleet Quota Stale Session Cleanup
  // -------------------------------------------------------------------------

  /**
   * For each configured fleet quota, compare the concurrent session set
   * against actually active sessions in Redis. Remove stale entries that
   * belong to crashed/terminated workers.
   */
  private async cleanupQuotaStaleSessions(): Promise<void> {
    const quotas = await getAllQuotaConfigs()
    if (quotas.length === 0) return

    const activeSessions = await getSessionsByStatus(['running', 'claimed'])
    const activeIds = new Set(activeSessions.map((s) => s.trackerSessionId))

    let totalRemoved = 0
    for (const quota of quotas) {
      const removed = await cleanupStaleSessions(quota.name, activeIds)
      totalRemoved += removed
    }

    if (totalRemoved > 0) {
      log.info('Fleet quota stale sessions cleaned up', { totalRemoved })
    }
  }

  // -------------------------------------------------------------------------
  // Event Publishing
  // -------------------------------------------------------------------------

  /**
   * Publish a nudge lifecycle event to the governor event bus.
   * No-op when the event bus is not configured.
   */
  private async publishNudgeEvent(
    type: 'nudge-sent' | 'nudge-succeeded' | 'nudge-failed',
    session: import('./session-storage.js').AgentSessionState,
    attemptNumber: number,
    reason: string,
    nudgeMessage: string = ''
  ): Promise<void> {
    if (!this.eventBus) return
    try {
      await this.eventBus.publish({
        type,
        sessionId: session.trackerSessionId,
        issueId: session.issueId,
        issueIdentifier: session.issueIdentifier ?? '',
        workerId: session.workerId ?? '',
        attemptNumber,
        nudgeMessage,
        reason,
        timestamp: new Date().toISOString(),
        source: 'manual' as const,
      })
    } catch (err) {
      log.warn('Failed to publish nudge event', { type, error: err })
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private emptyResult(): PatrolResult {
    return {
      patrolledAt: Date.now(),
      workersChecked: 0,
      sessionsChecked: 0,
      workerHealth: [],
      stuckSessions: [],
      remediations: [],
      errors: [],
    }
  }
}
