#!/usr/bin/env tsx
import { runCleanup, type CleanupRunnerConfig } from '@donmai/cli/cleanup'

function parseArgs(): CleanupRunnerConfig {
  const args = process.argv.slice(2)
  const opts: CleanupRunnerConfig = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--path' && args[i + 1]) opts.worktreePath = args[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm cleanup [--dry-run] [--force] [--path <dir>]')
      process.exit(0)
    }
  }
  return opts
}

const result = runCleanup(parseArgs())

console.log(`\nSummary: scanned=${result.scanned} orphaned=${result.orphaned} cleaned=${result.cleaned}`)
if (result.errors.length > 0) {
  console.error('Errors:', result.errors)
  process.exit(1)
}
