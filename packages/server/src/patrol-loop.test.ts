import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock all dependencies
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('./worker-storage.js', () => ({
  listWorkers: vi.fn(() => []),
  deregisterWorker: vi.fn(() => ({ deregistered: true, unclaimedSessions: [] })),
  nudgeWorker: vi.fn(() => true),
}))

vi.mock('./session-storage.js', () => ({
  getSessionsByStatus: vi.fn(() => []),
  resetSessionForRequeue: vi.fn(),
}))

vi.mock('./work-queue.js', () => ({
  releaseClaim: vi.fn(),
  WORK_QUEUE_KEY: 'work:queue',
  WORK_ITEMS_KEY: 'work:items',
  calculateScore: vi.fn((priority: number, queuedAt: number) => priority * 1e13 + queuedAt),
}))

vi.mock('./issue-lock.js', () => ({
  dispatchWork: vi.fn(() => ({ dispatched: true, parked: false })),
  getIssueLock: vi.fn(() => null),
  releaseIssueLock: vi.fn(),
}))

vi.mock('./orphan-cleanup.js', () => ({
  cleanupOrphanedSessions: vi.fn(() => ({
    checked: 0,
    orphaned: 0,
    requeued: 0,
    failed: 0,
    details: [],
    worktreePathsToCleanup: [],
  })),
}))

vi.mock('./health-probes.js', () => ({
  evaluateWorkerHealth: vi.fn(() => ({
    workerId: 'wkr_abc',
    liveness: { ok: true, checkedAt: Date.now() },
    readiness: { ok: true, checkedAt: Date.now() },
    startup: { ok: true, checkedAt: Date.now() },
    healthy: true,
    grade: 'green',
  })),
  detectStuckSignals: vi.fn(() => ({
    sessionRunningTooLong: false,
    heartbeatStale: false,
    claimStuck: false,
    toolLoopStuck: false,
    stuckDurationMs: 0,
    isStuck: false,
  })),
}))

vi.mock('./stuck-decision-tree.js', () => ({
  decideRemediation: vi.fn(() => null),
}))

vi.mock('./supervisor-storage.js', () => ({
  getRemediationRecord: vi.fn(() => null),
  recordRemediationAction: vi.fn(),
  setWorkerHealthSnapshot: vi.fn(),
}))

vi.mock('./scheduler/migration.js', () => ({
  runQueueMaintenance: vi.fn(() => ({
    promoted: 0,
    reevaluated: 0,
    stats: null,
    skipped: true,
  })),
}))

vi.mock('./fleet-quota-storage.js', () => ({
  getAllQuotaConfigs: vi.fn(() => []),
}))

vi.mock('./fleet-quota-tracker.js', () => ({
  cleanupStaleSessions: vi.fn(() => 0),
}))

import { PatrolLoop } from './patrol-loop.js'
import { listWorkers, nudgeWorker, deregisterWorker } from './worker-storage.js'
import { getSessionsByStatus, resetSessionForRequeue } from './session-storage.js'
import { releaseClaim } from './work-queue.js'
import { dispatchWork, getIssueLock, releaseIssueLock } from './issue-lock.js'
import { cleanupOrphanedSessions } from './orphan-cleanup.js'
import { evaluateWorkerHealth, detectStuckSignals } from './health-probes.js'
import { decideRemediation } from './stuck-decision-tree.js'
import { getRemediationRecord, recordRemediationAction, setWorkerHealthSnapshot } from './supervisor-storage.js'
import type { WorkerInfo } from './worker-storage.js'
import type { AgentSessionState } from './session-storage.js'
import { DEFAULT_STUCK_DETECTION_CONFIG } from './fleet-supervisor-types.js'

const mockListWorkers = vi.mocked(listWorkers)
const mockNudgeWorker = vi.mocked(nudgeWorker)
const mockDeregisterWorker = vi.mocked(deregisterWorker)
const mockGetSessionsByStatus = vi.mocked(getSessionsByStatus)
const mockResetSessionForRequeue = vi.mocked(resetSessionForRequeue)
const mockReleaseClaim = vi.mocked(releaseClaim)
const mockDispatchWork = vi.mocked(dispatchWork)
const mockGetIssueLock = vi.mocked(getIssueLock)
const mockReleaseIssueLock = vi.mocked(releaseIssueLock)
const mockCleanupOrphanedSessions = vi.mocked(cleanupOrphanedSessions)
const mockEvaluateWorkerHealth = vi.mocked(evaluateWorkerHealth)
const mockDetectStuckSignals = vi.mocked(detectStuckSignals)
const mockDecideRemediation = vi.mocked(decideRemediation)
const mockGetRemediationRecord = vi.mocked(getRemediationRecord)
const mockRecordRemediationAction = vi.mocked(recordRemediationAction)
const mockSetWorkerHealthSnapshot = vi.mocked(setWorkerHealthSnapshot)

