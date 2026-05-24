import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockXadd = vi.fn()
const mockXrange = vi.fn((): [string, string[]][] => [])
const mockXrevrange = vi.fn((): [string, string[]][] => [])

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  getRedisClient: vi.fn(() => ({
    xadd: mockXadd,
    xrange: mockXrange,
    xrevrange: mockXrevrange,
  })),
}))

import { createRedisObservationStore } from './routing-observation-store.js'
import { isRedisConfigured } from './redis.js'
import type { RoutingObservation } from '@donmai/core'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)

function makeObservation(overrides?: Partial<RoutingObservation>): RoutingObservation {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    provider: 'claude',
    workType: 'development',
    issueIdentifier: 'SUP-100',
    sessionId: 'session-abc-123',
    reward: 0.85,
    taskCompleted: true,
    prCreated: true,
    qaResult: 'passed',
    totalCostUsd: 0.42,
    wallClockMs: 120000,
    timestamp: 1700000000,
    confidence: 0.9,
    ...overrides,
  }
}

/**
 * Build a mock Redis Stream entry in the format returned by ioredis:
 * [streamId, [field1, value1, field2, value2, ...]]
 */
function makeStreamEntry(obs: RoutingObservation, streamId = '1700000000000-0'): [string, string[]] {
  const fields: string[] = [
    'id', obs.id,
    'provider', obs.provider,
    'workType', obs.workType,
    'issueIdentifier', obs.issueIdentifier,
    'sessionId', obs.sessionId,
    'reward', String(obs.reward),
    'taskCompleted', String(obs.taskCompleted),
    'prCreated', String(obs.prCreated),
    'qaResult', obs.qaResult,
    'totalCostUsd', String(obs.totalCostUsd),
    'wallClockMs', String(obs.wallClockMs),
    'timestamp', String(obs.timestamp),
    'confidence', String(obs.confidence),
  ]

  if (obs.project !== undefined) {
    fields.push('project', obs.project)
  }
  if (obs.explorationReason !== undefined) {
    fields.push('explorationReason', obs.explorationReason)
  }

  return [streamId, fields]
}

