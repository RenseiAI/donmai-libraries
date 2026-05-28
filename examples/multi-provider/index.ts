/**
 * Multi-Provider Example
 *
 * Demonstrates using different agent providers for different work types.
 * For example, Claude for development and Codex for QA.
 *
 * Provider resolution order:
 *   1. AGENT_PROVIDER_{WORKTYPE}  (e.g., AGENT_PROVIDER_QA=codex)
 *   2. AGENT_PROVIDER_{PROJECT}   (e.g., AGENT_PROVIDER_SOCIAL=amp)
 *   3. AGENT_PROVIDER             (global default)
 *   4. 'claude'                   (fallback)
 *
 * Usage:
 *   npx tsx examples/multi-provider/index.ts MyProject
 */

import {
  createOrchestrator,
  createProvider,
  resolveProviderName,
} from '@donmai/core'

const project = process.argv[2]
if (!project) {
  console.error('Usage: npx tsx examples/multi-provider/index.ts <PROJECT>')
  process.exit(1)
}

async function main() {
  // Show which provider will be used for each work type
  const workTypes = ['development', 'qa', 'acceptance'] as const
  for (const wt of workTypes) {
    const name = resolveProviderName({ project, workType: wt })
    console.log(`${wt.padEnd(15)} -> ${name}`)
  }

  // You can also create a specific provider directly
  const claude = createProvider('claude')
  console.log(`\nExplicit provider: ${claude.name}`)

  // Create orchestrator — provider is resolved per-agent
  // based on the work type and project of each issue
  const orchestrator = createOrchestrator({
    project,
    maxConcurrent: 3,
    // worktreePath defaults to '../{repoName}.wt/'
    // Different timeouts per work type
    workTypeTimeouts: {
      development: { inactivityTimeoutMs: 300_000 },
      qa: { inactivityTimeoutMs: 600_000 },          // QA tests take longer
      acceptance: { inactivityTimeoutMs: 120_000 },   // Acceptance is quick
    },
  })

  console.log(`\nProcessing backlog for project "${project}"...`)

  const result = await orchestrator.run()
  console.log(`Spawned ${result.agents.length} agents`)

  if (result.agents.length > 0) {
    await orchestrator.waitForAll()
  }

  for (const agent of result.agents) {
    console.log(`  ${agent.identifier} [${agent.workType}]: ${agent.status}`)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
