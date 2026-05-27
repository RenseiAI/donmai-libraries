#!/usr/bin/env node
/**
 * AgentFactory Add-Dep CLI
 *
 * Safely adds dependencies in agent worktrees by cleaning symlinked
 * node_modules and running the correct package manager add command
 * with the preinstall guard bypass.
 *
 * Usage:
 *   af-add-dep <package> [<package>...] [--filter <workspace>]
 *
 * Options:
 *   --filter <workspace>   Target a specific workspace (monorepo)
 *   --help, -h             Show this help message
 */

import { runAddDep } from './lib/add-dep-runner.js'

function parseArgs(): { packages: string[]; filter?: string } {
  const args = process.argv.slice(2)
  const packages: string[] = []
  let filter: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--filter':
        filter = args[++i]
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        if (!arg.startsWith('-')) {
          packages.push(arg)
        }
    }
  }

  return { packages, filter }
}

function printHelp(): void {
  console.log(`
AgentFactory Add-Dep - Safely add dependencies in worktrees

Usage:
  af-add-dep <package> [<package>...] [options]

Options:
  --filter <workspace>   Target a specific workspace (monorepo)
  --help, -h             Show this help message

The package manager is auto-detected from .donmai/config.yaml.

In worktrees, symlinked node_modules are cleaned before running the
add command. The ORCHESTRATOR_INSTALL=1 env var is set to bypass
preinstall guard scripts.

Examples:
  af-add-dep lodash
  af-add-dep zod vitest --filter @myorg/api
`)
}

function main(): void {
  const { packages, filter } = parseArgs()

  if (packages.length === 0) {
    printHelp()
    process.exit(1)
  }

  runAddDep({
    packages,
    filter,
    cwd: process.cwd(),
  })
}

main()
