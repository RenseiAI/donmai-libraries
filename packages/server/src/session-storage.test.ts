import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  getRedisClient: vi.fn(() => ({ get: vi.fn(() => null) })),
  isRedisConfigured: vi.fn(() => true),
  redisSet: vi.fn(),
  redisGet: vi.fn(() => null),
  redisDel: vi.fn(() => 1),
  redisKeys: vi.fn(() => []),
  redisEval: vi.fn(() => 0),
}))

vi.mock('./fleet-quota-hooks.js', () => ({
  onCostUpdated: vi.fn(() => Promise.resolve()),
}))

import {
  storeSessionState,
  getSessionState,
  getAllSessions,
  updateSessionStatus,
  updateSessionCostData,
  updateProviderSessionId,
  deleteSessionState,
  touchSessionHeartbeat,
  claimSession,
  startSession,
  resetSessionForRequeue,
  transferSessionOwnership,
  type AgentSessionState,
} from './session-storage.js'
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

const mockOnCostUpdated = vi.mocked(onCostUpdated)

const mockGetRedisClient = vi.mocked(getRedisClient)
const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisSet = vi.mocked(redisSet)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisKeys = vi.mocked(redisKeys)
const mockRedisEval = vi.mocked(redisEval)

function makeSessionInput() {
  return {
    issueId: 'issue-1',
    issueIdentifier: 'SUP-123',
    providerSessionId: null,
    worktreePath: '/tmp/worktree',
    status: 'pending' as const,
    trackerProvider: 'linear' as const,
  }
}

