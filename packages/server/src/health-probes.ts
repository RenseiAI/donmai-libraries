/**
 * Health Probes Module
 *
 * Implements the K8s-inspired three-probe health model for workers:
 * - Liveness:  Is the worker process alive?
 * - Readiness: Can the worker accept new work?
 * - Startup:   Has the worker completed initialization?
 *
 * Also provides stuck signal detection for sessions.
 *
 * All functions are pure — no I/O, no Redis. Callers supply data.
 */

import type { WorkerData, WorkerInfo } from './worker-storage.js'
import type { AgentSessionState } from './session-storage.js'
import type {
  ProbeResult,
  WorkerHealthStatus,
  StuckSignals,
  StuckDetectionConfig,
} from './fleet-supervisor-types.js'

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 180_000  // 180s = 6 missed 30s beats
const DEFAULT_STARTUP_GRACE_MS = 60_000       // 1 minute
const DEFAULT_CLAIM_STUCK_MS = 5 * 60_000     // 5 minutes

// ---------------------------------------------------------------------------
// Individual Probes
// ---------------------------------------------------------------------------

/**
 * Liveness probe: Is the worker process alive?
 *
 * Checks heartbeat freshness against the configured timeout.
 * A stale heartbeat indicates the worker process may have crashed.
 */
export function evaluateLiveness(
  worker: WorkerData,
  now: number,
  heartbeatTimeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS
): ProbeResult {
  const heartbeatAge = now - worker.lastHeartbeat

  if (worker.status === 'offline') {
    return { ok: false, reason: 'Worker status is offline', checkedAt: now }
  }

  if (heartbeatAge > heartbeatTimeoutMs) {
    return {
      ok: false,
      reason: `Heartbeat stale by ${Math.round(heartbeatAge / 1000)}s (timeout: ${Math.round(heartbeatTimeoutMs / 1000)}s)`,
      checkedAt: now,
    }
  }

  return { ok: true, checkedAt: now }
}

/**
 * Readiness probe: Can the worker accept new work?
 *
 * Checks capacity, draining status, and whether any sessions are
 * stuck in 'claimed' state (indicating the worker may be hung).
 */
export function evaluateReadiness(
  worker: WorkerInfo,
  sessions: AgentSessionState[],
  now: number,
  claimStuckMs: number = DEFAULT_CLAIM_STUCK_MS
): ProbeResult {
  if (worker.status === 'draining') {
    return { ok: false, reason: 'Worker is draining', checkedAt: now }
  }

  if (worker.activeSessions.length >= worker.capacity) {
    return { ok: false, reason: 'Worker at capacity', checkedAt: now }
  }

  // Check for claim-stuck sessions assigned to this worker
  const workerSessions = sessions.filter(
    (s) => s.workerId === worker.id && s.status === 'claimed'
  )
  for (const session of workerSessions) {
    const claimAge = now - (session.claimedAt ?? session.updatedAt)
    if (claimAge > claimStuckMs) {
      return {
        ok: false,
        reason: `Session ${session.trackerSessionId} stuck in claimed for ${Math.round(claimAge / 1000)}s`,
        checkedAt: now,
      }
    }
  }

  return { ok: true, checkedAt: now }
}

/**
 * Startup probe: Has the worker completed initialization?
 *
 * Checks that the worker has been registered long enough and has
 * sent at least one heartbeat after registration.
 */
export function evaluateStartup(
  worker: WorkerData,
  now: number,
  startupGraceMs: number = DEFAULT_STARTUP_GRACE_MS
): ProbeResult {
  const registrationAge = now - worker.registeredAt

  if (registrationAge < startupGraceMs) {
    return {
      ok: false,
      reason: `Worker still starting up (${Math.round(registrationAge / 1000)}s of ${Math.round(startupGraceMs / 1000)}s grace)`,
      checkedAt: now,
    }
  }

  // Worker must have sent a heartbeat after registration
  if (worker.lastHeartbeat <= worker.registeredAt) {
    return {
      ok: false,
      reason: 'No heartbeat received since registration',
      checkedAt: now,
    }
  }

  return { ok: true, checkedAt: now }
}

