/**
 * Redis Token Bucket Rate Limiter
 *
 * Atomic token bucket implementation using Redis + Lua script.
 * All processes (dashboard, governor, CLI agents) share one bucket
 * keyed by `linear:rate-limit:{workspaceId}`.
 *
 * Implements RateLimiterStrategy from @donmai/plugin-linear
 * so it can be injected into LinearAgentClient.
 */

import { getRedisClient } from './redis.js'
import { createLogger } from './logger.js'
import type { RateLimiterStrategy } from '@donmai/plugin-linear'

const log = createLogger('redis-rate-limiter')

export interface RedisTokenBucketConfig {
  /** Redis key for this bucket (default: 'linear:rate-limit:default') */
  key: string
  /** Maximum tokens (burst capacity). Default: 80 */
  maxTokens: number
  /** Tokens added per second. Default: 1.5 (~90/min) */
  refillRate: number
  /** Maximum time to wait for a token before throwing (ms). Default: 30_000 */
  acquireTimeoutMs: number
  /** Polling interval when waiting for tokens (ms). Default: 500 */
  pollIntervalMs: number
}

export const DEFAULT_REDIS_RATE_LIMIT_CONFIG: RedisTokenBucketConfig = {
  key: 'linear:rate-limit:default',
  maxTokens: 80,
  refillRate: 1.5,
  acquireTimeoutMs: 30_000,
  pollIntervalMs: 500,
}

/**
 * Lua script for atomic token bucket acquire.
 *
 * KEYS[1] = bucket key (hash with fields: tokens, last_refill, penalty_until)
 * ARGV[1] = maxTokens
 * ARGV[2] = refillRate (tokens per second)
 * ARGV[3] = current timestamp (ms)
 *
 * Returns: 1 if token acquired, 0 if no tokens available
 */
const ACQUIRE_LUA = `
local key = KEYS[1]
local maxTokens = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Initialize bucket if it doesn't exist
local tokens = tonumber(redis.call('HGET', key, 'tokens'))
local lastRefill = tonumber(redis.call('HGET', key, 'last_refill'))
local penaltyUntil = tonumber(redis.call('HGET', key, 'penalty_until')) or 0

if tokens == nil then
  tokens = maxTokens
  lastRefill = now
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', lastRefill, 'penalty_until', 0)
  redis.call('EXPIRE', key, 3600)
end

-- Check if we're in a penalty period
if now < penaltyUntil then
  return 0
end

-- Refill tokens based on elapsed time
local elapsed = (now - lastRefill) / 1000.0
if elapsed > 0 then
  local newTokens = elapsed * refillRate
  tokens = math.min(maxTokens, tokens + newTokens)
  lastRefill = now
end

-- Try to acquire a token
if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', lastRefill)
  redis.call('EXPIRE', key, 3600)
  return 1
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', lastRefill)
redis.call('EXPIRE', key, 3600)
return 0
`

/**
 * Lua script for penalizing the bucket (after rate limit response).
 *
 * KEYS[1] = bucket key
 * ARGV[1] = penalty duration (seconds)
 * ARGV[2] = current timestamp (ms)
 */
const PENALIZE_LUA = `
local key = KEYS[1]
local penaltySeconds = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

redis.call('HMSET', key, 'tokens', 0, 'penalty_until', now + (penaltySeconds * 1000))
redis.call('EXPIRE', key, 3600)
return 1
`

export class RedisTokenBucket implements RateLimiterStrategy {
  private readonly config: RedisTokenBucketConfig

  constructor(config?: Partial<RedisTokenBucketConfig>) {
    this.config = { ...DEFAULT_REDIS_RATE_LIMIT_CONFIG, ...config }
  }

  /**
   * Acquire a single token. Polls Redis until a token is available
   * or the acquire timeout is reached.
   */
  async acquire(): Promise<void> {
    const start = Date.now()

    while (true) {
      const acquired = await this.tryAcquire()
      if (acquired) return

      // Check timeout
      if (Date.now() - start > this.config.acquireTimeoutMs) {
        throw new Error(
          `RedisTokenBucket: timed out waiting for rate limit token after ${this.config.acquireTimeoutMs}ms`
        )
      }

      // Wait before polling again
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.config.pollIntervalMs)
      )
    }
  }

  /**
   * Penalize the bucket after receiving a rate limit response.
   * Drains all tokens and sets a penalty period.
   */
  async penalize(seconds: number): Promise<void> {
    try {
      const redis = getRedisClient()
      await redis.eval(
        PENALIZE_LUA,
        1,
        this.config.key,
        String(seconds),
        String(Date.now())
      )
      log.warn('Rate limit penalty applied', { seconds, key: this.config.key })
    } catch (err) {
      log.error('Failed to apply rate limit penalty', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Try to acquire a token atomically. Returns true if acquired.
   */
  private async tryAcquire(): Promise<boolean> {
    try {
      const redis = getRedisClient()
      const result = await redis.eval(
        ACQUIRE_LUA,
        1,
        this.config.key,
        String(this.config.maxTokens),
        String(this.config.refillRate),
        String(Date.now())
      )
      return result === 1
    } catch (err) {
      // If Redis is down, allow the request (fail open for rate limiting)
      log.error('Redis rate limiter error, failing open', {
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }

  /**
   * Get the current token count (for monitoring).
   */
  async getAvailableTokens(): Promise<number> {
    try {
      const redis = getRedisClient()
      const tokens = await redis.hget(this.config.key, 'tokens')
      return tokens ? parseFloat(tokens) : this.config.maxTokens
    } catch {
      return -1
    }
  }
}

/**
 * Create a Redis token bucket for a specific workspace.
 */
export function createRedisTokenBucket(
  workspaceId: string,
  config?: Partial<Omit<RedisTokenBucketConfig, 'key'>>
): RedisTokenBucket {
  return new RedisTokenBucket({
    ...config,
    key: `linear:rate-limit:${workspaceId}`,
  })
}
