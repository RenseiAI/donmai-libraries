#!/usr/bin/env node
/**
 * AgentFactory Setup CLI
 *
 * Configure development tools for agent workflows.
 *
 * Usage:
 *   af-setup <tool> [options]
 *   agentfactory setup <tool> [options]
 *
 * Tools:
 *   mergiraf    Configure mergiraf AST-aware merge driver
 *
 * Options:
 *   --dry-run          Show what would be done without making changes
 *   --worktree-only    Only configure for agent worktrees
 *   --skip-check       Skip mergiraf binary availability check
 *   --help, -h         Show this help message
 */

import { setupMergiraf, getGitRoot, type SetupMergirafResult } from './lib/setup-mergiraf-runner.js'

function parseArgs(): {
  subcommand: string | undefined
  dryRun: boolean
  worktreeOnly: boolean
  skipCheck: boolean
} {
  const args = process.argv.slice(2)
  const result = {
    subcommand: undefined as string | undefined,
    dryRun: false,
    worktreeOnly: false,
    skipCheck: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--dry-run':
        result.dryRun = true
        break
      case '--worktree-only':
        result.worktreeOnly = true
        break
      case '--skip-check':
        result.skipCheck = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        // First non-flag argument is the subcommand (skip 'setup' if present)
        if (!arg.startsWith('-') && arg !== 'setup') {
          result.subcommand = arg
        }
        break
    }
  }

  return result
}

function printHelp(): void {
  console.log(`
AgentFactory Setup - Configure development tools for agent workflows

Usage:
  af-setup <tool> [options]
  agentfactory setup <tool> [options]

Tools:
  mergiraf    Configure mergiraf AST-aware merge driver

Options:
  --dry-run          Show what would be done without making changes
  --worktree-only    Only configure for agent worktrees (not whole repo)
  --skip-check       Skip mergiraf binary availability check
  --help, -h         Show this help message

Examples:
  # Configure mergiraf for the entire repository
  af-setup mergiraf

  # Configure only for agent worktrees (recommended)
  af-setup mergiraf --worktree-only

  # Preview changes without modifying anything
  af-setup mergiraf --dry-run
`)
}

function printSummary(result: SetupMergirafResult): void {
  console.log('=== Summary ===\n')

  if (result.mergirafFound) {
    console.log(`  Mergiraf:       found (${result.mergirafVersion})`)
  } else {
    console.log('  Mergiraf:       NOT FOUND')
  }

  if (result.configuredFileTypes.length > 0) {
    console.log(`  File types:     ${result.configuredFileTypes.join(', ')}`)
  }

  console.log(`  .gitattributes: ${result.gitattributesWritten ? 'configured' : 'not configured'}`)
  console.log(`  Merge driver:   ${result.mergeDriverConfigured ? 'configured' : 'not configured'}`)
  console.log(`  Worktree mode:  ${result.worktreeMode ? 'yes' : 'no (repo-wide)'}`)
  console.log(`  Repo config:    ${result.repoConfigUpdated ? 'updated' : 'not updated'}`)

  if (result.errors.length > 0) {
    console.log('\n  Errors:')
    for (const err of result.errors) {
      console.log(`    - ${err}`)
    }
  }

  if (result.gitattributesWritten && result.mergeDriverConfigured) {
    console.log('\n  See: https://github.com/RenseiAI/donmai-libraries/blob/main/docs/guides/mergiraf-setup.md')
  }

  console.log('')
}

// Main execution
function main(): void {
  const args = parseArgs()

  if (!args.subcommand) {
    console.error('Error: No tool specified.\n')
    printHelp()
    process.exit(1)
  }

  switch (args.subcommand) {
    case 'mergiraf': {
      console.log('\n=== AgentFactory Setup: Mergiraf ===\n')

      if (args.dryRun) {
        console.log('[DRY RUN MODE - No changes will be made]\n')
      }

      const result = setupMergiraf({
        dryRun: args.dryRun,
        worktreeOnly: args.worktreeOnly,
        skipCheck: args.skipCheck,
        gitRoot: getGitRoot(),
      })

      printSummary(result)

      if (result.errors.length > 0) {
        process.exit(result.exitCode || 1)
      }
      break
    }

    default:
      console.error(`Unknown tool: ${args.subcommand}\n`)
      printHelp()
      process.exit(1)
  }
}

main()
