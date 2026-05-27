#!/usr/bin/env node

/**
 * create-donmai-app
 *
 * Scaffolds a new donmai app — a Next.js webhook server + worker
 * that processes Linear issues with coding agents.
 *
 * Usage:
 *   npx @donmai/create-app my-agent
 *   npx @donmai/create-app my-agent --team MY
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import readline from 'node:readline'
import { getTemplates } from './templates/index.js'

// ── Argument parsing ────────────────────────────────────────────────

const args = process.argv.slice(2)
const flags: Record<string, string> = {}
let projectName = ''

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--help' || arg === '-h') {
    printHelp()
    process.exit(0)
  }
  if (arg.startsWith('--')) {
    const key = arg.slice(2)
    flags[key] = args[++i] ?? ''
  } else if (!projectName) {
    projectName = arg
  }
}

// ── Interactive prompts ─────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : ''
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  return new Promise((resolve) => {
    rl.question(`  ${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase()
      if (!a) return resolve(defaultYes)
      resolve(a === 'y' || a === 'yes')
    })
  })
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log()
  console.log('  create-donmai-app')
  console.log()

  // Project name
  if (!projectName) {
    projectName = await ask('Project name', 'my-agent')
  }
  if (!projectName) {
    console.error('  Error: Project name is required')
    process.exit(1)
  }

  // Validate project name
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(projectName)) {
    console.error('  Error: Project name must be lowercase, start with a letter or number')
    process.exit(1)
  }

  const projectDir = path.resolve(process.cwd(), projectName)
  if (fs.existsSync(projectDir)) {
    console.error(`  Error: Directory "${projectName}" already exists`)
    process.exit(1)
  }

  // Gather options
  const teamKey = flags['team'] || await ask('Linear team key (e.g., MY)', 'MY')
  const includeDashboard = flags['no-dashboard'] ? false : await confirm('Include dashboard UI?')
  const includeCli = flags['no-cli'] ? false : await confirm('Include CLI tools (worker, orchestrator)?')
  const useRedis = flags['no-redis'] ? false : await confirm('Include Redis for distributed workers?')

  console.log()
  console.log(`  Creating ${projectName}...`)
  console.log()

  // Generate files from templates
  const templates = getTemplates({
    projectName,
    teamKey,
    includeDashboard,
    includeCli,
    useRedis,
  })

  // Create directories and write files
  let fileCount = 0
  for (const [filePath, content] of Object.entries(templates)) {
    const fullPath = path.join(projectDir, filePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
    fileCount++
  }

  console.log(`  Created ${fileCount} files`)
  console.log()

  // Initialize git repo
  try {
    execSync('git init', { cwd: projectDir, stdio: 'pipe' })
    console.log('  Initialized git repository')
  } catch {
    // Git not available — skip silently
  }

  // Print next steps
  console.log()
  console.log('  Next steps:')
  console.log()
  console.log(`    cd ${projectName}`)
  console.log('    cp .env.example .env.local')
  console.log('    # Fill in LINEAR_ACCESS_TOKEN and other secrets')
  console.log('    pnpm install')
  console.log('    pnpm dev              # Start webhook server')
  if (includeCli) {
    console.log('    pnpm worker           # Start a local worker (in another terminal)')
  }
  console.log()
  console.log('  Documentation: https://github.com/renseiai/agentfactory')
  console.log()

  rl.close()
}

function printHelp() {
  console.log(`
  Usage: npx @donmai/create-app [project-name] [options]

  Options:
    --team <KEY>     Linear team key (default: MY)
    --no-dashboard   Skip dashboard UI
    --no-cli         Skip CLI tools (worker, orchestrator)
    --no-redis       Skip Redis/distributed worker setup
    -h, --help       Show this help message

  Examples:
    npx @donmai/create-app my-agent
    npx @donmai/create-app my-agent --team ENG
    npx @donmai/create-app my-agent --no-dashboard --no-redis
`)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
