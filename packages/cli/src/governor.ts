#!/usr/bin/env node
/**
 * AgentFactory Governor CLI
 *
 * Thin wrapper around the governor runner.
 *
 * Usage:
 *   af-governor [options]
 *
 * Options:
 *   --project <name>            Project to scan (can be repeated)
 *   --scan-interval <ms>        Scan interval in milliseconds (default: 60000)
 *   --max-dispatches <n>        Maximum concurrent dispatches per scan (default: 3)
 *   --no-auto-research          Disable auto-research from Icebox
 *   --no-auto-backlog-creation  Disable auto-backlog-creation from Icebox
 *   --no-auto-development       Disable auto-development from Backlog
 *   --no-auto-qa                Disable auto-QA from Finished
 *   --no-auto-acceptance        Disable auto-acceptance from Delivered
 *   --once                      Run a single scan pass and exit
 *
 * Environment:
 *   LINEAR_API_KEY              Required API key for Linear authentication
 *   GOVERNOR_PROJECTS           Comma-separated project names (fallback for --project)
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local
config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true })

import {
  parseGovernorArgs,
  runGovernor,
  type GovernorRunnerConfig,
} from './lib/governor-runner.js'
import { createRealDependencies } from './lib/governor-dependencies.js'
import {
  printStartupBanner,
  printScanSummary,
  printCircuitBreakerWarning,
} from './lib/governor-logger.js'
import { getVersion, checkForUpdate, printUpdateNotification } from './lib/version.js'
import { maybeAutoUpdate, isAutoUpdateEnabled } from './lib/auto-updater.js'
import { createLinearAgentClient, type LinearAgentClient, type LinearApiQuota } from '@donmai/plugin-linear'
import { createLogger, initTouchpointStorage } from '@donmai/core'
import {
  RedisOverrideStorage,
  listStoredWorkspaces,
  getAccessToken,
  createRedisTokenBucket,
  createRedisCircuitBreaker,
} from '@donmai/server'
import type { GovernorDependencies, GovernorIssue, GovernorAction, ScanResult } from '@donmai/core'
import type { RateLimiterStrategy, CircuitBreakerStrategy } from '@donmai/plugin-linear'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger({ workerShortId: 'governor' })

// ---------------------------------------------------------------------------
// Stub dependencies
// ---------------------------------------------------------------------------

/**
 * Create placeholder dependencies for the Governor.
 *
 * In a production deployment, these would be backed by the Linear SDK
 * and Redis (via packages/server). For now we provide stubs that log
 * calls and return safe defaults. The WorkSchedulingFrontend (SUP-709
 * Wave 3) will provide the real implementations.
 */
function createStubDependencies(): GovernorDependencies {
  return {
    listIssues: async (_project: string): Promise<GovernorIssue[]> => {
      log.warn('listIssues stub called — no issues returned', { project: _project })
      return []
    },
    hasActiveSession: async (_issueId: string): Promise<boolean> => false,
    isWithinCooldown: async (_issueId: string): Promise<boolean> => false,
    isParentIssue: async (_issueId: string): Promise<boolean> => false,
    isHeld: async (_issueId: string): Promise<boolean> => false,
    getOverridePriority: async (_issueId: string) => null,
    getWorkflowStrategy: async (_issueId: string): Promise<string | undefined> => undefined,
    isResearchCompleted: async (_issueId: string): Promise<boolean> => false,
    isBacklogCreationCompleted: async (_issueId: string): Promise<boolean> => false,
    getCompletedSessionCount: async (_issueId: string): Promise<number> => 0,
    dispatchWork: async (_issue: GovernorIssue, _action: GovernorAction): Promise<void> => {
      log.warn('dispatchWork stub called', { issueId: _issue.id, action: _action })
    },
  }
}

// ---------------------------------------------------------------------------
// Default prompt generator (used when no external generator is provided)
// ---------------------------------------------------------------------------

