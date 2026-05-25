#!/usr/bin/env node
/**
 * AgentFactory Route Sync CLI
 *
 * Generates missing route.ts and page.tsx files from the route manifest.
 *
 * Usage:
 *   af-sync-routes [options]
 *
 * Options:
 *   --dry-run       Preview what would be created
 *   --pages         Also sync dashboard page.tsx files
 *   --app-dir <p>   Custom app directory (default: src/app)
 *   --help, -h      Show this help message
 */

import { runSyncRoutes, type SyncRoutesConfig } from './lib/sync-routes-runner.js'

function parseArgs(): SyncRoutesConfig & { help: boolean } {
  const args = process.argv.slice(2)
  const result: SyncRoutesConfig & { help: boolean } = {
    dryRun: false,
    pages: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--dry-run':
        result.dryRun = true
        break
      case '--pages':
        result.pages = true
        break
      case '--app-dir':
        result.appDir = args[++i]
        break
      case '--help':
      case '-h':
        result.help = true
        break
    }
  }

  return result
}

function printHelp(): void {
  console.log(`
AgentFactory Route Sync — Generate missing route and page files

Usage:
  af-sync-routes [options]

Options:
  --dry-run       Preview what would be created without writing files
  --pages         Also sync dashboard page.tsx files (requires @donmai/dashboard)
  --app-dir <p>   Custom app directory (default: src/app)
  --help, -h      Show this help message

Examples:
  # Preview missing routes
  af-sync-routes --dry-run

  # Create missing route files
  af-sync-routes

  # Also sync dashboard pages
  af-sync-routes --pages

  # After upgrading @renseiai packages
  pnpm bump:af && af-sync-routes --pages
`)
}

function main(): void {
  const args = parseArgs()

  if (args.help) {
    printHelp()
    return
  }

  console.log('\n=== AgentFactory Route Sync ===\n')

  if (args.dryRun) {
    console.log('[DRY RUN MODE - No files will be written]\n')
  }

  const result = runSyncRoutes({
    dryRun: args.dryRun,
    pages: args.pages,
    appDir: args.appDir,
  })

  // Print warnings
  for (const warning of result.warnings) {
    console.log(`\n  warning: ${warning}`)
  }

  // Print summary
  console.log(`\nSummary: checked=${result.checked} created=${result.created} skipped=${result.skipped} errors=${result.errors.length}`)

  if (result.errors.length > 0) {
    console.error('\nErrors:')
    for (const err of result.errors) {
      console.error(`  ${err.path}: ${err.error}`)
    }
    process.exit(1)
  }
}

main()
