import { isRedisConfigured, redisSet, redisGet, redisDel, redisKeys } from './redis.js'
import type { AgentWorkType } from './types.js'
import type { AgentProviderName } from '@donmai/core'
import type { RoutingPosterior } from '@donmai/core'
import type { PosteriorStore } from '@donmai/core'
import { defaultPosterior, ROUTING_KEYS } from '@donmai/core'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/**
 * Redis-backed posterior store for Thompson Sampling routing.
 *
 * Stores Beta distribution state per provider x workType combination.
 * Follows the same patterns as session-storage.ts (graceful degradation,
 * redisSet/redisGet helpers, log pattern).
 */
export class RedisPosteriorStore implements PosteriorStore {
  async getPosterior(provider: AgentProviderName, workType: AgentWorkType): Promise<RoutingPosterior> {
    if (!isRedisConfigured()) {
      log.debug('Redis not configured, returning default posterior')
      return defaultPosterior(provider, workType)
    }

    try {
      const key = ROUTING_KEYS.posteriors(provider, workType)
      const stored = await redisGet<RoutingPosterior>(key)

      if (stored) {
        log.debug('Retrieved posterior', { provider, workType })
        return stored
      }

      log.debug('No posterior found, returning default', { provider, workType })
      return defaultPosterior(provider, workType)
    } catch (error) {
      log.error('Failed to get posterior', { provider, workType, error: String(error) })
      return defaultPosterior(provider, workType)
    }
  }

  async updatePosterior(provider: AgentProviderName, workType: AgentWorkType, reward: number): Promise<RoutingPosterior> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot update posterior')
      return defaultPosterior(provider, workType)
    }

    try {
      const key = ROUTING_KEYS.posteriors(provider, workType)
      const existing = await redisGet<RoutingPosterior>(key) ?? defaultPosterior(provider, workType)

      // Update Beta distribution parameters
      // reward >= 0.5 is a "success" (adds to alpha), < 0.5 is a "failure" (adds to beta)
      if (reward >= 0.5) {
        existing.alpha += reward
      } else {
        existing.beta += (1 - reward)
      }

      // Update observation count and running average
      const newTotal = existing.totalObservations + 1
      existing.avgReward = ((existing.avgReward * existing.totalObservations) + reward) / newTotal
      existing.totalObservations = newTotal
      existing.lastUpdated = Date.now()

      await redisSet(key, existing)

      log.info('Updated posterior', {
        provider,
        workType,
        reward,
        alpha: existing.alpha,
        beta: existing.beta,
        totalObservations: existing.totalObservations,
      })

      return existing
    } catch (error) {
      log.error('Failed to update posterior', { provider, workType, reward, error: String(error) })
      return defaultPosterior(provider, workType)
    }
  }

  async getAllPosteriors(): Promise<RoutingPosterior[]> {
    if (!isRedisConfigured()) {
      log.debug('Redis not configured, returning empty posteriors list')
      return []
    }

    try {
      const keys = await redisKeys('routing:posteriors:*')
      const posteriors: RoutingPosterior[] = []

      for (const key of keys) {
        const posterior = await redisGet<RoutingPosterior>(key)
        if (posterior) {
          posteriors.push(posterior)
        }
      }

      return posteriors
    } catch (error) {
      log.error('Failed to get all posteriors', { error: String(error) })
      return []
    }
  }

  async resetPosterior(provider: AgentProviderName, workType: AgentWorkType): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot reset posterior')
      return
    }

    try {
      const key = ROUTING_KEYS.posteriors(provider, workType)
      await redisDel(key)

      log.info('Reset posterior', { provider, workType })
    } catch (error) {
      log.error('Failed to reset posterior', { provider, workType, error: String(error) })
    }
  }
}