// ---------------------------------------------------------------------------
// Combined Health Assessment
// ---------------------------------------------------------------------------

/**
 * Evaluate combined worker health from all three probes.
 *
 * Grade:
 * - green:  All probes pass
 * - yellow: Liveness ok, but readiness or startup fails
 * - red:    Liveness fails (worker likely dead)
 */
export function evaluateWorkerHealth(
  worker: WorkerInfo,
  sessions: AgentSessionState[],
  config: {
    heartbeatTimeoutMs?: number
    startupGraceMs?: number
    claimStuckMs?: number
  } = {}
): WorkerHealthStatus {
  const now = Date.now()
  const liveness = evaluateLiveness(worker, now, config.heartbeatTimeoutMs)
  const readiness = evaluateReadiness(worker, sessions, now, config.claimStuckMs)
  const startup = evaluateStartup(worker, now, config.startupGraceMs)

  const healthy = liveness.ok && readiness.ok && startup.ok

  let grade: 'green' | 'yellow' | 'red'
  if (!liveness.ok) {
    grade = 'red'
  } else if (!readiness.ok || !startup.ok) {
    grade = 'yellow'
  } else {
    grade = 'green'
  }

  return {
    workerId: worker.id,
    liveness,
    readiness,
    startup,
    healthy,
    grade,
  }
}

// ---------------------------------------------------------------------------
// Stuck Signal Detection
// ---------------------------------------------------------------------------

/**
 * Detect stuck signals for a session.
 *
 * Evaluates multiple conditions that indicate a session may be stuck
 * and returns which signals are active.
 */
export function detectStuckSignals(
  session: AgentSessionState,
  worker: WorkerData | null,
  config: StuckDetectionConfig,
  now: number
): StuckSignals {
  const signals: StuckSignals = {
    sessionRunningTooLong: false,
    heartbeatStale: false,
    claimStuck: false,
    toolLoopStuck: false,
    stuckDurationMs: 0,
    isStuck: false,
  }

  // Session running too long
  if (session.status === 'running') {
    const runningDuration = now - session.updatedAt
    if (runningDuration > config.maxRunningDurationMs) {
      signals.sessionRunningTooLong = true
      signals.stuckDurationMs = Math.max(
        signals.stuckDurationMs,
        runningDuration - config.maxRunningDurationMs
      )
    }
  }

  // Worker heartbeat stale (but not yet dead — yellow zone)
  if (worker) {
    const heartbeatAge = now - worker.lastHeartbeat
    if (heartbeatAge > config.heartbeatYellowThresholdMs) {
      signals.heartbeatStale = true
      signals.stuckDurationMs = Math.max(
        signals.stuckDurationMs,
        heartbeatAge - config.heartbeatYellowThresholdMs
      )
    }
  }

  // Session stuck in claimed state
  if (session.status === 'claimed') {
    const claimDuration = now - (session.claimedAt ?? session.updatedAt)
    if (claimDuration > config.maxClaimDurationMs) {
      signals.claimStuck = true
      signals.stuckDurationMs = Math.max(
        signals.stuckDurationMs,
        claimDuration - config.maxClaimDurationMs
      )
    }
  }

  // Tool loop detection: same tool called continuously for too long
  if (session.lastToolName && session.lastToolCalledAt) {
    const toolDuration = now - session.lastToolCalledAt
    if (toolDuration > config.maxSameToolDurationMs) {
      signals.toolLoopStuck = true
      signals.stuckDurationMs = Math.max(
        signals.stuckDurationMs,
        toolDuration - config.maxSameToolDurationMs
      )
    }
  }

  // Nudge effectiveness proxy: if tool loop is no longer detected,
  // the agent has resumed different activity (nudge may have worked)
  signals.activityResumedAfterNudge = !signals.toolLoopStuck && !signals.sessionRunningTooLong

  signals.isStuck =
    signals.sessionRunningTooLong ||
    signals.heartbeatStale ||
    signals.claimStuck ||
    signals.toolLoopStuck

  return signals
}
