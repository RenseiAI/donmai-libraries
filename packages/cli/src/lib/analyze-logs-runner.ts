/**
 * Log Analyzer Runner -- Programmatic API for the log analyzer CLI.
 *
 * Extracts the core logic from the analyze-logs bin script so that it can be
 * invoked programmatically (e.g. from a Next.js route handler or test) without
 * process.exit / dotenv / argv coupling.
 */

import { execSync } from 'child_process'
import { createLogAnalyzer, type LogAnalyzer } from '@donmai/core'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzerRunnerConfig {
  /** Analyze a specific session */
  sessionId?: string
  /** Watch for new sessions and analyze as they complete */
  follow?: boolean
  /** Poll interval in milliseconds (default: 5000) */
  interval?: number
  /** Show what would be created without creating issues */
  dryRun?: boolean
  /** Cleanup old logs based on retention policy */
  cleanup?: boolean
  /** Show detailed analysis output */
  verbose?: boolean
  /** Base directory for logs (default: {gitRoot}/.agent-logs or AGENT_LOGS_DIR env) */
  logsDir?: string
  /** Git root for default paths (default: auto-detect) */
  gitRoot?: string
}

export interface AnalyzerResult {
  sessionsAnalyzed: number
  totalErrors: number
  totalPatterns: number
  issuesCreated: number
  issuesUpdated: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL = 5000

/** Detect the git repository root. Falls back to cwd. */
export function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

function formatTime(): string {
  return new Date().toLocaleTimeString()
}

function emptyStats(): AnalyzerResult {
  return {
    sessionsAnalyzed: 0,
    totalErrors: 0,
    totalPatterns: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
  }
}

// ---------------------------------------------------------------------------
// Internal session analysis
// ---------------------------------------------------------------------------

interface InternalCliOptions {
  dryRun: boolean
  verbose: boolean
}

async function analyzeAndPrintSession(
  analyzer: LogAnalyzer,
  sessionId: string,
  options: InternalCliOptions,
  stats: AnalyzerResult,
): Promise<boolean> {
  console.log(`\nAnalyzing session: ${sessionId}`)
  console.log('-'.repeat(50))

  const result = analyzer.analyzeSession(sessionId)
  if (!result) {
    console.log('  [SKIP] Session not found or incomplete')
    return false
  }

  console.log(`  Issue: ${result.metadata.issueIdentifier}`)
  console.log(`  Work Type: ${result.metadata.workType}`)
  console.log(`  Status: ${result.metadata.status}`)
  console.log(`  Events: ${result.eventsAnalyzed}`)
  console.log(`  Errors: ${result.errorsFound}`)
  console.log(`  Patterns: ${result.patterns.length}`)

  stats.sessionsAnalyzed++
  stats.totalErrors += result.errorsFound
  stats.totalPatterns += result.patterns.length

  if (options.verbose && result.patterns.length > 0) {
    console.log('\n  Detected Patterns:')
    for (const pattern of result.patterns) {
      console.log(`    - [${pattern.severity}] ${pattern.title}`)
      console.log(`      Type: ${pattern.type}, Occurrences: ${pattern.occurrences}`)
      if (pattern.tool) {
        console.log(`      Tool: ${pattern.tool}`)
      }
    }
  }

  if (result.suggestedIssues.length > 0) {
    console.log(`\n  Suggested Issues: ${result.suggestedIssues.length}`)

    if (options.verbose) {
      for (const issue of result.suggestedIssues) {
        console.log(`    - ${issue.title}`)
        console.log(`      Signature: ${issue.signature}`)
        console.log(`      Labels: ${issue.labels.join(', ')}`)
      }
    }

    try {
      const issueResults = await analyzer.createIssues(
        result.suggestedIssues,
        sessionId,
        options.dryRun,
      )

      for (const issueResult of issueResults) {
        if (issueResult.created) {
          console.log(`  [${options.dryRun ? 'WOULD CREATE' : 'CREATED'}] ${issueResult.identifier}`)
          stats.issuesCreated++
        } else {
          console.log(`  [${options.dryRun ? 'WOULD UPDATE' : 'UPDATED'}] ${issueResult.identifier}`)
          stats.issuesUpdated++
        }
      }
    } catch (error) {
      console.log(`  [ERROR] Failed to create issues: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!options.dryRun) {
    analyzer.markProcessed(sessionId, result)
    console.log('  [PROCESSED]')
  }

  return true
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

export function printSummary(stats: AnalyzerResult, dryRun: boolean): void {
  console.log('\n' + '='.repeat(50))
  console.log('=== Summary ===\n')
  console.log(`  Sessions analyzed: ${stats.sessionsAnalyzed}`)
  console.log(`  Total errors found: ${stats.totalErrors}`)
  console.log(`  Total patterns detected: ${stats.totalPatterns}`)
  console.log(`  Issues created: ${stats.issuesCreated}${dryRun ? ' (dry run)' : ''}`)
  console.log(`  Issues updated: ${stats.issuesUpdated}${dryRun ? ' (dry run)' : ''}`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Follow mode (watch)
// ---------------------------------------------------------------------------

async function runFollowMode(
  analyzer: LogAnalyzer,
  options: InternalCliOptions,
  interval: number,
  signal?: AbortSignal,
): Promise<AnalyzerResult> {
  const stats = emptyStats()
  const processedInSession = new Set<string>()

  console.log(`[${formatTime()}] Watching for new sessions (poll interval: ${interval}ms)`)
  console.log(`[${formatTime()}] Press Ctrl+C to stop\n`)

  const isAborted = () => signal?.aborted ?? false

  // Initial check for existing unprocessed sessions
  const initialSessions = analyzer.getUnprocessedSessions()
  if (initialSessions.length > 0) {
    console.log(`[${formatTime()}] Found ${initialSessions.length} existing unprocessed session(s)`)
    for (const sid of initialSessions) {
      if (isAborted()) break
      await analyzeAndPrintSession(analyzer, sid, options, stats)
      processedInSession.add(sid)
    }
  }

  // Poll loop
  while (!isAborted()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval)
      // If an abort signal fires while waiting, resolve immediately
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    if (isAborted()) break

    const sessions = analyzer.getUnprocessedSessions()
    const newSessions = sessions.filter((s) => !processedInSession.has(s))

    if (newSessions.length > 0) {
      console.log(`[${formatTime()}] Found ${newSessions.length} new session(s) ready for analysis`)
      for (const sid of newSessions) {
        if (isAborted()) break
        const analyzed = await analyzeAndPrintSession(analyzer, sid, options, stats)
        if (analyzed) {
          processedInSession.add(sid)
        }
      }
    }
  }

  console.log(`\n[${formatTime()}] Stopping...`)
  return stats
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the log analyzer programmatically.
 *
 * For one-shot mode (default) the returned promise resolves with the analysis
 * result once all sessions have been processed.
 *
 * For follow mode (`config.follow = true`) the analyzer keeps running until
 * the optional `signal` is aborted.  When the signal fires the current poll
 * cycle finishes and the accumulated stats are returned.
 */
export async function runLogAnalyzer(
  config: AnalyzerRunnerConfig = {},
  signal?: AbortSignal,
): Promise<AnalyzerResult> {
  const gitRoot = config.gitRoot ?? getGitRoot()
  const logsDir = config.logsDir ?? process.env.AGENT_LOGS_DIR ?? `${gitRoot}/.agent-logs`
  const dryRun = config.dryRun ?? false
  const verbose = config.verbose ?? false
  const interval = config.interval ?? DEFAULT_POLL_INTERVAL

  console.log('\n=== AgentFactory Log Analyzer ===\n')

  if (dryRun) {
    console.log('[DRY RUN MODE - No issues will be created]\n')
  }

  const analyzer = createLogAnalyzer({ logsDir })

  // Cleanup mode
  if (config.cleanup) {
    console.log('Cleaning up old logs...\n')
    const deleted = analyzer.cleanupOldLogs()
    console.log(`Deleted ${deleted} old log entries.\n`)
    return emptyStats()
  }

  // Follow (watch) mode
  if (config.follow) {
    return runFollowMode(analyzer, { dryRun, verbose }, interval, signal)
  }

  // Standard one-shot mode
  const stats = emptyStats()

  let sessionsToAnalyze: string[]
  if (config.sessionId) {
    sessionsToAnalyze = [config.sessionId]
    console.log(`Analyzing session: ${config.sessionId}\n`)
  } else {
    sessionsToAnalyze = analyzer.getUnprocessedSessions()
    console.log(`Found ${sessionsToAnalyze.length} unprocessed session(s)\n`)
  }

  if (sessionsToAnalyze.length === 0) {
    console.log('No sessions to analyze.\n')
    return stats
  }

  for (const sid of sessionsToAnalyze) {
    await analyzeAndPrintSession(analyzer, sid, { dryRun, verbose }, stats)
  }

  return stats
}
