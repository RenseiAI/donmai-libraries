/**
 * Redis-backed Processing State Storage
 *
 * Implements the `ProcessingStateStorage` interface from `@donmai/core`
 * using Redis for persistence. Used by the top-of-funnel governor to track
 * which processing phases (research, backlog-creation) have been completed
 * for each issue.
 *
 * Key format: `governor:processing:{issueId}:{phase}`
 * TTL: 30 days (matches workflow state TTL)
 */

import type {
  ProcessingStateStorage,
  ProcessingPhase,
  ProcessingRecord,
} from '@donmai/core'
import { redisSet, redisGet, redisDel, redisExists } from './redis.js'

// Redis key prefix for processing state records
const PROCESSING_STATE_PREFIX = 'governor:processing:'

// 30-day TTL in seconds
const PROCESSING_STATE_TTL = 30 * 24 * 60 * 60

/**
 * Build the Redis key for a specific issue + phase combination.
 */
function redisKey(issueId: string, phase: ProcessingPhase): string {
  return `${PROCESSING_STATE_PREFIX}${issueId}:${phase}`
}

/**
 * Redis-backed implementation of `ProcessingStateStorage`.
 *
 * Each phase completion is stored as an independent key so that phases
 * can be checked and cleared independently without affecting each other.
 */
export class RedisProcessingStateStorage implements ProcessingStateStorage {
  /**
   * Check whether a given phase has already been completed for an issue.
   */
  async isPhaseCompleted(
    issueId: string,
    phase: ProcessingPhase,
  ): Promise<boolean> {
    return redisExists(redisKey(issueId, phase))
  }

  /**
   * Mark a phase as completed for an issue.
   * Stores a `ProcessingRecord` JSON object with a 30-day TTL.
   */
  async markPhaseCompleted(
    issueId: string,
    phase: ProcessingPhase,
    sessionId?: string,
  ): Promise<void> {
    const record: ProcessingRecord = {
      issueId,
      phase,
      completedAt: Date.now(),
      sessionId,
    }
    await redisSet(redisKey(issueId, phase), record, PROCESSING_STATE_TTL)
  }

  /**
   * Clear a phase completion record for an issue.
   */
  async clearPhase(
    issueId: string,
    phase: ProcessingPhase,
  ): Promise<void> {
    await redisDel(redisKey(issueId, phase))
  }

  /**
   * Retrieve the processing record for a phase, if it exists.
   */
  async getPhaseRecord(
    issueId: string,
    phase: ProcessingPhase,
  ): Promise<ProcessingRecord | null> {
    return redisGet<ProcessingRecord>(redisKey(issueId, phase))
  }
}
