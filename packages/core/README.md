# @donmai/core

Core orchestrator for multi-agent fleet management. Turns your issue backlog into shipped code by coordinating coding agents (Claude, Codex, Amp) through an automated pipeline.

Part of the [Donmai](https://github.com/RenseiAI/donmai-libraries) monorepo.

## Installation

```bash
npm install @donmai/core @donmai/plugin-linear
```

## Quick Start

```typescript
import { createOrchestrator } from '@donmai/core'

const orchestrator = createOrchestrator({
  maxConcurrent: 3,
  // Default: '../{repoName}.wt/' (sibling directory)
})

// Process a single issue
await orchestrator.spawnAgentForIssue('PROJ-123')
await orchestrator.waitForAll()

// Check results
for (const agent of orchestrator.getAgents()) {
  console.log(`${agent.identifier}: ${agent.status}`)
  if (agent.pullRequestUrl) console.log(`  PR: ${agent.pullRequestUrl}`)
  if (agent.totalCostUsd) console.log(`  Cost: $${agent.totalCostUsd.toFixed(4)}`)
}
```

## What It Does

1. **Issue selection** — queries Linear for backlog issues, filters by project, selects by priority
2. **Worktree creation** — creates isolated git worktrees per agent
3. **Agent spawning** — delegates to providers (Claude, Codex, Amp)
4. **Stream processing** — iterates `AgentEvent` from providers, emits activities to Linear
5. **Crash recovery** — persists state to `.agent/` directory, resumes on restart
6. **Inactivity timeout** — monitors idle agents and stops them

## Provider Abstraction

```typescript
interface AgentProvider {
  readonly name: 'claude' | 'codex' | 'amp'
  spawn(config: AgentSpawnConfig): AgentHandle
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle
}

interface AgentHandle {
  sessionId: string | null
  stream: AsyncIterable<AgentEvent>
  injectMessage(text: string): Promise<void>
  stop(): Promise<void>
}
```

Provider resolution: `AGENT_PROVIDER_{WORKTYPE}` > `AGENT_PROVIDER_{PROJECT}` > `AGENT_PROVIDER` > `'claude'`

## Configuration

```typescript
const orchestrator = createOrchestrator({
  provider: myProvider,            // Agent provider instance
  maxConcurrent: 3,                // Max concurrent agents
  project: 'MyProject',           // Filter by project
  // worktreePath defaults to '../{repoName}.wt/' (sibling directory)
  inactivityTimeoutMs: 300_000,   // 5 min idle timeout
  maxSessionTimeoutMs: 7_200_000, // 2 hour hard cap
  workTypeTimeouts: {
    qa: { inactivityTimeoutMs: 600_000 },
  },
})
```

## Workflow Governor

The core package includes the Workflow Governor — a central lifecycle manager that observes all issues and decides what work to dispatch.

```typescript
import {
  WorkflowGovernor,
  EventDrivenGovernor,
  InMemoryEventBus,
  InMemoryEventDeduplicator,
  type GovernorDependencies,
} from '@donmai/core'

// Poll-only mode (simple)
const governor = new WorkflowGovernor(
  { projects: ['MyProject'], scanIntervalMs: 60_000 },
  myDependencies,
)
governor.start()

// Event-driven mode (production)
const eventGovernor = new EventDrivenGovernor(
  {
    projects: ['MyProject'],
    eventBus: new InMemoryEventBus(),        // or RedisEventBus
    deduplicator: new InMemoryEventDeduplicator(), // or RedisEventDeduplicator
    pollIntervalMs: 300_000,                 // 5 min safety net
  },
  myDependencies,
)
await eventGovernor.start()
```

The governor evaluates each issue against status, active sessions, cooldowns, human overrides (HOLD/RESUME/PRIORITY), and workflow strategy to decide what action to take. See [Architecture docs](https://github.com/RenseiAI/donmai-libraries/blob/main/docs/architecture.md#workflow-governor) for details.

## Related Packages

| Package | Description |
|---------|-------------|
| [@donmai/plugin-linear](https://www.npmjs.com/package/@donmai/plugin-linear) | Linear issue tracker integration |
| [@donmai/server](https://www.npmjs.com/package/@donmai/server) | Redis work queue, distributed workers |
| [@donmai/cli](https://www.npmjs.com/package/@donmai/cli) | CLI tools |
| [@donmai/nextjs](https://www.npmjs.com/package/@donmai/nextjs) | Next.js webhook server |

## License

MIT
