#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(import.meta.dirname, '..', '.env.local'), quiet: true })

import { runOrchestrator } from '@donmai/cli/orchestrator'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--project' && args[i + 1]) opts.project = args[++i]
    else if (arg === '--max' && args[i + 1]) opts.max = args[++i]
    else if (arg === '--single' && args[i + 1]) opts.single = args[++i]
    else if (arg === '--no-wait') opts.wait = false
    else if (arg === '--dry-run') opts.dryRun = true
  }
  return opts
}

const args = parseArgs()

const linearApiKey = process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN
if (!linearApiKey) {
  console.error('Error: LINEAR_API_KEY or LINEAR_ACCESS_TOKEN not set')
  process.exit(1)
}

runOrchestrator({
  linearApiKey,
  project: args.project as string | undefined,
  max: args.max ? Number(args.max) : undefined,
  single: args.single as string | undefined,
  wait: args.wait !== false,
  dryRun: !!args.dryRun,
}).then((result) => {
  if (result.errors.length > 0) process.exit(1)
}).catch((err) => {
  console.error('Orchestrator failed:', err)
  process.exit(1)
})
