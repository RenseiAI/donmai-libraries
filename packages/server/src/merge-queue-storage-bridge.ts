/**
 * Bridge: MergeQueueStorage → LocalMergeQueueStorage
 *
 * Adapts the server's Redis-backed MergeQueueStorage to implement the
 * LocalMergeQueueStorage interface expected by the core package's
 * LocalMergeQueueAdapter. This allows the local merge queue to use
 * the existing Redis infrastructure without the core package depending
 * on the server package directly.
 *
 * Usage:
 *   import { MergeQueueStorage } from './merge-queue-storage.js'
 *   import { createLocalMergeQueueStorage } from './merge-queue-storage-bridge.js'
 *
 *   const storage = new MergeQueueStorage()
 *   const localStorage = createLocalMergeQueueStorage(storage)
 *   // Pass localStorage as mergeQueueStorage in OrchestratorConfig
 */

import type { LocalMergeQueueStorage } from '@donmai/core'
import type { MergeQueueStorage } from './merge-queue-storage.js'

/**
 * Create a LocalMergeQueueStorage backed by the server's MergeQueueStorage.
 */
export function createLocalMergeQueueStorage(storage: MergeQueueStorage): LocalMergeQueueStorage {
  return {
    async enqueue(entry) {
      await storage.enqueue({
        ...entry,
        enqueuedAt: Date.now(),
      })
    },

    async dequeue(repoId) {
      const entry = await storage.dequeue(repoId)
      return entry ? { prNumber: entry.prNumber } : null
    },

    async getQueueDepth(repoId) {
      const status = await storage.getStatus(repoId)
      return status.depth
    },

    async isEnqueued(repoId, prNumber) {
      return storage.isEnqueued(repoId, prNumber)
    },

    async getPosition(repoId, prNumber) {
      return storage.getPosition(repoId, prNumber)
    },

    async remove(repoId, prNumber) {
      await storage.skip(repoId, prNumber)
    },

    async getFailedReason(repoId, prNumber) {
      return storage.getFailedReason(repoId, prNumber)
    },

    async getBlockedReason(repoId, prNumber) {
      return storage.getBlockedReason(repoId, prNumber)
    },

    async peekAll(repoId) {
      const entries = await storage.peekAll(repoId)
      return entries.map(e => ({ prNumber: e.prNumber, sourceBranch: e.sourceBranch }))
    },

    async dequeueBatch(repoId, prNumbers) {
      const entries = await storage.dequeueBatch(repoId, prNumbers)
      return entries.map(e => ({ prNumber: e.prNumber }))
    },
  }
}
