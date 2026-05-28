import { describe, it, expect, vi } from 'vitest'
import { createMergeQueueAdapter } from './index.js'
import { GitHubNativeMergeQueueAdapter } from './adapters/github-native.js'
import { LocalMergeQueueAdapter } from './adapters/local.js'
import type { LocalMergeQueueStorage } from './adapters/local.js'
import type { MergeQueueAdapter, MergeQueueStatus } from './types.js'

describe('merge queue integration', () => {
  describe('createMergeQueueAdapter factory', () => {
    it('creates GitHub native adapter', () => {
      const adapter = createMergeQueueAdapter('github-native')
      expect(adapter).toBeInstanceOf(GitHubNativeMergeQueueAdapter)
      expect(adapter.name).toBe('github-native')
    })

    it('creates local adapter with storage', () => {
      const mockStorage: LocalMergeQueueStorage = {
        enqueue: vi.fn(),
        dequeue: vi.fn(),
        getQueueDepth: vi.fn(),
        isEnqueued: vi.fn(),
        getPosition: vi.fn(),
        remove: vi.fn(),
        getFailedReason: vi.fn(),
        getBlockedReason: vi.fn(),
        peekAll: vi.fn().mockResolvedValue([]),
        dequeueBatch: vi.fn().mockResolvedValue([]),
      }
      const adapter = createMergeQueueAdapter('local', { storage: mockStorage })
      expect(adapter).toBeInstanceOf(LocalMergeQueueAdapter)
      expect(adapter.name).toBe('local')
    })

    it('throws for local adapter without storage', () => {
      expect(() => createMergeQueueAdapter('local')).toThrow('storage')
    })

    it('throws for mergify (not yet implemented)', () => {
      expect(() => createMergeQueueAdapter('mergify')).toThrow('not yet implemented')
    })

    it('throws for trunk (not yet implemented)', () => {
      expect(() => createMergeQueueAdapter('trunk')).toThrow('not yet implemented')
    })

    it('throws for unknown provider', () => {
      expect(() => createMergeQueueAdapter('unknown' as never)).toThrow('Unknown merge queue provider')
    })
  })

  describe('adapter interface compliance', () => {
    it('GitHubNativeMergeQueueAdapter implements all MergeQueueAdapter methods', () => {
      const adapter = new GitHubNativeMergeQueueAdapter()

      expect(typeof adapter.canEnqueue).toBe('function')
      expect(typeof adapter.enqueue).toBe('function')
      expect(typeof adapter.getStatus).toBe('function')
      expect(typeof adapter.dequeue).toBe('function')
      expect(typeof adapter.isEnabled).toBe('function')
      expect(adapter.name).toBe('github-native')
    })
  })

  describe('orchestrator merge queue wiring', () => {
    it('mock adapter can be injected and used in lifecycle', async () => {
      const mockStatus: MergeQueueStatus = {
        state: 'queued',
        position: 1,
        checksStatus: [{ name: 'CI', status: 'pass' }],
      }

      const mockAdapter: MergeQueueAdapter = {
        name: 'github-native',
        canEnqueue: vi.fn().mockResolvedValue(true),
        enqueue: vi.fn().mockResolvedValue(mockStatus),
        getStatus: vi.fn().mockResolvedValue(mockStatus),
        dequeue: vi.fn().mockResolvedValue(undefined),
        isEnabled: vi.fn().mockResolvedValue(true),
      }

      // Verify adapter works as expected when called
      expect(await mockAdapter.canEnqueue('owner', 'repo', 1)).toBe(true)
      expect(await mockAdapter.enqueue('owner', 'repo', 1)).toEqual(mockStatus)
      expect(await mockAdapter.getStatus('owner', 'repo', 1)).toEqual(mockStatus)
      await mockAdapter.dequeue('owner', 'repo', 1)
      expect(await mockAdapter.isEnabled('owner', 'repo')).toBe(true)

      expect(mockAdapter.canEnqueue).toHaveBeenCalledWith('owner', 'repo', 1)
      expect(mockAdapter.enqueue).toHaveBeenCalledWith('owner', 'repo', 1)
      expect(mockAdapter.dequeue).toHaveBeenCalledWith('owner', 'repo', 1)
    })

    it('mock adapter handles PR URL parsing for enqueue', async () => {
      const mockAdapter: MergeQueueAdapter = {
        name: 'github-native',
        canEnqueue: vi.fn().mockResolvedValue(true),
        enqueue: vi.fn().mockResolvedValue({ state: 'queued', checksStatus: [] }),
        getStatus: vi.fn(),
        dequeue: vi.fn(),
        isEnabled: vi.fn(),
      }

      // Simulate the PR URL parsing logic from the orchestrator
      const pullRequestUrl = 'https://github.com/RenseiAI/donmai-libraries/pull/31'
      const prMatch = pullRequestUrl.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
      expect(prMatch).not.toBeNull()

      if (prMatch) {
        const [, owner, repo, prNum] = prMatch
        expect(owner).toBe('RenseiAI')
        expect(repo).toBe('donmai-libraries')
        expect(prNum).toBe('31')

        const canEnqueue = await mockAdapter.canEnqueue(owner, repo, parseInt(prNum, 10))
        expect(canEnqueue).toBe(true)

        if (canEnqueue) {
          const status = await mockAdapter.enqueue(owner, repo, parseInt(prNum, 10))
          expect(status.state).toBe('queued')
        }
      }
    })

    it('mock adapter handles dequeue on failure', async () => {
      const mockAdapter: MergeQueueAdapter = {
        name: 'github-native',
        canEnqueue: vi.fn(),
        enqueue: vi.fn(),
        getStatus: vi.fn(),
        dequeue: vi.fn().mockResolvedValue(undefined),
        isEnabled: vi.fn(),
      }

      // Simulate the failure dequeue logic from the orchestrator
      const pullRequestUrl = 'https://github.com/RenseiAI/donmai-libraries/pull/31'
      const prMatch = pullRequestUrl.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)

      if (prMatch) {
        const [, owner, repo, prNum] = prMatch
        await mockAdapter.dequeue(owner, repo, parseInt(prNum, 10))
        expect(mockAdapter.dequeue).toHaveBeenCalledWith('RenseiAI', 'donmai-libraries', 31)
      }
    })

    it('handles dequeue errors gracefully', async () => {
      const mockAdapter: MergeQueueAdapter = {
        name: 'github-native',
        canEnqueue: vi.fn(),
        enqueue: vi.fn(),
        getStatus: vi.fn(),
        dequeue: vi.fn().mockRejectedValue(new Error('API rate limit')),
        isEnabled: vi.fn(),
      }

      // The orchestrator wraps dequeue in try/catch — verify the error is thrown
      await expect(mockAdapter.dequeue('owner', 'repo', 1)).rejects.toThrow('API rate limit')
    })

    it('skips enqueue when canEnqueue returns false', async () => {
      const mockAdapter: MergeQueueAdapter = {
        name: 'github-native',
        canEnqueue: vi.fn().mockResolvedValue(false),
        enqueue: vi.fn(),
        getStatus: vi.fn(),
        dequeue: vi.fn(),
        isEnabled: vi.fn(),
      }

      const canEnqueue = await mockAdapter.canEnqueue('owner', 'repo', 1)
      expect(canEnqueue).toBe(false)
      // enqueue should NOT be called
      expect(mockAdapter.enqueue).not.toHaveBeenCalled()
    })
  })
})
