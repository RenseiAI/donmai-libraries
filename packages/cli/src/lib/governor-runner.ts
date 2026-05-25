/**
 * Governor Runner -- Programmatic API for the governor CLI.
 *
 * Exports `runGovernor()` so the governor can be invoked from code
 * (e.g. Next.js route handlers, tests, or custom scripts) without going
 * through process.argv / process.env / process.exit.
 */

import {
  WorkflowGovernor,
  EventDrivenGovernor,
  InMemoryEventBus,
  InMemoryEventDeduplicator,
  type GovernorDependencies,
  type GovernorEventBus,
  type EventDeduplicator,
  type WorkflowGovernorCallbacks,
} from '@donmai/core'
import type {
  GovernorConfig,
  GovernorAction,
  GovernorIssue,
  ScanResult,
} from '@donmai/core'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GovernorRunnerConfig {
  /** Projects to scan */
  projects: string[]
  /** Scan interval in milliseconds (default: 60000) */
  scanIntervalMs?: number
  /** Maximum concurrent dispatches per scan (default: 3) */
  maxConcurrentDispatches?: number
  /** Enable auto-research from Icebox (default: false) */
  enableAutoResearch?: boolean
  /** Enable auto-backlog-creation from Icebox (default: false) */
  enableAutoBacklogCreation?: boolean
  /** Enable auto-development from Backlog (default: true) */
  enableAutoDevelopment?: boolean
  /** Enable auto-QA from Finished (default: true) */
  enableAutoQA?: boolean
  /** Enable auto-acceptance from Delivered (default: true) */
  enableAutoAcceptance?: boolean
  /** Run a single scan pass and exit (for testing / cron) */
  once?: boolean
  /** Dependency injection for the governor (required) */
  dependencies: GovernorDependencies
  /** Callbacks for governor lifecycle events */
  callbacks?: GovernorRunnerCallbacks
  /** Governor execution mode (default: 'poll-only') */
  mode?: 'poll-only' | 'event-driven'
  /** Event bus for event-driven mode (created automatically if not provided) */
  eventBus?: GovernorEventBus
  /** Event deduplicator for event-driven mode (created automatically if not provided) */
  deduplicator?: EventDeduplicator
}

export interface GovernorRunnerCallbacks {
  onScanComplete?: (results: ScanResult[]) => void | Promise<void>
  onError?: (error: Error) => void
}

