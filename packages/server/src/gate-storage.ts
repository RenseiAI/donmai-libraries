/**
 * Gate Storage — Redis Implementation
 *
 * Redis-backed storage adapter for gate lifecycle state.
 * Implements the GateStorage interface from @donmai/core (packages/core).
 */

import type { GateStorage, GateState } from '@donmai/core'
import { redisSet, redisGet, redisDel, redisKeys } from './redis.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[gate-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[gate-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[gate-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/** Redis key prefix for gate state */
const GATE_STATE_PREFIX = 'gate:state:'

/** TTL for gate state: 30 days in seconds */
const GATE_STATE_TTL = 30 * 24 * 60 * 60

/**
 * Redis-backed gate storage for production use.
 *
 * Stores gate state under `gate:state:{issueId}:{gateName}` keys
 * with a 30-day TTL.
 */
export class RedisGateStorage implements GateStorage {
  /**
   * Get the state of a specific gate for an issue from Redis
   */
  async getGateState(issueId: string, gateName: string): Promise<GateState | null> {
    const key = `${GATE_STATE_PREFIX}${issueId}:${gateName}`
    const state = await redisGet<GateState>(key)

    if (state) {
      log.debug('Retrieved gate state', { issueId, gateName, status: state.status })
    }

    return state
  }

  /**
   * Persist gate state for an issue to Redis
   */
  async setGateState(issueId: string, gateName: string, state: GateState): Promise<void> {
    const key = `${GATE_STATE_PREFIX}${issueId}:${gateName}`
    await redisSet(key, state, GATE_STATE_TTL)
    log.info('Stored gate state', { issueId, gateName, status: state.status })
  }

  /**
   * Get all active gates for an issue from Redis.
   * Uses Redis KEYS to find all gate entries for the issue, then filters for active status.
   */
  async getActiveGates(issueId: string): Promise<GateState[]> {
    const pattern = `${GATE_STATE_PREFIX}${issueId}:*`
    const keys = await redisKeys(pattern)

    if (keys.length === 0) {
      return []
    }

    const results: GateState[] = []

    for (const key of keys) {
      const state = await redisGet<GateState>(key)
      if (state && state.status === 'active') {
        results.push(state)
      }
    }

    log.debug('Retrieved active gates', { issueId, count: results.length })
    return results
  }

  /**
   * Remove all gate states for an issue from Redis
   */
  async clearGateStates(issueId: string): Promise<void> {
    const pattern = `${GATE_STATE_PREFIX}${issueId}:*`
    const keys = await redisKeys(pattern)

    for (const key of keys) {
      await redisDel(key)
    }

    log.info('Cleared gate states', { issueId, count: keys.length })
  }
}
