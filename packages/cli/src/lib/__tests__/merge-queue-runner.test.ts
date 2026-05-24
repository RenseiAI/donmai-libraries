import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetStatus = vi.fn()
const mockList = vi.fn()
const mockListFailed = vi.fn()
const mockListBlocked = vi.fn()
const mockRetry = vi.fn()
const mockSkip = vi.fn()
const mockReorder = vi.fn()
const mockRedisSet = vi.fn()
const mockRedisDel = vi.fn()
const mockDisconnectRedis = vi.fn()
const mockIsRedisConfigured = vi.fn(() => true)

vi.mock('@donmai/server', () => ({
  MergeQueueStorage: vi.fn().mockImplementation(() => ({
    getStatus: mockGetStatus,
    list: mockList,
    listFailed: mockListFailed,
    listBlocked: mockListBlocked,
    retry: mockRetry,
    skip: mockSkip,
    reorder: mockReorder,
  })),
  isRedisConfigured: () => mockIsRedisConfigured(),
  disconnectRedis: () => mockDisconnectRedis(),
  redisSet: (...args: unknown[]) => mockRedisSet(...args),
  redisDel: (...args: unknown[]) => mockRedisDel(...args),
}))

// Import AFTER mock setup
import { parseArgs, formatAge, runMergeQueueCommand } from '../merge-queue-runner.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults repoId to "default"', () => {
    const result = parseArgs([])
    expect(result.repoId).toBe('default')
    expect(result.prNumber).toBeUndefined()
    expect(result.priority).toBeUndefined()
  })

  it('extracts repoId from --repo flag', () => {
    const result = parseArgs(['--repo', 'my-org/my-repo'])
    expect(result.repoId).toBe('my-org/my-repo')
  })

  it('extracts prNumber as first numeric argument', () => {
    const result = parseArgs(['42'])
    expect(result.prNumber).toBe(42)
  })

  it('extracts priority as second numeric argument', () => {
    const result = parseArgs(['42', '1'])
    expect(result.prNumber).toBe(42)
    expect(result.priority).toBe(1)
  })

  it('handles prNumber with --repo flag', () => {
    const result = parseArgs(['42', '--repo', 'my-org/my-repo'])
    expect(result.prNumber).toBe(42)
    expect(result.repoId).toBe('my-org/my-repo')
  })

  it('handles priority with --repo flag in between', () => {
    const result = parseArgs(['42', '--repo', 'my-org/my-repo', '3'])
    expect(result.prNumber).toBe(42)
    expect(result.priority).toBe(3)
    expect(result.repoId).toBe('my-org/my-repo')
  })
})

describe('formatAge', () => {
  it('formats seconds', () => {
    expect(formatAge(5_000)).toBe('5s')
    expect(formatAge(59_000)).toBe('59s')
  })

  it('formats minutes', () => {
    expect(formatAge(60_000)).toBe('1m')
    expect(formatAge(300_000)).toBe('5m')
  })

  it('formats hours and minutes', () => {
    expect(formatAge(3_600_000)).toBe('1h 0m')
    expect(formatAge(5_400_000)).toBe('1h 30m')
  })

  it('formats days and hours', () => {
    expect(formatAge(86_400_000)).toBe('1d 0h')
    expect(formatAge(90_000_000)).toBe('1d 1h')
    expect(formatAge(172_800_000)).toBe('2d 0h')
  })
})