function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: 'wkr_abc',
    hostname: 'test-host',
    capacity: 3,
    activeCount: 1,
    registeredAt: 900_000,
    lastHeartbeat: Date.now(),
    status: 'active',
    activeSessions: ['sess-1'],
    ...overrides,
  }
}

function makeSession(overrides: Partial<AgentSessionState> = {}): AgentSessionState {
  return {
    trackerSessionId: 'sess-1',
    trackerProvider: 'linear',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    providerSessionId: null,
    worktreePath: '/tmp/wt',
    status: 'running',
    createdAt: 800_000,
    updatedAt: Date.now() - 60_000,
    workerId: 'wkr_abc',
    ...overrides,
  }
}

describe('PatrolLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('start / stop', () => {
    it('starts and stops the patrol loop', () => {
      const loop = new PatrolLoop({ intervalMs: 1000 })

      expect(loop.isRunning()).toBe(false)

      loop.start()
      expect(loop.isRunning()).toBe(true)

      loop.stop()
      expect(loop.isRunning()).toBe(false)
    })

    it('does not start twice', () => {
      const loop = new PatrolLoop({ intervalMs: 1000 })

      loop.start()
      loop.start() // should warn but not create duplicate interval

      expect(loop.isRunning()).toBe(true)
      loop.stop()
    })
  })

  describe('patrolOnce — healthy fleet', () => {
    it('returns empty result when no workers or sessions', async () => {
      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      expect(result.workersChecked).toBe(0)
      expect(result.sessionsChecked).toBe(0)
      expect(result.stuckSessions).toHaveLength(0)
      expect(result.remediations).toHaveLength(0)
      expect(result.errors).toHaveLength(0)
    })

    it('probes worker health and stores snapshot', async () => {
      const worker = makeWorker()
      mockListWorkers.mockResolvedValue([worker])

      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      expect(result.workersChecked).toBe(1)
      expect(mockEvaluateWorkerHealth).toHaveBeenCalledWith(worker, [])
      expect(mockSetWorkerHealthSnapshot).toHaveBeenCalled()
    })

    it('runs orphan cleanup', async () => {
      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      expect(mockCleanupOrphanedSessions).toHaveBeenCalled()
      expect(result.orphanCleanupResult).toBeDefined()
    })

    it('skips orphan cleanup when disabled', async () => {
      const loop = new PatrolLoop({ enableOrphanCleanup: false })
      const result = await loop.patrolOnce()

      expect(mockCleanupOrphanedSessions).not.toHaveBeenCalled()
      expect(result.orphanCleanupResult).toBeUndefined()
    })
  })

  describe('patrolOnce — stuck detection', () => {
    it('detects and records stuck sessions', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })

      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      expect(result.stuckSessions).toHaveLength(1)
      expect(result.stuckSessions[0]!.sessionId).toBe('sess-1')
    })

    it('executes nudge remediation', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'test nudge',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      expect(result.remediations).toHaveLength(1)
      expect(result.remediations[0]!.action).toBe('nudge')
      expect(mockNudgeWorker).toHaveBeenCalledWith('wkr_abc', expect.any(String))
      expect(mockRecordRemediationAction).toHaveBeenCalledWith(
        'sess-1', 'issue-1', 'SUP-100', 'nudge'
      )
    })

    it('executes restart remediation', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'restart',
        reason: 'test restart',
        attemptNumber: 1,
        maxAttempts: 3,
      })

      const loop = new PatrolLoop()
      await loop.patrolOnce()

      expect(mockDeregisterWorker).toHaveBeenCalledWith('wkr_abc')
      expect(mockReleaseClaim).toHaveBeenCalledWith('sess-1')
      expect(mockResetSessionForRequeue).toHaveBeenCalledWith('sess-1')
      expect(mockDispatchWork).toHaveBeenCalled()
    })

    it('executes reassign remediation', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'reassign',
        reason: 'test reassign',
        attemptNumber: 1,
        maxAttempts: 1,
      })

      const loop = new PatrolLoop()
      await loop.patrolOnce()

      expect(mockReleaseClaim).toHaveBeenCalledWith('sess-1')
      expect(mockResetSessionForRequeue).toHaveBeenCalledWith('sess-1')
      expect(mockDispatchWork).toHaveBeenCalled()
      // Should not deregister worker on reassign
      expect(mockDeregisterWorker).not.toHaveBeenCalled()
    })

    it('releases issue lock during restart when held by session', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'restart',
        reason: 'test',
        attemptNumber: 1,
        maxAttempts: 3,
      })
      mockGetIssueLock.mockResolvedValue({
        sessionId: 'sess-1',
        workType: 'development',
        workerId: 'wkr_abc',
        lockedAt: 900_000,
        issueIdentifier: 'SUP-100',
      })

      const loop = new PatrolLoop()
      await loop.patrolOnce()

      expect(mockReleaseIssueLock).toHaveBeenCalledWith('issue-1')
    })

    it('skips stuck detection when disabled', async () => {
      const loop = new PatrolLoop({ enableStuckDetection: false })
      await loop.patrolOnce()

      expect(mockDetectStuckSignals).not.toHaveBeenCalled()
    })
  })

  describe('patrolOnce — callbacks', () => {
    it('fires onWorkerUnhealthy for unhealthy workers', async () => {
      const onWorkerUnhealthy = vi.fn()
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockEvaluateWorkerHealth.mockReturnValue({
        workerId: 'wkr_abc',
        liveness: { ok: false, reason: 'dead', checkedAt: Date.now() },
        readiness: { ok: true, checkedAt: Date.now() },
        startup: { ok: true, checkedAt: Date.now() },
        healthy: false,
        grade: 'red',
      })

      const loop = new PatrolLoop({}, { onWorkerUnhealthy })
      await loop.patrolOnce()

      expect(onWorkerUnhealthy).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'wkr_abc', healthy: false })
      )
    })

    it('fires onStuckDetected callback', async () => {
      const onStuckDetected = vi.fn()
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })

      const loop = new PatrolLoop({}, { onStuckDetected })
      await loop.patrolOnce()

      expect(onStuckDetected).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({ isStuck: true })
      )
    })

    it('fires onEscalation callback', async () => {
      const onEscalation = vi.fn()
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'escalate',
        reason: 'all budgets exhausted',
        attemptNumber: 1,
        maxAttempts: 1,
      })

      const loop = new PatrolLoop({}, { onEscalation })
      await loop.patrolOnce()

      expect(onEscalation).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'escalate' })
      )
    })

    it('fires onPatrolComplete callback', async () => {
      const onPatrolComplete = vi.fn()

      const loop = new PatrolLoop({}, { onPatrolComplete })
      await loop.patrolOnce()

      expect(onPatrolComplete).toHaveBeenCalledWith(
        expect.objectContaining({ patrolledAt: expect.any(Number) })
      )
    })

    it('continues on callback errors', async () => {
      const onWorkerUnhealthy = vi.fn().mockRejectedValue(new Error('cb fail'))
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockEvaluateWorkerHealth.mockReturnValue({
        workerId: 'wkr_abc',
        liveness: { ok: false, reason: 'dead', checkedAt: Date.now() },
        readiness: { ok: true, checkedAt: Date.now() },
        startup: { ok: true, checkedAt: Date.now() },
        healthy: false,
        grade: 'red',
      })

      const loop = new PatrolLoop({}, { onWorkerUnhealthy })
      const result = await loop.patrolOnce()

      // Should not throw; patrol completes despite callback error
      expect(result.workersChecked).toBe(1)
    })
  })

  describe('patrolOnce — error handling', () => {
    it('handles listWorkers failure gracefully', async () => {
      mockListWorkers.mockRejectedValue(new Error('Redis down'))

      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]!.context).toBe('health-probes')
    })

    it('handles orphan cleanup failure gracefully', async () => {
      mockCleanupOrphanedSessions.mockRejectedValue(new Error('cleanup fail'))

      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      expect(result.errors.some((e) => e.context === 'orphan-cleanup')).toBe(true)
    })

    it('continues checking other sessions when one fails', async () => {
      const session1 = makeSession({ trackerSessionId: 'sess-1' })
      const session2 = makeSession({ trackerSessionId: 'sess-2' })
      mockGetSessionsByStatus.mockResolvedValue([session1, session2])
      mockListWorkers.mockResolvedValue([makeWorker()])

      let callCount = 0
      mockDetectStuckSignals.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          throw new Error('probe fail')
        }
        return {
          sessionRunningTooLong: false,
          heartbeatStale: false,
          claimStuck: false,
          toolLoopStuck: false,
          stuckDurationMs: 0,
          isStuck: false,
        }
      })

      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      // Both sessions were attempted (2 calls to detectStuckSignals)
      expect(callCount).toBe(2)
      // One error recorded
      expect(result.errors.some((e) => e.context.includes('sess-1'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Nudge Delivery with Message (SUP-1258, SUP-1260)
  // -------------------------------------------------------------------------

  describe('patrolOnce — nudge delivery', () => {
    it('passes nudge prompt message to nudgeWorker', async () => {
      const session = makeSession({ workType: 'development' })
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'test nudge',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop()
      await loop.patrolOnce()

      expect(mockNudgeWorker).toHaveBeenCalledWith('wkr_abc', expect.any(String))
      // The prompt should be the development-specific one
      const passedPrompt = mockNudgeWorker.mock.calls[0]![1]
      expect(passedPrompt).toContain('same tool repeatedly')
    })

    it('falls back to default prompt for work type without custom prompt', async () => {
      const session = makeSession({ workType: 'research' })
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'test nudge',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop()
      await loop.patrolOnce()

      const passedPrompt = mockNudgeWorker.mock.calls[0]![1]
      expect(passedPrompt).toBeTruthy()
    })

    it('uses custom nudge prompt from config', async () => {
      const session = makeSession({ workType: 'research' })
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'test nudge',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop({
        stuckDetection: {
          ...DEFAULT_STUCK_DETECTION_CONFIG,
          nudgePrompts: {
            defaultPrompt: 'fallback',
            prompts: { research: 'Custom nudge message' },
          },
        },
      })
      await loop.patrolOnce()

      const passedPrompt = mockNudgeWorker.mock.calls[0]![1]
      expect(passedPrompt).toBe('Custom nudge message')
    })
  })

  // -------------------------------------------------------------------------
  // Event Publishing (SUP-1264)
  // -------------------------------------------------------------------------

  describe('patrolOnce — event publishing', () => {
    it('publishes nudge-sent event after nudge execution', async () => {
      const mockPublish = vi.fn()
      const mockEventBus = { publish: mockPublish, subscribe: vi.fn(), close: vi.fn() }

      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'test nudge',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop({}, {}, mockEventBus as any)
      await loop.patrolOnce()

      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nudge-sent',
          sessionId: 'sess-1',
          attemptNumber: 1,
        })
      )
    })

    it('publishes nudge-succeeded event when activity resumes', async () => {
      const mockPublish = vi.fn()
      const mockEventBus = { publish: mockPublish, subscribe: vi.fn(), close: vi.fn() }

      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      // Session is NOT stuck now (activity resumed)
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: false,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 0,
        isStuck: false,
      })
      // But had previous nudges
      mockGetRemediationRecord.mockResolvedValue({
        sessionId: 'sess-1',
        issueId: 'issue-1',
        issueIdentifier: 'SUP-100',
        nudgeCount: 1,
        nudgeTimestamps: [900_000],
        restartCount: 0,
        restartTimestamps: [],
        reassignCount: 0,
        reassignTimestamps: [],
        escalated: false,
        firstDetectedAt: 800_000,
        lastActionAt: 900_000,
        updatedAt: 900_000,
      })

      const loop = new PatrolLoop({}, {}, mockEventBus as any)
      await loop.patrolOnce()

      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nudge-succeeded',
          sessionId: 'sess-1',
        })
      )
    })

    it('publishes nudge-failed event on escalation to restart', async () => {
      const mockPublish = vi.fn()
      const mockEventBus = { publish: mockPublish, subscribe: vi.fn(), close: vi.fn() }

      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockGetRemediationRecord.mockResolvedValue({
        sessionId: 'sess-1',
        issueId: 'issue-1',
        issueIdentifier: 'SUP-100',
        nudgeCount: 1,
        nudgeTimestamps: [900_000],
        restartCount: 0,
        restartTimestamps: [],
        reassignCount: 0,
        reassignTimestamps: [],
        escalated: false,
        firstDetectedAt: 800_000,
        lastActionAt: 900_000,
        updatedAt: 900_000,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'restart',
        reason: 'Nudge failed: no activity within 3 minutes',
        attemptNumber: 1,
        maxAttempts: 3,
      })

      const loop = new PatrolLoop({}, {}, mockEventBus as any)
      await loop.patrolOnce()

      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nudge-failed',
          sessionId: 'sess-1',
        })
      )
    })

    it('does not publish events when event bus not provided', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'test nudge',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      // No event bus
      const loop = new PatrolLoop()
      const result = await loop.patrolOnce()

      // Should complete without error (orphan cleanup errors are unrelated)
      expect(result.remediations).toHaveLength(1)
      // No stuck-detection related errors
      expect(result.errors.filter((e) => e.context.startsWith('stuck-detection'))).toHaveLength(0)
    })

    it('includes correct fields in nudge event', async () => {
      const mockPublish = vi.fn()
      const mockEventBus = { publish: mockPublish, subscribe: vi.fn(), close: vi.fn() }

      const session = makeSession({
        issueIdentifier: 'SUP-200',
        workerId: 'wkr_xyz',
      })
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker({ id: 'wkr_xyz' })])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'test nudge',
        attemptNumber: 2,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop({}, {}, mockEventBus as any)
      await loop.patrolOnce()

      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nudge-sent',
          sessionId: 'sess-1',
          issueId: 'issue-1',
          issueIdentifier: 'SUP-200',
          workerId: 'wkr_xyz',
          attemptNumber: 2,
          nudgeMessage: expect.any(String),
          reason: 'test nudge',
          timestamp: expect.any(String),
          source: 'manual',
        })
      )
    })
  })

  // -------------------------------------------------------------------------
  // Integration: Full nudge lifecycle (SUP-1265)
  // -------------------------------------------------------------------------

  describe('patrolOnce — nudge lifecycle integration', () => {
    it('full flow: stuck → nudge → activity resumes → cleared', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])

      // Pass 1: Detect stuck, nudge
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: true,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'First detection: tool loop detected',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop()
      const result1 = await loop.patrolOnce()

      expect(result1.remediations).toHaveLength(1)
      expect(result1.remediations[0]!.action).toBe('nudge')
      expect(mockNudgeWorker).toHaveBeenCalled()

      // Pass 2: Activity resumes, session no longer stuck
      vi.clearAllMocks()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: false,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: false,
        stuckDurationMs: 0,
        isStuck: false,
      })

      const result2 = await loop.patrolOnce()

      expect(result2.stuckSessions).toHaveLength(0)
      expect(result2.remediations).toHaveLength(0)
    })

    it('full flow: stuck → nudge → no activity → restart', async () => {
      const session = makeSession()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])

      // Pass 1: Detect stuck, nudge
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: true,
        stuckDurationMs: 60_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: '',
        workerId: '',
        action: 'nudge',
        reason: 'First detection: tool loop detected',
        attemptNumber: 1,
        maxAttempts: 2,
      })

      const loop = new PatrolLoop()
      const result1 = await loop.patrolOnce()

      expect(result1.remediations[0]!.action).toBe('nudge')

      // Pass 2: Still stuck, nudge failed → restart
      vi.clearAllMocks()
      mockGetSessionsByStatus.mockResolvedValue([session])
      mockListWorkers.mockResolvedValue([makeWorker()])
      mockDetectStuckSignals.mockReturnValue({
        sessionRunningTooLong: true,
        heartbeatStale: false,
        claimStuck: false,
        toolLoopStuck: true,
        stuckDurationMs: 120_000,
        isStuck: true,
      })
      mockDecideRemediation.mockReturnValue({
        sessionId: 'sess-1',
        workerId: '',
        action: 'restart',
        reason: 'Nudge failed: no activity within 3 minutes',
        attemptNumber: 1,
        maxAttempts: 3,
      })
      mockGetRemediationRecord.mockResolvedValue({
        sessionId: 'sess-1',
        issueId: 'issue-1',
        issueIdentifier: 'SUP-100',
        nudgeCount: 1,
        nudgeTimestamps: [900_000],
        restartCount: 0,
        restartTimestamps: [],
        reassignCount: 0,
        reassignTimestamps: [],
        escalated: false,
        firstDetectedAt: 800_000,
        lastActionAt: 900_000,
        updatedAt: 900_000,
      })

      const result2 = await loop.patrolOnce()

      expect(result2.remediations).toHaveLength(1)
      expect(result2.remediations[0]!.action).toBe('restart')
      expect(mockDeregisterWorker).toHaveBeenCalledWith('wkr_abc')
      expect(mockDispatchWork).toHaveBeenCalled()
    })
  })
})
