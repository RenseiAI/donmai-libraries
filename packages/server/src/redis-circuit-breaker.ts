/**
 * Redis Circuit Breaker
 *
 * Shares circuit breaker state across processes via Redis.
 * All processes (dashboard, governor, CLI agents) see the same
 * circuit state for a workspace.
 *
 * Redis keys:
 * - `linear:circuit:{workspaceId}:state`    — 'closed' | 'open' | 'half-open'
 * - `linear:circuit:{workspaceId}:failures` — consecutive failure count (with TTL)
 * - `linear:circuit:{workspaceId}:opened_at` — timestamp when circuit was opened
 * - `linear:circuit:{workspaceId}:reset_timeout` — current reset timeout (for backoff)
 *
 * Implements CircuitBreakerStrategy from @donmai/plugin-linear
 * so it can be injected into LinearAgentClient.
 */

import { getRedisClient } from './redis.js'
import { createLogger } from './logger.js'
import type { CircuitBreakerStrategy, CircuitBreakerConfig } from '@donmai/plugin-linear'

const log = createLogger('redis-circuit-breaker')

export interface RedisCircuitBreakerConfig extends CircuitBreakerConfig {
  /** Workspace-specific key prefix */
  workspaceId: string
}

const DEFAULT_CONFIG: Omit<RedisCircuitBreakerConfig, 'workspaceId'> = {
  failureThreshold: 2,
  resetTimeoutMs: 60_000,
  maxResetTimeoutMs: 300_000,
  backoffMultiplier: 2,
  authErrorCodes: [400, 401, 403],
}

/**
 * Lua script for atomic circuit breaker state check.
 *
 * KEYS[1] = state key
 * KEYS[2] = opened_at key
 * KEYS[3] = reset_timeout key
 * ARGV[1] = current timestamp (ms)
 * ARGV[2] = default reset timeout (ms)
 *
 * Returns: 1 if call can proceed, 0 if blocked, 2 if probe (half-open)
 */
const CAN_PROCEED_LUA = `
local stateKey = KEYS[1]
local openedAtKey = KEYS[2]
local resetTimeoutKey = KEYS[3]
local now = tonumber(ARGV[1])
local defaultResetTimeout = tonumber(ARGV[2])

local state = redis.call('GET', stateKey)

-- Closed or no state: allow
if state == false or state == 'closed' then
  return 1
end

-- Open: check if reset timeout has elapsed
if state == 'open' then
  local openedAt = tonumber(redis.call('GET', openedAtKey)) or 0
  local resetTimeout = tonumber(redis.call('GET', resetTimeoutKey)) or defaultResetTimeout

  if (now - openedAt) >= resetTimeout then
    -- Transition to half-open: allow one probe
    redis.call('SET', stateKey, 'half-open', 'EX', 3600)
    return 2
  end

  return 0
end

-- Half-open: block (probe already in flight)
-- The first caller to see 'open' -> 'half-open' transition gets the probe
if state == 'half-open' then
  return 0
end

return 1
`

/**
 * Lua script for recording auth failure.
 *
 * KEYS[1] = state key
 * KEYS[2] = failures key
 * KEYS[3] = opened_at key
 * KEYS[4] = reset_timeout key
 * ARGV[1] = failure threshold
 * ARGV[2] = current timestamp (ms)
 * ARGV[3] = default reset timeout (ms)
 * ARGV[4] = backoff multiplier
 * ARGV[5] = max reset timeout (ms)
 *
 * Returns: new state ('closed', 'open')
 */
const RECORD_FAILURE_LUA = `
local stateKey = KEYS[1]
local failuresKey = KEYS[2]
local openedAtKey = KEYS[3]
local resetTimeoutKey = KEYS[4]
local threshold = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local defaultResetTimeout = tonumber(ARGV[3])
local backoffMultiplier = tonumber(ARGV[4])
local maxResetTimeout = tonumber(ARGV[5])

local state = redis.call('GET', stateKey) or 'closed'
local failures = tonumber(redis.call('INCR', failuresKey))
redis.call('EXPIRE', failuresKey, 3600)

-- If half-open: probe failed, reopen with backoff
if state == 'half-open' then
  local currentTimeout = tonumber(redis.call('GET', resetTimeoutKey)) or defaultResetTimeout
  local newTimeout = math.min(currentTimeout * backoffMultiplier, maxResetTimeout)
  redis.call('SET', stateKey, 'open', 'EX', 3600)
  redis.call('SET', openedAtKey, tostring(now), 'EX', 3600)
  redis.call('SET', resetTimeoutKey, tostring(newTimeout), 'EX', 3600)
  return 'open'
end

-- If closed and at threshold: trip to open
if failures >= threshold then
  redis.call('SET', stateKey, 'open', 'EX', 3600)
  redis.call('SET', openedAtKey, tostring(now), 'EX', 3600)
  redis.call('SET', resetTimeoutKey, tostring(defaultResetTimeout), 'EX', 3600)
  return 'open'
end

return 'closed'
`

export class RedisCircuitBreaker implements CircuitBreakerStrategy {
  private readonly config: RedisCircuitBreakerConfig
  private readonly keyPrefix: string