export interface GovernorRunnerResult {
  governor: WorkflowGovernor | EventDrivenGovernor
  /** Only populated in --once mode (poll-only) */
  scanResults?: ScanResult[]
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Start the Workflow Governor with the given configuration.
 *
 * In `poll-only` mode (default):
 *   - `once` mode: runs a single scan pass and returns the results.
 *   - Otherwise: starts the scan loop and returns the governor instance
 *     (caller is responsible for calling `governor.stop()` on shutdown).
 *
 * In `event-driven` mode:
 *   - Creates an EventDrivenGovernor with an event bus and optional deduplicator.
 *   - Starts the event loop and periodic poll sweep.
 *   - `once` mode is not supported in event-driven mode (falls back to poll-only).
 */
export async function runGovernor(
  config: GovernorRunnerConfig,
): Promise<GovernorRunnerResult> {
  const governorConfig: Partial<GovernorConfig> = {
    projects: config.projects,
    scanIntervalMs: config.scanIntervalMs,
    maxConcurrentDispatches: config.maxConcurrentDispatches,
    enableAutoResearch: config.enableAutoResearch,
    enableAutoBacklogCreation: config.enableAutoBacklogCreation,
    enableAutoDevelopment: config.enableAutoDevelopment,
    enableAutoQA: config.enableAutoQA,
    enableAutoAcceptance: config.enableAutoAcceptance,
  }

  const mode = config.mode ?? 'poll-only'

  // -- Event-driven mode --
  if (mode === 'event-driven' && !config.once) {
    const eventBus = config.eventBus ?? new InMemoryEventBus()
    const deduplicator = config.deduplicator ?? new InMemoryEventDeduplicator()

    const governor = new EventDrivenGovernor(
      {
        ...governorConfig,
        // Spread required GovernorConfig defaults so TypeScript is happy
        projects: config.projects,
        scanIntervalMs: config.scanIntervalMs ?? 60_000,
        maxConcurrentDispatches: config.maxConcurrentDispatches ?? 3,
        enableAutoResearch: config.enableAutoResearch ?? false,
        enableAutoBacklogCreation: config.enableAutoBacklogCreation ?? false,
        enableAutoDevelopment: config.enableAutoDevelopment ?? true,
        enableAutoQA: config.enableAutoQA ?? true,
        enableAutoAcceptance: config.enableAutoAcceptance ?? true,
        humanResponseTimeoutMs: 4 * 60 * 60 * 1000,
        eventBus,
        deduplicator,
      },
      config.dependencies,
    )

    await governor.start()
    return { governor }
  }

  // -- Poll-only mode (default) --
  const governorCallbacks: WorkflowGovernorCallbacks = {
    onScanComplete: config.callbacks?.onScanComplete,
  }
  const governor = new WorkflowGovernor(governorConfig, config.dependencies, governorCallbacks)

  // -- Single scan mode (--once) --
  if (config.once) {
    const results = await governor.scanOnce()
    return { governor, scanResults: results }
  }

  // -- Continuous scan loop --
  governor.start()
  return { governor }
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

export interface GovernorCLIArgs {
  projects: string[]
  scanIntervalMs: number
  maxConcurrentDispatches: number
  enableAutoResearch: boolean
  enableAutoBacklogCreation: boolean
  enableAutoDevelopment: boolean
  enableAutoQA: boolean
  enableAutoAcceptance: boolean
  once: boolean
  mode: 'poll-only' | 'event-driven'
  autoUpdate?: boolean
}

/**
 * Parse CLI arguments for the governor command.
 *
 * Usage:
 *   agentfactory governor --project <name> [--project <name>] [options]
 *
 * Options:
 *   --project <name>            Project to scan (can be repeated)
 *   --scan-interval <ms>        Scan interval in milliseconds (default: 60000)
 *   --max-dispatches <n>        Maximum concurrent dispatches per scan (default: 3)
 *   --auto-research              Enable auto-research from Icebox (default: off)
 *   --auto-backlog-creation      Enable auto-backlog-creation from Icebox (default: off)
 *   --no-auto-research           Disable auto-research (explicit override)
 *   --no-auto-backlog-creation   Disable auto-backlog-creation (explicit override)
 *   --no-auto-development       Disable auto-development from Backlog
 *   --no-auto-qa                Disable auto-QA from Finished
 *   --no-auto-acceptance        Disable auto-acceptance from Delivered
 *   --once                      Run a single scan pass and exit
 *   --auto-update               Enable automatic updates
 *   --no-auto-update            Disable automatic updates
 *   --help, -h                  Show help
 */
export function parseGovernorArgs(argv: string[] = process.argv.slice(2)): GovernorCLIArgs {
  const result: GovernorCLIArgs = {
    projects: [],
    scanIntervalMs: 60_000,
    maxConcurrentDispatches: 3,
    enableAutoResearch: false,
    enableAutoBacklogCreation: false,
    enableAutoDevelopment: true,
    enableAutoQA: true,
    enableAutoAcceptance: true,
    once: false,
    mode: 'poll-only',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--project':
        result.projects.push(argv[++i]!)
        break
      case '--scan-interval':
        result.scanIntervalMs = parseInt(argv[++i]!, 10)
        break
      case '--max-dispatches':
        result.maxConcurrentDispatches = parseInt(argv[++i]!, 10)
        break
      case '--auto-research':
        result.enableAutoResearch = true
        break
      case '--no-auto-research':
        result.enableAutoResearch = false
        break
      case '--auto-backlog-creation':
        result.enableAutoBacklogCreation = true
        break
      case '--no-auto-backlog-creation':
        result.enableAutoBacklogCreation = false
        break
      case '--no-auto-development':
        result.enableAutoDevelopment = false
        break
      case '--no-auto-qa':
        result.enableAutoQA = false
        break
      case '--no-auto-acceptance':
        result.enableAutoAcceptance = false
        break
      case '--auto-update':
        result.autoUpdate = true
        break
      case '--no-auto-update':
        result.autoUpdate = false
        break
      case '--once':
        result.once = true
        break
      case '--mode':
        result.mode = argv[++i] as 'poll-only' | 'event-driven'
        break
      case '--help':
      case '-h':
        printGovernorHelp()
        process.exit(0)
    }
  }

  return result
}

/**
 * Print help text for the governor command.
 */
export function printGovernorHelp(): void {
  console.log(`
AgentFactory Governor — Automated workflow scan loop

Usage:
  agentfactory governor [options]

Options:
  --project <name>            Project to scan (can be repeated for multiple projects)
  --scan-interval <ms>        Scan interval in milliseconds (default: 60000)
  --max-dispatches <n>        Maximum concurrent dispatches per scan (default: 3)
  --mode <mode>               Execution mode: poll-only (default) or event-driven
  --auto-research             Enable auto-research from Icebox (default: off)
  --auto-backlog-creation     Enable auto-backlog-creation from Icebox (default: off)
  --no-auto-development       Disable auto-development from Backlog
  --no-auto-qa                Disable auto-QA from Finished
  --no-auto-acceptance        Disable auto-acceptance from Delivered
  --once                      Run a single scan pass and exit
  --help, -h                  Show this help message

Modes:
  poll-only      Periodic scan loop using WorkflowGovernor (default)
  event-driven   Hybrid event-driven + poll sweep using EventDrivenGovernor.
                 Reacts to events in real time with a periodic safety-net poll.

Environment:
  LINEAR_API_KEY              Required API key for Linear authentication
  REDIS_URL                   Redis connection URL (required for real dependencies)
  GOVERNOR_PROJECTS           Comma-separated project names (fallback for --project)

Examples:
  # Start the governor for a project
  agentfactory governor --project MyProject

  # Scan multiple projects with custom interval
  agentfactory governor --project ProjectA --project ProjectB --scan-interval 30000

  # Run a single scan and exit (useful for cron jobs)
  agentfactory governor --project MyProject --once

  # Disable auto-QA (only scan for development work)
  agentfactory governor --project MyProject --no-auto-qa --no-auto-acceptance

  # Use event-driven mode
  agentfactory governor --project MyProject --mode event-driven
`)
}
