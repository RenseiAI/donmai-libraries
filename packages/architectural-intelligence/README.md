# @renseiai/architectural-intelligence

System-level synthesis of patterns, conventions, decisions, and drift across a codebase.

Part of the [Rensei AgentFactory](https://github.com/RenseiAI/agentfactory) toolchain.

## What it does

Architectural Intelligence observes a codebase's evolution and synthesizes structured knowledge about it:

- **Patterns** — recurring structural shapes (e.g. "all routes export a `POST` handler that calls `requireOrgAccess`")
- **Conventions** — agreed-upon norms (e.g. "tests live next to source as `*.test.ts`")
- **Decisions** — recorded architectural choices (e.g. "auth uses WorkOS, not Auth0")
- **Deviations** — places the codebase departs from its own patterns/conventions/decisions
- **Drift** — quantified deviation pressure that crosses a threshold and warrants intervention

The package ships:

| Capability | Entry points |
|---|---|
| Single-tenant local store | `SqliteArchitecturalIntelligence` |
| Multi-tenant store (injected Postgres handle) | `PostgresArchitecturalIntelligence`, `adapterFromPostgresJs` |
| Observation pipeline | `runObservationPass`, `attachPipelineSubscribers`, `readDiffObservations` |
| Synthesis prompts (versioned registry) | `promptRegistry`, `currentPrompt`, `versionedPrompt` |
| Eval / A/B test harness | `evaluatePrompt`, `compareABPrompts` |
| Drift detection | `assessChange`, `resolveDriftGatePolicy`, `evaluateGate` |
| Workflow verb registration | `registerArchitectureVerbs`, `ASSESS_CHANGE_VERB` |

## Installation

```bash
pnpm add @renseiai/architectural-intelligence
```

Node >= 22 required.

## Quick start

```ts
import {
  SqliteArchitecturalIntelligence,
  runObservationPass,
  assessChange,
} from '@renseiai/architectural-intelligence'

// 1. Open or create the per-tenant store
const store = new SqliteArchitecturalIntelligence({ dbPath: '.agentfactory/arch.db' })

// 2. Run an observation pass over the change set
const result = await runObservationPass({
  store,
  changeRef: { sha: 'abc123', baseSha: 'main', files: [/* PrDiff entries */] },
})

// 3. Gate on drift — block the merge / open a review issue when the threshold trips
const drift = await assessChange({ store, changeRef: result.changeRef })
if (drift.driftScore > drift.policy.maxDrift) {
  // surface the deviations to the agent or human reviewer
}
```

## Workflow verb integration

For platform consumers that drive AgentFactory through the workflow engine, register the `assess-change` verb:

```ts
import { registerArchitectureVerbs } from '@renseiai/architectural-intelligence'

registerArchitectureVerbs(verbRegistry)
```

The verb accepts a `changeRef` input and emits an `assessment` output (drift score + flagged deviations) that downstream workflow nodes can branch on.

## Status

Consumed at runtime by [`@renseiai/agentfactory`](https://www.npmjs.com/package/@renseiai/agentfactory) (orchestrator + context injection).

## License

MIT — see [LICENSE](./LICENSE).