describe('runMergeQueueCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  describe('status', () => {
    it('prints queue status', async () => {
      mockGetStatus.mockResolvedValue({
        depth: 3,
        processing: { prNumber: 42, sourceBranch: 'feature/foo' },
        failedCount: 1,
        blockedCount: 0,
      })

      await runMergeQueueCommand({ command: 'status', args: [] })

      expect(mockGetStatus).toHaveBeenCalledWith('default')
      expect(mockDisconnectRedis).toHaveBeenCalled()

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Merge Queue Status')
      expect(output).toContain('3')
      expect(output).toContain('#42')
    })

    it('shows failed and blocked counts', async () => {
      mockGetStatus.mockResolvedValue({
        depth: 0,
        processing: null,
        failedCount: 2,
        blockedCount: 3,
      })

      await runMergeQueueCommand({ command: 'status', args: [] })

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('2')
      expect(output).toContain('3')
    })

    it('uses --repo flag', async () => {
      mockGetStatus.mockResolvedValue({
        depth: 0,
        processing: null,
        failedCount: 0,
        blockedCount: 0,
      })

      await runMergeQueueCommand({ command: 'status', args: ['--repo', 'my-org/repo'] })

      expect(mockGetStatus).toHaveBeenCalledWith('my-org/repo')
    })
  })

  describe('list', () => {
    it('prints empty message when no entries', async () => {
      mockList.mockResolvedValue([])

      await runMergeQueueCommand({ command: 'list', args: [] })

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('No PRs in merge queue')
    })

    it('prints entries table', async () => {
      const now = Date.now()
      mockList.mockResolvedValue([
        {
          prNumber: 42,
          sourceBranch: 'feature/foo',
          priority: 1,
          enqueuedAt: now - 60_000,
        },
        {
          prNumber: 99,
          sourceBranch: 'fix/bar',
          priority: 3,
          enqueuedAt: now - 3_600_000,
        },
      ])
      mockListFailed.mockResolvedValue([])
      mockListBlocked.mockResolvedValue([])

      await runMergeQueueCommand({ command: 'list', args: [] })

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Queued PRs')
      expect(output).toContain('#42')
      expect(output).toContain('#99')
      expect(output).toContain('feature/foo')
      expect(output).toContain('fix/bar')
    })

    it('shows failed and blocked PRs in list output', async () => {
      mockList.mockResolvedValue([
        {
          prNumber: 10,
          sourceBranch: 'feat/a',
          priority: 2,
          enqueuedAt: Date.now() - 5000,
        },
      ])
      mockListFailed.mockResolvedValue([
        {
          prNumber: 20,
          sourceBranch: 'feat/b',
          failureReason: 'CI failed',
        },
      ])
      mockListBlocked.mockResolvedValue([
        {
          prNumber: 30,
          sourceBranch: 'feat/c',
          blockReason: 'Merge conflict',
        },
      ])

      await runMergeQueueCommand({ command: 'list', args: [] })

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Failed PRs')
      expect(output).toContain('#20')
      expect(output).toContain('CI failed')
      expect(output).toContain('Blocked PRs')
      expect(output).toContain('#30')
      expect(output).toContain('Merge conflict')
    })
  })

  describe('retry', () => {
    it('calls storage.retry', async () => {
      await runMergeQueueCommand({ command: 'retry', args: ['42'] })

      expect(mockRetry).toHaveBeenCalledWith('default', 42)

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('PR #42 moved back to queue')
    })

    it('uses --repo flag with retry', async () => {
      await runMergeQueueCommand({ command: 'retry', args: ['42', '--repo', 'org/repo'] })

      expect(mockRetry).toHaveBeenCalledWith('org/repo', 42)
    })
  })

  describe('skip', () => {
    it('calls storage.skip', async () => {
      await runMergeQueueCommand({ command: 'skip', args: ['42'] })

      expect(mockSkip).toHaveBeenCalledWith('default', 42)

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('PR #42 removed from queue')
    })
  })

  describe('pause', () => {
    it('sets merge:paused key', async () => {
      await runMergeQueueCommand({ command: 'pause', args: [] })

      expect(mockRedisSet).toHaveBeenCalledWith('merge:paused:default', 'true')

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Merge queue paused')
    })

    it('uses --repo flag', async () => {
      await runMergeQueueCommand({ command: 'pause', args: ['--repo', 'org/repo'] })

      expect(mockRedisSet).toHaveBeenCalledWith('merge:paused:org/repo', 'true')
    })
  })

  describe('resume', () => {
    it('deletes merge:paused key', async () => {
      await runMergeQueueCommand({ command: 'resume', args: [] })

      expect(mockRedisDel).toHaveBeenCalledWith('merge:paused:default')

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Merge queue resumed')
    })
  })

  describe('priority', () => {
    it('calls storage.reorder', async () => {
      await runMergeQueueCommand({ command: 'priority', args: ['42', '1'] })

      expect(mockReorder).toHaveBeenCalledWith('default', 42, 1)

      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('PR #42 priority updated to 1')
    })
  })

  describe('redis error handling', () => {
    it('throws when REDIS_URL is not configured', async () => {
      mockIsRedisConfigured.mockReturnValueOnce(false)

      await expect(
        runMergeQueueCommand({ command: 'status', args: [] }),
      ).rejects.toThrow('REDIS_URL environment variable is not set')
    })
  })
})
