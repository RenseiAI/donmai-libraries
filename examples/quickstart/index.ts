/**
 * Donmai Quickstart
 *
 * Minimal example: spawn one coding agent on a Linear issue.
 *
 * Prerequisites:
 *   - LINEAR_API_KEY set in environment
 *   - A git repository with a Linear project
 *
 * Usage:
 *   npx tsx examples/quickstart/index.ts PROJ-123
 */

import { createOrchestrator } from '@donmai/core'

const issueId = process.argv[2]
if (!issueId) {
  console.error('Usage: npx tsx examples/quickstart/index.ts <ISSUE-ID>')
  console.error('  e.g. npx tsx examples/quickstart/index.ts PROJ-123')
  process.exit(1)
}

async function main() {
  // Create an orchestrator with sensible defaults
  const orchestrator = createOrchestrator({
    maxConcurrent: 1,
    // worktreePath defaults to '../{repoName}.wt/'
    inactivityTimeoutMs: 300_000, // 5 minutes
  })

  console.log(`Spawning agent for ${issueId}...`)

  // Spawn a single agent — it will:
  // 1. Create a git worktree
  // 2. Fetch issue details from Linear
  // 3. Run a coding agent (default: Claude)
  // 4. Create a PR when done
  // 5. Update Linear status
  await orchestrator.spawnAgentForIssue(issueId)

  console.log('Agent is running. Waiting for completion...')

  // Wait for the agent to finish
  await orchestrator.waitForAll()

  // Check results
  const agents = orchestrator.getAgents()
  for (const agent of agents) {
    console.log(`${agent.identifier}: ${agent.status}`)
    if (agent.pullRequestUrl) {
      console.log(`  PR: ${agent.pullRequestUrl}`)
    }
    if (agent.totalCostUsd) {
      console.log(`  Cost: $${agent.totalCostUsd.toFixed(4)}`)
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