function defaultGeneratePrompt(identifier: string, workType: string): string {
  const prompts: Record<string, string> = {
    research: `Research and analyze ${identifier}.`,
    'backlog-creation': `Create backlog issues for ${identifier}.`,
    development: `Start work on ${identifier}.`,
    qa: `QA ${identifier}.`,
    acceptance: `Process acceptance for ${identifier}.`,
    refinement: `Refine ${identifier} based on feedback.`,
    coordination: `Coordinate sub-issue execution for ${identifier}.`,
  }
  return prompts[workType] || `Process ${workType} for ${identifier}.`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseGovernorArgs()

  // Fall back to GOVERNOR_PROJECTS env var (comma-separated) when no --project flags
  if (args.projects.length === 0 && process.env.GOVERNOR_PROJECTS) {
    args.projects = process.env.GOVERNOR_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
  }

  if (args.projects.length === 0) {
    console.error('Error: at least one --project is required (or set GOVERNOR_PROJECTS env var)')
    process.exit(1)
  }

  const version = getVersion()

  // -----------------------------------------------------------------------
  // Choose real or stub dependencies based on environment
  // -----------------------------------------------------------------------
  let dependencies: GovernorDependencies
  let linearClient: ReturnType<typeof createLinearAgentClient> | undefined

  const linearApiKey = process.env.LINEAR_API_KEY
  const redisUrl = process.env.REDIS_URL

  // Track latest quota from API responses
  let latestQuota: LinearApiQuota | undefined

  let redisConnected = false
  let oauthResolved = false

  if (linearApiKey) {
    let organizationId: string | undefined

    // Shared rate limiter and circuit breaker strategies (Redis-backed when available)
    let rateLimiterStrategy: RateLimiterStrategy | undefined
    let circuitBreakerStrategy: CircuitBreakerStrategy | undefined

    // OAuth client cache — re-created when the underlying token changes
    let cachedOAuthToken: string | undefined
    let cachedOAuthClient: LinearAgentClient | undefined

    // Initialize touchpoint storage (for isHeld / getOverridePriority) when Redis is available
    if (redisUrl) {
      redisConnected = true
      initTouchpointStorage(new RedisOverrideStorage())

      // Resolve workspace and create shared strategies
      try {
        const workspaces = await listStoredWorkspaces()
        if (workspaces.length > 0) {
          organizationId = workspaces[0]  // Use first workspace (single-tenant)

          // Create shared Redis rate limiter and circuit breaker for this workspace
          rateLimiterStrategy = createRedisTokenBucket(organizationId)
          circuitBreakerStrategy = createRedisCircuitBreaker(organizationId)

          // Eagerly resolve token at startup to populate banner status
          const accessToken = await getAccessToken(organizationId)
          if (accessToken) {
            cachedOAuthToken = accessToken
            cachedOAuthClient = createLinearAgentClient({
              apiKey: accessToken,
              rateLimiterStrategy,
              circuitBreakerStrategy,
            })
            oauthResolved = true
          }
        }
      } catch (err) {
        log.warn('Failed to resolve OAuth token', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    /**
     * Lazy OAuth client resolver.
     *
     * Called on each dispatchWork() to ensure the OAuth token is fresh.
     * Re-reads the token from Redis (which handles refresh internally),
     * and only creates a new LinearAgentClient when the token has changed.
     * Rate limiter and circuit breaker strategies are reused across clients.
     */
    const resolveOAuthClient = organizationId
      ? async (): Promise<LinearAgentClient | undefined> => {
          try {
            const accessToken = await getAccessToken(organizationId!)
            if (!accessToken) return cachedOAuthClient

            // Token unchanged — reuse existing client
            if (accessToken === cachedOAuthToken && cachedOAuthClient) {
              return cachedOAuthClient
            }

            // Token was refreshed — create new client with same strategies
            log.info('OAuth token refreshed, creating new client')
            cachedOAuthToken = accessToken
            cachedOAuthClient = createLinearAgentClient({
              apiKey: accessToken,
              rateLimiterStrategy,
              circuitBreakerStrategy,
            })
            oauthResolved = true
            return cachedOAuthClient
          } catch (err) {
            log.warn('Failed to resolve OAuth client', {
              error: err instanceof Error ? err.message : String(err),
            })
            return cachedOAuthClient
          }
        }
      : undefined

    linearClient = createLinearAgentClient({
      apiKey: linearApiKey,
      rateLimiterStrategy,
      circuitBreakerStrategy,
      onApiResponse: (quota) => {
        latestQuota = quota
      },
    })

    dependencies = createRealDependencies({
      linearClient,
      resolveOAuthClient,
      organizationId,
      generatePrompt: defaultGeneratePrompt,
    })
  } else {
    log.warn('LINEAR_API_KEY not set — using stub dependencies (no real work will be dispatched)')
    dependencies = createStubDependencies()
  }

  // -----------------------------------------------------------------------
  // Print startup banner
  // -----------------------------------------------------------------------
  printStartupBanner({
    version,
    projects: args.projects,
    scanIntervalMs: args.scanIntervalMs,
    maxConcurrentDispatches: args.maxConcurrentDispatches,
    mode: args.mode,
    once: args.once,
    features: {
      autoResearch: args.enableAutoResearch,
      autoBacklogCreation: args.enableAutoBacklogCreation,
      autoDevelopment: args.enableAutoDevelopment,
      autoQA: args.enableAutoQA,
      autoAcceptance: args.enableAutoAcceptance,
    },
    redisConnected,
    oauthResolved,
  })

  // -----------------------------------------------------------------------
  // Update check (non-blocking — runs in background)
  // -----------------------------------------------------------------------
  const updateCheck = await checkForUpdate()
  printUpdateNotification(updateCheck)

  // -----------------------------------------------------------------------
  // Configure and run
  // -----------------------------------------------------------------------
  const runnerConfig: GovernorRunnerConfig = {
    projects: args.projects,
    scanIntervalMs: args.scanIntervalMs,
    maxConcurrentDispatches: args.maxConcurrentDispatches,
    enableAutoResearch: args.enableAutoResearch,
    enableAutoBacklogCreation: args.enableAutoBacklogCreation,
    enableAutoDevelopment: args.enableAutoDevelopment,
    enableAutoQA: args.enableAutoQA,
    enableAutoAcceptance: args.enableAutoAcceptance,
    once: args.once,
    mode: args.mode,
    dependencies,
    callbacks: {
      onScanComplete: async (results: ScanResult[]) => {
        const apiCalls = linearClient?.apiCallCount
        printScanSummary(results, 0, latestQuota, apiCalls)

        // Check circuit breaker status if available
        // (CircuitBreaker instances expose a .state getter)
        if (linearClient) {
          const breaker = (linearClient as unknown as { circuitBreaker?: { state?: string } }).circuitBreaker
          if (breaker?.state && breaker.state !== 'closed') {
            printCircuitBreakerWarning(breaker.state)
          }
        }

        // Reset for next scan
        linearClient?.resetApiCallCount()
        latestQuota = undefined

        // Auto-update at end of scan when no active dispatches
        await maybeAutoUpdate(updateCheck, {
          cliFlag: args.autoUpdate,
        })
      },
      onError: (error: Error) => {
        log.error('Governor error', { error: error.message })
      },
    },
  }

  try {
    const { governor, scanResults } = await runGovernor(runnerConfig)

    if (args.once && scanResults) {
      // Print summary and exit
      const apiCalls = linearClient?.apiCallCount
      printScanSummary(scanResults, 0, latestQuota, apiCalls)

      let totalDispatched = 0
      let totalErrors = 0
      for (const result of scanResults) {
        totalDispatched += result.actionsDispatched
        totalErrors += result.errors.length
      }
      log.info(`Scan complete: ${totalDispatched} dispatched, ${totalErrors} errors`)
      return
    }

    // Continuous mode — handle graceful shutdown
    log.info('Governor running. Press Ctrl+C to stop.')

    const shutdown = () => {
      log.info('Shutting down governor...')
      governor.stop()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (error) {
    log.error('Governor failed', { error: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  }
}

main().catch((error) => {
  log.error('Fatal error', { error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
