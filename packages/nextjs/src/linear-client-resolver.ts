/**
 * Default Linear Client Resolver
 *
 * Provides a generic LinearClientResolver that uses:
 * 1. Workspace-specific OAuth tokens from Redis (if configured)
 * 2. Falls back to a global API key from environment for read-only operations
 *    (only when no organizationId is provided)
 *
 * IMPORTANT: When an organizationId IS provided but no OAuth token is found,
 * we throw instead of falling back. The personal API key cannot call Agent API
 * endpoints (createAgentActivity, createAgentSessionOnIssue, etc.) so falling
 * back would just waste rate limit quota on guaranteed-to-fail requests.
 *
 * Workspace clients are cached with a 5-minute TTL so all requests within
 * the dashboard process share ONE client per workspace (and therefore one
 * token bucket + one circuit breaker).
 */

import {
  createLinearAgentClient,
  type LinearAgentClient,
  type CircuitBreakerStrategy,
  type RateLimiterStrategy,
} from '@donmai/plugin-linear'
import {
  getAccessToken,
  isRedisConfigured,
  createLogger,
} from '@donmai/server'
import type { LinearClientResolver } from './types.js'

const log = createLogger('linear-client-resolver')

/** Cache entry for workspace-specific clients */
interface CachedClient {
  client: LinearAgentClient
  expiresAt: number
}

/** Default cache TTL: 5 minutes */
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Configuration for the default Linear client resolver.
 */
export interface DefaultLinearClientResolverConfig {
  /** Environment variable name for the API key (default: 'LINEAR_ACCESS_TOKEN') */
  apiKeyEnvVar?: string
  /** Cache TTL in ms for workspace clients (default: 300_000 = 5 min) */
  clientCacheTtlMs?: number
  /**
   * Injectable rate limiter strategy shared across all workspace clients.
   * Use this to inject a Redis-backed rate limiter for cross-process coordination.
   */
  rateLimiterStrategy?: RateLimiterStrategy
  /**
   * Injectable circuit breaker strategy shared across all workspace clients.
   * Use this to inject a Redis-backed circuit breaker for cross-process coordination.
   */
  circuitBreakerStrategy?: CircuitBreakerStrategy
}

/**
 * Create a default Linear client resolver.
 *
 * Resolves Linear clients with workspace-aware OAuth token support:
 * - If an organizationId is provided and Redis is configured, attempts to
 *   fetch a workspace-specific OAuth token.
 * - If organizationId is provided but no OAuth token is found, throws an error
 *   (prevents wasting quota on Agent API calls that require OAuth).
 * - If no organizationId is provided, uses the global API key (for read-only operations).
 *
 * @example
 * ```typescript
 * import { createDefaultLinearClientResolver } from '@renseiai/agentfactory-nextjs'
 *
 * const resolver = createDefaultLinearClientResolver()
 * // Use in route config:
 * const routes = createAllRoutes({ linearClient: resolver, ... })
 * ```
 */
export function createDefaultLinearClientResolver(
  config?: DefaultLinearClientResolverConfig
): LinearClientResolver {
  const apiKeyEnvVar = config?.apiKeyEnvVar ?? 'LINEAR_ACCESS_TOKEN'
  const cacheTtlMs = config?.clientCacheTtlMs ?? CLIENT_CACHE_TTL_MS
  let _globalClient: LinearAgentClient | null = null

  /** Per-workspace client cache: workspaceId → { client, expiresAt } */
  const clientCache = new Map<string, CachedClient>()

  function getGlobalClient(): LinearAgentClient {
    if (!_globalClient) {
      const apiKey = process.env[apiKeyEnvVar]
      if (!apiKey) {
        throw new Error(
          `${apiKeyEnvVar} not set - Linear API operations will fail`
        )
      }
      _globalClient = createLinearAgentClient({
        apiKey,
        rateLimiterStrategy: config?.rateLimiterStrategy,
        circuitBreakerStrategy: config?.circuitBreakerStrategy,
      })
    }
    return _globalClient
  }

  async function getClientForWorkspace(
    workspaceId: string
  ): Promise<LinearAgentClient> {
    // Check cache first
    const cached = clientCache.get(workspaceId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.client
    }

    // Remove expired entry
    if (cached) {
      clientCache.delete(workspaceId)
    }

    if (isRedisConfigured()) {
      const accessToken = await getAccessToken(workspaceId)

      if (accessToken) {
        log.debug('Using OAuth token from Redis', { workspaceId })
        const client = createLinearAgentClient({
          apiKey: accessToken,
          rateLimiterStrategy: config?.rateLimiterStrategy,
          circuitBreakerStrategy: config?.circuitBreakerStrategy,
        })

        // Cache the client
        clientCache.set(workspaceId, {
          client,
          expiresAt: Date.now() + cacheTtlMs,
        })

        return client
      }

      // OAuth token not found — DO NOT fall back to personal API key.
      // Personal API keys cannot call Agent API endpoints, so falling back
      // just wastes rate limit quota on guaranteed 400 errors.
      log.error(
        'No OAuth token for workspace — re-authenticate at /oauth/authorize',
        { workspaceId }
      )
      throw new Error(
        `No OAuth token for workspace ${workspaceId}. Re-authenticate required.`
      )
    }

    // Redis not configured — cannot resolve workspace-specific tokens.
    // This is a configuration error when organizationId is explicitly provided.
    log.error(
      'Redis not configured but workspace-specific client requested',
      { workspaceId }
    )
    throw new Error(
      `Cannot resolve OAuth token for workspace ${workspaceId} — Redis is not configured.`
    )
  }

  return {
    getClient: async (organizationId?: string) =>
      organizationId
        ? await getClientForWorkspace(organizationId)
        : getGlobalClient(),
  }
}
