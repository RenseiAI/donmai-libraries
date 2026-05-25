/**
 * Governor Storage — Redis Implementation
 *
 * Redis-backed storage adapter for the human touchpoint override state.
 * Implements the OverrideStorage interface from @donmai/core (packages/core).
 */

import type { OverrideStorage, OverrideState } from '@donmai/core'
import { redisSet, redisGet, redisDel } from './redis.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[governor-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[governor-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[governor-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/** Redis key prefix for governor override state */
const GOVERNOR_OVERRIDE_PREFIX = 'governor:override:'

/** TTL for override state: 30 days in seconds */
const GOVERNOR_OVERRIDE_TTL = 30 * 24 * 60 * 60

/**
 * Redis-backed override storage for production use.
 *
 * Stores override state under `governor:override:{issueId}` keys
 * with a 30-day TTL.
 */
export class RedisOverrideStorage implements OverrideStorage {
  /**
   * Get the override state for an issue from Redis
   */
  async get(issueId: string): Promise<OverrideState | null> {
    const key = `${GOVERNOR_OVERRIDE_PREFIX}${issueId}`
    const state = await redisGet<OverrideState>(key)

    if (state) {
      log.debug('Retrieved override state', { issueId, type: state.directive.type })
    }

    return state
  }

  /**
   * Persist override state for an issue to Redis
   */
  async set(issueId: string, state: OverrideState): Promise<void> {
    const key = `${GOVERNOR_OVERRIDE_PREFIX}${issueId}`
    await redisSet(key, state, GOVERNOR_OVERRIDE_TTL)
    log.info('Stored override state', { issueId, type: state.directive.type })
  }

  /**
   * Remove override state for an issue from Redis
   */
  async clear(issueId: string): Promise<void> {
    const key = `${GOVERNOR_OVERRIDE_PREFIX}${issueId}`
    await redisDel(key)
    log.info('Cleared override state', { issueId })
  }
}