  constructor(config: Partial<RedisCircuitBreakerConfig> & { workspaceId: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.keyPrefix = `linear:circuit:${this.config.workspaceId}`
  }

  private get stateKey(): string {
    return `${this.keyPrefix}:state`
  }
  private get failuresKey(): string {
    return `${this.keyPrefix}:failures`
  }
  private get openedAtKey(): string {
    return `${this.keyPrefix}:opened_at`
  }
  private get resetTimeoutKey(): string {
    return `${this.keyPrefix}:reset_timeout`
  }

  /**
   * Check if a call is allowed to proceed.
   */
  async canProceed(): Promise<boolean> {
    try {
      const redis = getRedisClient()
      const result = await redis.eval(
        CAN_PROCEED_LUA,
        3,
        this.stateKey,
        this.openedAtKey,
        this.resetTimeoutKey,
        String(Date.now()),
        String(this.config.resetTimeoutMs)
      )
      // 1 = closed (allow), 2 = half-open probe (allow), 0 = blocked
      return result === 1 || result === 2
    } catch (err) {
      // If Redis is down, allow the request (fail open for circuit breaker)
      log.error('Redis circuit breaker error, failing open', {
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }

  /**
   * Record a successful API call. Resets the circuit to closed.
   */
  async recordSuccess(): Promise<void> {
    try {
      const redis = getRedisClient()
      const pipeline = redis.pipeline()
      pipeline.set(this.stateKey, 'closed', 'EX', 3600)
      pipeline.del(this.failuresKey)
      pipeline.del(this.openedAtKey)
      pipeline.del(this.resetTimeoutKey)
      await pipeline.exec()
    } catch (err) {
      log.error('Failed to record circuit breaker success', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Record an auth failure. May trip the circuit to open.
   */
  async recordAuthFailure(_statusCode?: number): Promise<void> {
    try {
      const redis = getRedisClient()
      const result = await redis.eval(
        RECORD_FAILURE_LUA,
        4,
        this.stateKey,
        this.failuresKey,
        this.openedAtKey,
        this.resetTimeoutKey,
        String(this.config.failureThreshold),
        String(Date.now()),
        String(this.config.resetTimeoutMs),
        String(this.config.backoffMultiplier),
        String(this.config.maxResetTimeoutMs)
      )

      if (result === 'open') {
        log.warn('Circuit breaker tripped to OPEN', {
          workspaceId: this.config.workspaceId,
        })
      }
    } catch (err) {
      log.error('Failed to record circuit breaker failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Check if an error is an auth/rate-limit error.
   * Reuses the same detection logic as the in-memory CircuitBreaker.
   */
  isAuthError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false

    const err = error as Record<string, unknown>

    // Check HTTP status code
    const statusCode =
      (typeof err.status === 'number' ? err.status : undefined) ??
      (typeof err.statusCode === 'number' ? err.statusCode : undefined) ??
      (typeof (err.response as Record<string, unknown> | undefined)?.status === 'number'
        ? (err.response as Record<string, unknown>).status as number
        : undefined)

    if (statusCode !== undefined && this.config.authErrorCodes.includes(statusCode)) {
      return true
    }

    // Check for GraphQL RATELIMITED
    const extensions = err.extensions as Record<string, unknown> | undefined
    if (extensions?.code === 'RATELIMITED') return true

    const errors = err.errors as Array<Record<string, unknown>> | undefined
    if (Array.isArray(errors)) {
      for (const gqlError of errors) {
        const ext = gqlError.extensions as Record<string, unknown> | undefined
        if (ext?.code === 'RATELIMITED') return true
      }
    }

    // Check error message patterns
    const message = (err.message as string) ?? ''
    if (/access denied|unauthorized|forbidden|RATELIMITED/i.test(message)) {
      return true
    }

    return false
  }

  /**
   * Reset the circuit breaker to closed state.
   */
  async reset(): Promise<void> {
    try {
      const redis = getRedisClient()
      const pipeline = redis.pipeline()
      pipeline.set(this.stateKey, 'closed', 'EX', 3600)
      pipeline.del(this.failuresKey)
      pipeline.del(this.openedAtKey)
      pipeline.del(this.resetTimeoutKey)
      await pipeline.exec()
    } catch (err) {
      log.error('Failed to reset circuit breaker', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Get diagnostic info for monitoring.
   */
  async getStatus(): Promise<{
    state: string
    failures: number
    openedAt: number | null
    currentResetTimeoutMs: number
  }> {
    try {
      const redis = getRedisClient()
      const [state, failures, openedAt, resetTimeout] = await Promise.all([
        redis.get(this.stateKey),
        redis.get(this.failuresKey),
        redis.get(this.openedAtKey),
        redis.get(this.resetTimeoutKey),
      ])

      return {
        state: state ?? 'closed',
        failures: failures ? parseInt(failures, 10) : 0,
        openedAt: openedAt ? parseInt(openedAt, 10) : null,
        currentResetTimeoutMs: resetTimeout
          ? parseInt(resetTimeout, 10)
          : this.config.resetTimeoutMs,
      }
    } catch {
      return {
        state: 'unknown',
        failures: -1,
        openedAt: null,
        currentResetTimeoutMs: this.config.resetTimeoutMs,
      }
    }
  }
}

/**
 * Create a Redis circuit breaker for a specific workspace.
 */
export function createRedisCircuitBreaker(
  workspaceId: string,
  config?: Partial<Omit<RedisCircuitBreakerConfig, 'workspaceId'>>
): RedisCircuitBreaker {
  return new RedisCircuitBreaker({ ...config, workspaceId })
}
