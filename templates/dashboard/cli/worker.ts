#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(import.meta.dirname, '..', '.env.local'), quiet: true })

import { runWorker } from '@donmai/cli/worker'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--capacity' && args[i + 1]) opts.capacity = args[++i]
    else if (arg === '--hostname' && args[i + 1]) opts.hostname = args[++i]
    else if (arg === '--api-url' && args[i + 1]) opts.apiUrl = args[++i]
    else if (arg === '--projects' && args[i + 1]) opts.projects = args[++i]
    else if (arg === '--dry-run') opts.dryRun = true
  }
  return opts
}

const args = parseArgs()

const apiUrl = (args.apiUrl as string) || process.env.WORKER_API_URL
const apiKey = process.env.WORKER_API_KEY

if (!apiUrl) {
  console.error('Error: WORKER_API_URL not set (use --api-url or env)')
  process.exit(1)
}
if (!apiKey) {
  console.error('Error: WORKER_API_KEY not set')
  process.exit(1)
}

const controller = new AbortController()
process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())

const capacity = args.capacity
  ? Number(args.capacity)
  : process.env.WORKER_CAPACITY
    ? Number(process.env.WORKER_CAPACITY)
    : undefined

const projects = (args.projects as string)
  ? (args.projects as string).split(',').map(s => s.trim()).filter(Boolean)
  : process.env.WORKER_PROJECTS
    ? process.env.WORKER_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
    : undefined

runWorker(
  {
    apiUrl,
    apiKey,
    hostname: args.hostname as string | undefined,
    capacity,
    dryRun: !!args.dryRun,
    projects,
  },
  controller.signal,
).catch((err) => {
  if (err?.name !== 'AbortError') {
    console.error('Worker failed:', err)
    process.exit(1)
  }
})
