#!/usr/bin/env node
/**
 * Architectural Intelligence CLI — af-arch / rensei arch
 *
 * Architecture reference: rensei-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Drift detection
 *
 * REN-1326: CLI surface for ad-hoc drift assessment.
 *
 * Usage:
 *   pnpm af-arch assess <pr-url>
 *   pnpm af-arch assess --repository <repo> --pr <number>
 *
 * The `af-tui` (`rensei arch assess`) surface is stubbed here with a
 * deprecation pointer until REN-1322 ships the full TUI integration.
 *
 * Environment:
 *   RENSEI_DRIFT_GATE      — Gate policy: 'none' | 'no-severity-high' |
 *                            'zero-deviations' | 'max:N'
 *   ANTHROPIC_API_KEY      — Enables live LLM drift assessment.
 *                            Without this key, the CLI uses a stub adapter
 *                            that returns an empty DriftReport with a notice.
 *   RENSEI_ARCH_DB         — Path to the SQLite DB (default: .donmai/arch-intelligence/db.sqlite)
 *
 * Output:
 *   JSON to stdout. Non-zero exit code when the gate policy is triggered.
 *   Exit codes:
 *     0  — Clean (no deviations / gate not triggered)
 *     1  — Gate triggered (threshold exceeded per RENSEI_DRIFT_GATE policy)
 *     2  — Error (invalid args, network failure, parse error)
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local
config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true })

import { runArchAssess, parseArchArgs } from './lib/arch-assess-runner.js'

function printHelp(): void {
  console.log(`
Architectural Intelligence CLI — drift detection for PRs and commits

Usage:
  af-arch assess <pr-url>
  af-arch assess --repository <repo> --pr <number>
  af-arch assess --help

Arguments:
  <pr-url>                    Full GitHub PR URL (e.g. https://github.com/org/repo/pull/123)

Options:
  --repository <repo>         Repository identifier (e.g. github.com/org/repo)
  --pr <number>               PR number within the repository
  --gate-policy <policy>      Override gate policy:
                                none               Never block
                                no-severity-high   Block on high-severity deviations (default)
                                zero-deviations    Block on any deviation
                                max:N              Block when deviations > N
  --scope-level <level>       Scope level: project | org | tenant | global (default: project)
  --project-id <id>           Project ID for scope (optional)
  --db <path>                 Path to SQLite DB (overrides RENSEI_ARCH_DB)
  --json                      Output raw JSON (default)
  --summary                   Output human-readable summary instead of JSON
  --help, -h                  Show this help message

Environment:
  RENSEI_DRIFT_GATE            Gate policy (overridden by --gate-policy)
  ANTHROPIC_API_KEY            Enables live LLM assessment (required for real drift detection)
  RENSEI_ARCH_DB               SQLite DB path (default: .donmai/arch-intelligence/db.sqlite)

Exit codes:
  0  Clean — no deviations or gate not triggered
  1  Gated — threshold exceeded per policy
  2  Error — invalid args, network failure, parse error

Examples:
  af-arch assess https://github.com/org/repo/pull/123
  af-arch assess --repository github.com/org/repo --pr 123
  af-arch assess https://github.com/org/repo/pull/123 --gate-policy zero-deviations
  RENSEI_DRIFT_GATE=max:2 af-arch assess https://github.com/org/repo/pull/123

af-tui surface (rensei arch assess):
  Full TUI integration is deferred to REN-1322. Use 'af-arch assess' for
  ad-hoc assessment in the meantime. Both produce identical JSON output.
`)
}

async function main(): Promise<void> {
  const { command, prUrl, args } = parseArchArgs(process.argv.slice(2))

  if (!command || command === 'help' || args['help'] || args['h']) {
    printHelp()
    return
  }

  if (command !== 'assess') {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(2)
  }

  try {
    const result = await runArchAssess({
      prUrl,
      repository: typeof args['repository'] === 'string' ? args['repository'] : undefined,
      prNumber: args['pr'] ? parseInt(String(args['pr']), 10) : undefined,
      gatePolicy: typeof args['gate-policy'] === 'string' ? args['gate-policy'] : undefined,
      scopeLevel: typeof args['scope-level'] === 'string'
        ? (args['scope-level'] as 'project' | 'org' | 'tenant' | 'global')
        : 'project',
      projectId: typeof args['project-id'] === 'string' ? args['project-id'] : undefined,
      dbPath: typeof args['db'] === 'string' ? args['db'] : undefined,
      summary: args['summary'] === true,
      cwd: process.cwd(),
    })

    if (result.summary && args['summary']) {
      console.log(result.summaryText)
    } else {
      console.log(JSON.stringify(result.output, null, 2))
    }

    // Non-zero exit when gate is triggered
    if (result.gated) {
      process.exit(1)
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : error)
  process.exit(2)
})