describe('routing-observation-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockXadd.mockResolvedValue('1700000000000-0')
    mockXrange.mockResolvedValue([])
    mockXrevrange.mockResolvedValue([])
  })

  describe('recordObservation', () => {
    it('calls XADD with correct stream key and MAXLEN', async () => {
      const store = createRedisObservationStore()
      const obs = makeObservation()
      await store.recordObservation(obs)

      expect(mockXadd).toHaveBeenCalledTimes(1)
      const args = mockXadd.mock.calls[0]!
      expect(args[0]).toBe('routing:observations')
      expect(args[1]).toBe('MAXLEN')
      expect(args[2]).toBe('~')
      expect(args[3]).toBe('10000')
      expect(args[4]).toBe('*')
      // Remaining args are field-value pairs
      expect(args).toContain('id')
      expect(args).toContain(obs.id)
      expect(args).toContain('provider')
      expect(args).toContain('claude')
      expect(args).toContain('workType')
      expect(args).toContain('development')
      expect(args).toContain('reward')
      expect(args).toContain('0.85')
      expect(args).toContain('taskCompleted')
      expect(args).toContain('true')
    })

    it('uses custom maxStreamLength when provided', async () => {
      const store = createRedisObservationStore({ maxStreamLength: 5000 })
      await store.recordObservation(makeObservation())

      const args = mockXadd.mock.calls[0]!
      expect(args[3]).toBe('5000')
    })

    it('serializes optional fields when present', async () => {
      const store = createRedisObservationStore()
      const obs = makeObservation({ project: 'AgentFactory', explorationReason: 'forced' })
      await store.recordObservation(obs)

      const args = mockXadd.mock.calls[0]!
      expect(args).toContain('project')
      expect(args).toContain('AgentFactory')
      expect(args).toContain('explorationReason')
      expect(args).toContain('forced')
    })

    it('omits optional fields when not present', async () => {
      const store = createRedisObservationStore()
      const obs = makeObservation()
      // Ensure no project or explorationReason
      delete (obs as unknown as Record<string, unknown>).project
      delete (obs as unknown as Record<string, unknown>).explorationReason
      await store.recordObservation(obs)

      const args = mockXadd.mock.calls[0]!
      expect(args).not.toContain('project')
      expect(args).not.toContain('explorationReason')
    })

    it('is a no-op when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const store = createRedisObservationStore()
      await store.recordObservation(makeObservation())
      expect(mockXadd).not.toHaveBeenCalled()
    })

    it('throws when XADD fails', async () => {
      mockXadd.mockRejectedValue(new Error('Redis connection lost'))
      const store = createRedisObservationStore()
      await expect(store.recordObservation(makeObservation())).rejects.toThrow('Redis connection lost')
    })
  })

  describe('getObservations', () => {
    it('calls XREVRANGE with full range when no filters', async () => {
      const store = createRedisObservationStore()
      await store.getObservations({})

      expect(mockXrevrange).toHaveBeenCalledWith(
        'routing:observations',
        '+',
        '-',
        'COUNT',
        expect.any(Number),
      )
    })

    it('uses since-based low bound when since filter is provided', async () => {
      const store = createRedisObservationStore()
      await store.getObservations({ since: 1700000000 })

      expect(mockXrevrange).toHaveBeenCalledWith(
        'routing:observations',
        '+',
        '1700000000-0',
        'COUNT',
        expect.any(Number),
      )
    })

    it('uses from/to for time-range bounds', async () => {
      const store = createRedisObservationStore()
      await store.getObservations({ from: 1000, to: 2000 })

      expect(mockXrevrange).toHaveBeenCalledWith(
        'routing:observations',
        '2000-18446744073709551615',
        '1000-0',
        'COUNT',
        expect.any(Number),
      )
    })

    it('uses cursor to set high bound (exclusive)', async () => {
      const store = createRedisObservationStore()
      await store.getObservations({ cursor: '1700000000000-5' })

      // cursor 1700000000000-5 decremented -> 1700000000000-4
      expect(mockXrevrange).toHaveBeenCalledWith(
        'routing:observations',
        '1700000000000-4',
        '-',
        'COUNT',
        expect.any(Number),
      )
    })

    it('returns parsed observations from stream entries', async () => {
      const obs = makeObservation()
      mockXrevrange.mockResolvedValue([makeStreamEntry(obs)])

      const store = createRedisObservationStore()
      const result = await store.getObservations({})

      expect(result.observations).toHaveLength(1)
      expect(result.observations[0]).toEqual(obs)
    })

    it('parses optional fields correctly', async () => {
      const obs = makeObservation({ project: 'MyProject', explorationReason: 'uncertainty' })
      mockXrevrange.mockResolvedValue([makeStreamEntry(obs)])

      const store = createRedisObservationStore()
      const result = await store.getObservations({})

      expect(result.observations[0]!.project).toBe('MyProject')
      expect(result.observations[0]!.explorationReason).toBe('uncertainty')
    })

    it('filters by provider in application code', async () => {
      const claudeObs = makeObservation({ provider: 'claude' })
      const codexObs = makeObservation({ provider: 'codex' })
      mockXrevrange.mockResolvedValue([
        makeStreamEntry(claudeObs, '2-0'),
        makeStreamEntry(codexObs, '1-0'),
      ])

      const store = createRedisObservationStore()
      const result = await store.getObservations({ provider: 'claude' })

      expect(result.observations).toHaveLength(1)
      expect(result.observations[0]!.provider).toBe('claude')
    })

    it('filters by workType in application code', async () => {
      const devObs = makeObservation({ workType: 'development' })
      const qaObs = makeObservation({ workType: 'qa' })
      mockXrevrange.mockResolvedValue([
        makeStreamEntry(devObs, '2-0'),
        makeStreamEntry(qaObs, '1-0'),
      ])

      const store = createRedisObservationStore()
      const result = await store.getObservations({ workType: 'qa' })

      expect(result.observations).toHaveLength(1)
      expect(result.observations[0]!.workType).toBe('qa')
    })

    it('respects limit after filtering', async () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeStreamEntry(makeObservation({ timestamp: 5 - i }), `${5 - i}-0`),
      )
      mockXrevrange.mockResolvedValue(entries)

      const store = createRedisObservationStore()
      const result = await store.getObservations({ limit: 2 })

      expect(result.observations).toHaveLength(2)
    })

    it('returns nextCursor when more results exist', async () => {
      // Create enough entries to exceed the limit
      const entries = Array.from({ length: 4 }, (_, i) =>
        makeStreamEntry(makeObservation({ timestamp: 4 - i }), `${4 - i}-0`),
      )
      mockXrevrange.mockResolvedValue(entries)

      const store = createRedisObservationStore()
      const result = await store.getObservations({ limit: 3 })

      expect(result.observations).toHaveLength(3)
      expect(result.nextCursor).toBe('2-0')
    })

    it('does not return nextCursor when all results fit', async () => {
      const entries = Array.from({ length: 2 }, (_, i) =>
        makeStreamEntry(makeObservation({ timestamp: 2 - i }), `${2 - i}-0`),
      )
      mockXrevrange.mockResolvedValue(entries)

      const store = createRedisObservationStore()
      const result = await store.getObservations({ limit: 5 })

      expect(result.observations).toHaveLength(2)
      expect(result.nextCursor).toBeUndefined()
    })

    it('returns empty result when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const store = createRedisObservationStore()
      const result = await store.getObservations({})
      expect(result).toEqual({ observations: [] })
      expect(mockXrevrange).not.toHaveBeenCalled()
    })

    it('returns empty result on error', async () => {
      mockXrevrange.mockRejectedValue(new Error('Redis timeout'))
      const store = createRedisObservationStore()
      const result = await store.getObservations({})
      expect(result).toEqual({ observations: [] })
    })
  })

  describe('getRecentObservations', () => {
    it('calls XREVRANGE for newest-first ordering', async () => {
      const store = createRedisObservationStore()
      await store.getRecentObservations('claude', 'development', 10)

      expect(mockXrevrange).toHaveBeenCalledWith(
        'routing:observations',
        '+',
        '-',
        'COUNT',
        50, // windowSize * 5
      )
    })

    it('filters by provider and workType', async () => {
      const match = makeObservation({ provider: 'claude', workType: 'development' })
      const noMatch1 = makeObservation({ provider: 'codex', workType: 'development' })
      const noMatch2 = makeObservation({ provider: 'claude', workType: 'qa' })
      mockXrevrange.mockResolvedValue([
        makeStreamEntry(match, '3-0'),
        makeStreamEntry(noMatch1, '2-0'),
        makeStreamEntry(noMatch2, '1-0'),
      ])

      const store = createRedisObservationStore()
      const result = await store.getRecentObservations('claude', 'development', 10)

      expect(result).toHaveLength(1)
      expect(result[0]!.provider).toBe('claude')
      expect(result[0]!.workType).toBe('development')
    })

    it('limits results to windowSize', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeStreamEntry(
          makeObservation({ provider: 'claude', workType: 'development', timestamp: 10 - i }),
          `${10 - i}-0`,
        ),
      )
      mockXrevrange.mockResolvedValue(entries)

      const store = createRedisObservationStore()
      const result = await store.getRecentObservations('claude', 'development', 3)

      expect(result).toHaveLength(3)
    })

    it('returns empty array when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const store = createRedisObservationStore()
      const result = await store.getRecentObservations('claude', 'development', 10)
      expect(result).toEqual([])
      expect(mockXrevrange).not.toHaveBeenCalled()
    })

    it('returns empty array on error', async () => {
      mockXrevrange.mockRejectedValue(new Error('Redis unavailable'))
      const store = createRedisObservationStore()
      const result = await store.getRecentObservations('claude', 'development', 10)
      expect(result).toEqual([])
    })

    it('caps fetch count to maxStreamLength', async () => {
      const store = createRedisObservationStore({ maxStreamLength: 100 })
      await store.getRecentObservations('claude', 'development', 50)

      expect(mockXrevrange).toHaveBeenCalledWith(
        'routing:observations',
        '+',
        '-',
        'COUNT',
        100, // min(50 * 5, 100) = 100
      )
    })
  })
})