describe('session-storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockRedisGet.mockResolvedValue(null)
    mockGetRedisClient.mockReturnValue({ get: vi.fn(() => Promise.resolve(null)) } as never)
  })

  describe('storeSessionState', () => {
    it('returns state with timestamps when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      const result = await storeSessionState('session-1', makeSessionInput())

      expect(result.trackerSessionId).toBe('session-1')
      expect(result.trackerProvider).toBe('linear')
      expect(result.issueId).toBe('issue-1')
      expect(result.createdAt).toBeGreaterThan(0)
      expect(result.updatedAt).toBeGreaterThan(0)
      expect(mockRedisSet).not.toHaveBeenCalled()
    })

    it('stores serialized state in Redis with TTL', async () => {
      const result = await storeSessionState('session-2', makeSessionInput())

      expect(result.trackerSessionId).toBe('session-2')
      expect(mockRedisSet).toHaveBeenCalledWith(
        'agent:session:session-2',
        expect.objectContaining({
          trackerSessionId: 'session-2',
          trackerProvider: 'linear',
          issueId: 'issue-1',
          status: 'pending',
        }),
        86400 // 24 * 60 * 60
      )
    })

    it('preserves createdAt from existing session', async () => {
      const existingCreatedAt = 1000000
      mockRedisGet.mockResolvedValue({
        trackerSessionId: 'session-3',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'running',
        createdAt: existingCreatedAt,
        updatedAt: 1000001,
      })

      const result = await storeSessionState('session-3', makeSessionInput())

      expect(result.createdAt).toBe(existingCreatedAt)
      expect(result.updatedAt).not.toBe(existingCreatedAt)
    })

    it('accepts explicit trackerProvider override', async () => {
      const result = await storeSessionState('session-gh', {
        ...makeSessionInput(),
        trackerProvider: 'github_issues',
      })

      expect(result.trackerProvider).toBe('github_issues')
    })
  })

  describe('getSessionState', () => {
    it('returns null when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await getSessionState('session-1')
      expect(result).toBeNull()
    })

    it('returns null when session is not found', async () => {
      mockRedisGet.mockResolvedValue(null)
      const result = await getSessionState('nonexistent')
      expect(result).toBeNull()
    })

    it('returns parsed session state from Redis', async () => {
      const stored = {
        trackerSessionId: 'session-1',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        issueIdentifier: 'SUP-123',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'running',
        createdAt: 1000000,
        updatedAt: 1000001,
      }
      mockRedisGet.mockResolvedValue(stored)

      const result = await getSessionState('session-1')

      // Read paths stamp the row's own id (derived from the key)
      expect(result).toEqual({ ...stored, rowSessionId: 'session-1' })
      expect(mockRedisGet).toHaveBeenCalledWith('agent:session:session-1')
    })

    it('stamps rowSessionId with the requested id, even when the stored trackerSessionId differs', async () => {
      // Per-dispatch rows: created under their own UUID key, then the stored
      // trackerSessionId is patched to a shared tracker session
      mockRedisGet.mockResolvedValue({
        trackerSessionId: 'tracker-shared',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'pending',
        createdAt: 1000000,
        updatedAt: 1000001,
      })

      const result = await getSessionState('dispatch-uuid-1')

      expect(result!.rowSessionId).toBe('dispatch-uuid-1')
      expect(result!.trackerSessionId).toBe('tracker-shared')
    })

    it('overwrites a stale persisted rowSessionId with the actual key', async () => {
      mockRedisGet.mockResolvedValue({
        trackerSessionId: 'tracker-shared',
        trackerProvider: 'linear',
        rowSessionId: 'stale-copy',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'pending',
        createdAt: 1000000,
        updatedAt: 1000001,
      })

      const result = await getSessionState('dispatch-uuid-1')

      expect(result!.rowSessionId).toBe('dispatch-uuid-1')
    })

    it('migrates legacy linearSessionId field on read', async () => {
      const legacy = {
        linearSessionId: 'session-legacy',
        issueId: 'issue-1',
        issueIdentifier: 'SUP-123',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'running',
        createdAt: 1000000,
        updatedAt: 1000001,
      }
      mockRedisGet.mockResolvedValue(legacy)

      const result = await getSessionState('session-legacy')

      expect(result).not.toBeNull()
      expect(result!.trackerSessionId).toBe('session-legacy')
      expect(result!.trackerProvider).toBe('linear')
      // deprecated alias still present for backward compat
      expect(result!.linearSessionId).toBe('session-legacy')
    })
  })

  describe('updateSessionStatus', () => {
    it('returns false when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await updateSessionStatus('session-1', 'running')
      expect(result).toBe(false)
    })

    it('returns false when session is not found', async () => {
      mockRedisEval.mockResolvedValue(-1)
      const result = await updateSessionStatus('nonexistent', 'running')
      expect(result).toBe(false)
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        ['agent:session:nonexistent'],
        ['running', '', expect.any(Number), 86400]
      )
    })

    it('applies the status patch atomically without rewriting other fields', async () => {
      mockRedisEval.mockResolvedValue(1)

      const result = await updateSessionStatus('session-1', 'running')

      expect(result).toBe(true)
      expect(mockRedisGet).not.toHaveBeenCalled()
      expect(mockRedisSet).not.toHaveBeenCalled()
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        ['agent:session:session-1'],
        ['running', '', expect.any(Number), 86400]
      )
    })

    it('throws on a malformed row instead of rewriting it', async () => {
      mockRedisEval.mockResolvedValue(-2)
      await expect(updateSessionStatus('session-1', 'running')).rejects.toThrow(
        /malformed/
      )
    })

    it('persists stoppedReason when provided', async () => {
      mockRedisEval.mockResolvedValue(1)

      const result = await updateSessionStatus('dispatch-uuid-1', 'stopped', {
        stoppedReason: 'Stranded per-dispatch row',
      })

      expect(result).toBe(true)
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        ['agent:session:dispatch-uuid-1'],
        ['stopped', 'Stranded per-dispatch row', expect.any(Number), 86400]
      )
    })
  })

  describe('getAllSessions', () => {
    it('derives rowSessionId from each Redis key, even when trackerSessionId differs', async () => {
      mockRedisKeys.mockResolvedValue([
        'agent:session:dispatch-uuid-1',
        'agent:session:tracker-shared',
      ])
      mockRedisGet.mockImplementation(async (key: string) => {
        const base = {
          trackerSessionId: 'tracker-shared',
          trackerProvider: 'linear',
          issueId: 'issue-1',
          providerSessionId: null,
          worktreePath: '/tmp/worktree',
          status: 'pending',
          createdAt: 1000000,
        }
        if (key === 'agent:session:dispatch-uuid-1') {
          return { ...base, updatedAt: 1000002 }
        }
        return { ...base, updatedAt: 1000001 }
      })

      const sessions = await getAllSessions()

      expect(sessions).toHaveLength(2)
      // Sorted by updatedAt desc — the per-dispatch row first
      expect(sessions[0]!.rowSessionId).toBe('dispatch-uuid-1')
      expect(sessions[0]!.trackerSessionId).toBe('tracker-shared')
      expect(sessions[1]!.rowSessionId).toBe('tracker-shared')
    })
  })

  describe('updateProviderSessionId', () => {
    it('returns false when session is not found', async () => {
      const mockGet = vi.fn(() => Promise.resolve(null))
      mockGetRedisClient.mockReturnValue({ get: mockGet } as never)
      const result = await updateProviderSessionId('nonexistent', 'provider-1')
      expect(result).toBe(false)
      expect(mockRedisEval).not.toHaveBeenCalled()
    })

    it('patches only the provider field losslessly through raw-string CAS', async () => {
      const stored = {
        trackerSessionId: 'session-1',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'running',
        createdAt: 1000000,
        updatedAt: 1000001,
        extra: { tags: [] as unknown[] },
        totalCostUsd: 1.2345678901234567,
        inputTokens: 9007199254740991,
      }
      const observed = JSON.stringify(stored)
      const mockGet = vi.fn(() => Promise.resolve(observed))
      mockGetRedisClient.mockReturnValue({ get: mockGet } as never)
      mockRedisEval.mockResolvedValue(1)

      const result = await updateProviderSessionId('session-1', 'provider-abc')

      expect(result).toBe(true)
      expect(mockRedisGet).not.toHaveBeenCalled()
      expect(mockRedisSet).not.toHaveBeenCalled()
      const [, keys, args] = mockRedisEval.mock.calls[0]!
      expect(keys).toEqual(['agent:session:session-1'])
      // First arg is the exact observed bytes the Lua guard compares.
      expect(args[0]).toBe(observed)
      const desired = JSON.parse(String(args[1])) as Record<string, unknown>
      expect(desired.providerSessionId).toBe('provider-abc')
      // Untouched data keeps JS JSON semantics: nested [] stays an array,
      // full numeric precision survives, unrelated fields are untouched.
      expect(desired.extra).toEqual({ tags: [] })
      expect(desired.totalCostUsd).toBe(1.2345678901234567)
      expect(desired.inputTokens).toBe(9007199254740991)
      expect(desired.status).toBe('running')
      expect(desired.worktreePath).toBe('/tmp/worktree')
    })

    it('throws on a malformed row instead of rewriting it', async () => {
      const mockGet = vi.fn(() => Promise.resolve('{not-json'))
      mockGetRedisClient.mockReturnValue({ get: mockGet } as never)
      await expect(
        updateProviderSessionId('session-1', 'provider-abc')
      ).rejects.toThrow(/malformed/)
      expect(mockRedisEval).not.toHaveBeenCalled()
    })
  })

  describe('updateSessionCostData', () => {
    it('returns false when session is not found', async () => {
      mockRedisEval.mockResolvedValue(-1)
      const result = await updateSessionCostData('nonexistent', {
        totalCostUsd: 1,
      })
      expect(result).toBe(false)
    })

    it('patches only cost fields atomically and reports the pre-patch total for quota', async () => {
      mockOnCostUpdated.mockResolvedValue(undefined)
      mockRedisEval.mockResolvedValue(
        JSON.stringify({ prevTotalCostUsd: 1.5, projectName: 'demo' })
      )

      const result = await updateSessionCostData('session-1', {
        totalCostUsd: 2.5,
        inputTokens: 100,
        outputTokens: 50,
      })

      expect(result).toBe(true)
      expect(mockRedisGet).not.toHaveBeenCalled()
      expect(mockRedisSet).not.toHaveBeenCalled()
      const [, keys, args] = mockRedisEval.mock.calls[0]!
      expect(keys).toEqual(['agent:session:session-1'])
      expect(JSON.parse(String(args[0]))).toEqual({
        totalCostUsd: 2.5,
        inputTokens: 100,
        outputTokens: 50,
      })
      expect(mockOnCostUpdated).toHaveBeenCalledWith('demo', 1.5, 2.5)    })

    it('throws on a malformed row instead of rewriting it', async () => {
      mockRedisEval.mockResolvedValue(-2)
      await expect(
        updateSessionCostData('session-1', { totalCostUsd: 1 })
      ).rejects.toThrow(/malformed/)
    })
  })

  describe('deleteSessionState', () => {
    it('calls redisDel with correct key', async () => {
      mockRedisDel.mockResolvedValue(1)

      const result = await deleteSessionState('session-1')

      expect(result).toBe(true)
      expect(mockRedisDel).toHaveBeenCalledWith('agent:session:session-1')
    })

    it('returns false when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await deleteSessionState('session-1')
      expect(result).toBe(false)
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it('returns false when key did not exist', async () => {
      mockRedisDel.mockResolvedValue(0)
      const result = await deleteSessionState('nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('touchSessionHeartbeat', () => {
    it('returns false when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await touchSessionHeartbeat('session-1')
      expect(result).toBe(false)
      expect(mockRedisEval).not.toHaveBeenCalled()
    })

    it('returns false when no row exists under the id', async () => {
      mockRedisEval.mockResolvedValue(-1)
      const result = await touchSessionHeartbeat('missing')
      expect(result).toBe(false)
    })

    it('refreshes a live row with one atomic command', async () => {
      mockRedisEval.mockResolvedValue(1)

      const result = await touchSessionHeartbeat('session-live')

      expect(result).toBe(true)
      expect(mockRedisGet).not.toHaveBeenCalled()
      expect(mockRedisSet).not.toHaveBeenCalled()
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        ['agent:session:session-live'],
        [expect.any(Number), 86400]
      )
    })

    it('refuses to touch terminal rows (never resurrects a dead session)', async () => {
      for (const scriptResult of [0]) {
        mockRedisEval.mockClear()
        mockRedisEval.mockResolvedValue(scriptResult)

        const result = await touchSessionHeartbeat('session-done')

        expect(result).toBe(false)
        expect(mockRedisEval).toHaveBeenCalledTimes(1)
      }
    })

    it('treats a malformed row as a non-refresh so the heartbeat loop survives', async () => {
      mockRedisEval.mockResolvedValue(-2)
      const result = await touchSessionHeartbeat('session-bad')
      expect(result).toBe(false)
    })
  })

  describe('resetSessionForRequeue', () => {
    it('returns false when session is not found', async () => {
      mockRedisGet.mockResolvedValue(null)
      const result = await resetSessionForRequeue('nonexistent')
      expect(result).toBe(false)
      expect(mockRedisEval).not.toHaveBeenCalled()
    })

    it('resets via one atomic command without reading other fields', async () => {
      mockRedisGet.mockResolvedValue({
        trackerSessionId: 'session-1',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'running',
        workerId: 'worker-old',
        createdAt: 1000000,
        updatedAt: 1000001,
      })
      mockRedisEval.mockResolvedValue(1)

      const result = await resetSessionForRequeue('session-1')

      expect(result).toBe(true)
      expect(mockRedisSet).not.toHaveBeenCalled()
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        ['agent:session:session-1'],
        [expect.any(Number), 86400]
      )
    })
  })

  describe('transferSessionOwnership', () => {
    it('returns false when session is not found', async () => {
      mockRedisEval.mockResolvedValue(-1)
      const result = await transferSessionOwnership(
        'nonexistent',
        'worker-new',
        'worker-old'
      )
      expect(result).toEqual({
        transferred: false,
        reason: 'Session not found',
      })
    })

    it('transfers with an atomic owner check', async () => {
      mockRedisEval.mockResolvedValue(1)

      const result = await transferSessionOwnership(
        'session-1',
        'worker-new',
        'worker-old'
      )

      expect(result).toEqual({ transferred: true })
      expect(mockRedisSet).not.toHaveBeenCalled()
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        ['agent:session:session-1'],
        ['worker-new', 'worker-old', expect.any(Number), 86400]
      )
    })

    it('rejects a stale transfer against a newer owner', async () => {
      mockRedisEval.mockResolvedValue(0)
      mockRedisGet.mockResolvedValue({
        trackerSessionId: 'session-1',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '/tmp/worktree',
        status: 'running',
        workerId: 'worker-newer',
        createdAt: 1000000,
        updatedAt: 1000001,
      })

      const result = await transferSessionOwnership(
        'session-1',
        'worker-new',
        'worker-old'
      )

      expect(result.transferred).toBe(false)
      expect(result.reason).toContain('worker-newer')
    })
  })

  describe('worker lifecycle transitions', () => {
    it('prevents a stale pending start snapshot from overwriting a completed claim', async () => {
      let stored: AgentSessionState = {
        trackerSessionId: 'session-race',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '',
        status: 'pending',
        createdAt: 1_000_000,
        updatedAt: 1_000_000,
      }

      let signalRunningWrite!: () => void
      const runningWriteEntered = new Promise<void>((resolve) => {
        signalRunningWrite = resolve
      })
      let releaseRunningWrite!: () => void
      const runningWriteRelease = new Promise<void>((resolve) => {
        releaseRunningWrite = resolve
      })

      mockRedisGet.mockImplementation(async () => ({ ...stored }))
      mockRedisSet.mockImplementation(async (_key, value) => {
        const next = value as AgentSessionState
        if (next.status === 'running' && next.claimedAt === undefined) {
          signalRunningWrite()
          await runningWriteRelease
        }
        stored = { ...next }
      })
      mockRedisEval.mockImplementation(async (_script, _keys, args) => {
        const [transition, workerId, value, now] = args

        if (transition === 'start') {
          if (
            stored.status !== 'claimed' ||
            stored.workerId !== workerId ||
            typeof stored.claimedAt !== 'number'
          ) {
            return 0
          }
          stored = {
            ...stored,
            status: 'running',
            worktreePath: String(value),
            updatedAt: Number(now),
          }
          return 1
        }

        if (transition === 'claim') {
          if (stored.status !== 'pending') return 0
          stored = {
            ...stored,
            status: 'claimed',
            workerId: String(workerId),
            claimedAt: Number(now),
            updatedAt: Number(now),
          }
          return 1
        }

        return 0
      })

      const staleStart = startSession(
        'session-race',
        'worker-claiming',
        '/tmp/worktree'
      )
      const firstOutcome = await Promise.race([
        runningWriteEntered.then(() => 'stale-write' as const),
        staleStart.then(() => 'start-completed' as const),
      ])

      if (firstOutcome === 'stale-write') {
        expect(await claimSession('session-race', 'worker-claiming')).toBe(true)
        releaseRunningWrite()
        await staleStart
      } else {
        expect(await staleStart).toBe(false)
        expect(await claimSession('session-race', 'worker-claiming')).toBe(true)
      }

      expect(stored).toMatchObject({
        status: 'claimed',
        workerId: 'worker-claiming',
        claimedAt: expect.any(Number),
      })

      const exactClaimedAt = stored.claimedAt
      expect(
        await startSession('session-race', 'worker-other', '/tmp/wrong-worker')
      ).toBe(false)
      expect(stored).toMatchObject({
        status: 'claimed',
        workerId: 'worker-claiming',
        claimedAt: exactClaimedAt,
      })

      stored = { ...stored, claimedAt: undefined }
      expect(
        await startSession('session-race', 'worker-claiming', '/tmp/no-claim')
      ).toBe(false)
      expect(stored.status).toBe('claimed')
      expect(stored.claimedAt).toBeUndefined()

      stored = { ...stored, claimedAt: exactClaimedAt }
      expect(
        await startSession('session-race', 'worker-claiming', '/tmp/worktree')
      ).toBe(true)
      expect(stored).toMatchObject({
        status: 'running',
        workerId: 'worker-claiming',
        worktreePath: '/tmp/worktree',
        claimedAt: exactClaimedAt,
      })
    })

    it('allows only one worker to atomically claim a pending row', async () => {
      let stored: AgentSessionState = {
        trackerSessionId: 'session-double-claim',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '',
        status: 'pending',
        createdAt: 1_000_000,
        updatedAt: 1_000_000,
      }

      let releaseReads!: () => void
      const readsReleased = new Promise<void>((resolve) => {
        releaseReads = resolve
      })
      let readCount = 0
      mockRedisGet.mockImplementation(async () => {
        const snapshot = { ...stored }
        readCount += 1
        if (readCount === 2) releaseReads()
        await readsReleased
        return snapshot
      })
      mockRedisSet.mockImplementation(async (_key, value) => {
        stored = { ...(value as AgentSessionState) }
      })
      mockRedisEval.mockImplementation(async (_script, _keys, args) => {
        const [transition, workerId, _value, now] = args
        if (
          transition !== 'claim' ||
          stored.status !== 'pending'
        ) {
          return 0
        }
        stored = {
          ...stored,
          status: 'claimed',
          workerId: String(workerId),
          claimedAt: Number(now),
          updatedAt: Number(now),
        }
        return 1
      })

      const results = await Promise.all([
        claimSession('session-double-claim', 'worker-first'),
        claimSession('session-double-claim', 'worker-second'),
      ])

      expect(results).toEqual([true, false])
      expect(stored).toMatchObject({
        status: 'claimed',
        workerId: 'worker-first',
        claimedAt: expect.any(Number),
      })
    })
  })
})
