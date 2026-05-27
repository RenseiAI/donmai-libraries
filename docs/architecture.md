# Architecture

AgentFactory is a multi-agent orchestrator that turns issue backlogs into shipped code. This document covers the system architecture and how the components fit together.

## System Overview

```
                    ┌───────────────────────────┐
                    │       Linear Issues        │
                    │  (Backlog / Started / ...)  │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │       Orchestrator          │
                    │  - Issue selection          │
                    │  - Agent lifecycle          │
                    │  - Crash recovery           │
                    │  - Inactivity timeout       │
                    └──┬──────────┬──────────┬───┘
                       │          │          │
              ┌────────▼──┐ ┌────▼────┐ ┌───▼───────┐
              │  Agent 1   │ │ Agent 2  │ │  Agent 3   │
              │  Claude    │ │ Codex    │ │  Claude    │
              │  DEV #123  │ │ QA #120  │ │  DEV #125  │
              └────┬───────┘ └────┬────┘ └─────┬─────┘
                   │              │             │
              ┌────▼───────┐ ┌───▼─────┐ ┌────▼──────┐
              │  Worktree   │ │Worktree  │ │ Worktree   │
              │  #123-DEV   │ │#120-QA   │ │ #125-DEV   │
              └────────────┘ └─────────┘ └───────────┘
```

## Package Architecture

AgentFactory is split into nine packages:

| Package | Responsibility |
|---------|---------------|
| `@renseiai/agentfactory` | Core orchestrator, provider abstraction, crash recovery |
| `@renseiai/plugin-linear` | Linear API integration, sessions, status transitions |
| `@renseiai/agentfactory-server` | Redis work queue, session storage, distributed workers |
| `@renseiai/agentfactory-cli` | CLI tools for local and remote operation |
| `@renseiai/agentfactory-nextjs` | Next.js route handlers, webhook processor, OAuth, middleware |
| `@renseiai/agentfactory-dashboard` | Fleet management dashboard UI |
| `@renseiai/agentfactory-mcp-server` | MCP server exposing fleet capabilities to external clients |
| `@renseiai/agentfactory-code-intelligence` | Tree-sitter AST parsing, BM25 search, incremental indexing |
| `@donmai/create-app` | Project scaffolding tool (`npx @donmai/create-app`) |

### Dependency Graph

```
@donmai/create-app (scaffolding, no runtime deps)

@renseiai/agentfactory-nextjs
  ├── @renseiai/agentfactory (core)
  ├── @renseiai/plugin-linear
  └── @renseiai/agentfactory-server

@renseiai/agentfactory-cli
  ├── @renseiai/agentfactory (core)
  ├── @renseiai/plugin-linear
  └── @renseiai/agentfactory-server

@renseiai/agentfactory-server
  ├── @renseiai/agentfactory (core)
  └── @renseiai/plugin-linear
```

For a full webhook-driven setup, install `@renseiai/agentfactory-nextjs` (it pulls in all dependencies). For CLI-only local orchestration, install `@renseiai/agentfactory` and `@renseiai/plugin-linear`.

## Core Components

### Orchestrator

The orchestrator (`packages/core/src/orchestrator/`) manages the full lifecycle of coding agents:

1. **Issue selection** — queries Linear for backlog issues, filters by project, selects by priority
2. **Worktree creation** — creates isolated git worktrees per agent (e.g., `../myrepo.wt/PROJ-123-DEV`)
3. **Agent spawning** — delegates to the provider abstraction to start agents
4. **Stream processing** — iterates `AgentEvent` from the provider, emitting activities to Linear
5. **Completion handling** — detects PR URLs, posts completion comments, transitions status
6. **Crash recovery** — persists state to `.agent/` directory, resumes on restart
7. **Inactivity timeout** — monitors `lastActivityAt` and stops idle agents

Key files:

- `orchestrator.ts` — main orchestration loop (~2,900 lines)
- `types.ts` — `OrchestratorConfig`, `AgentProcess`, `OrchestratorResult`
- `activity-emitter.ts` — streams agent activities to Linear issue view
- `state-recovery.ts` — reads/writes `.agent/state.json` for crash recovery
- `heartbeat-writer.ts` — periodic health signals for crash detection
- `stream-parser.ts` — extracts PR URLs, cost data, and results from agent output
- `log-analyzer.ts` — post-run analysis for creating bug reports

### Provider Abstraction

The provider system (`packages/core/src/providers/`) abstracts away differences between coding agent SDKs:

```typescript
interface AgentProvider {
  readonly name: 'claude' | 'codex' | 'amp' | 'spring-ai' | 'a2a'
  readonly capabilities: AgentProviderCapabilities
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

**AgentEvent** is a discriminated union of normalized events:

| Event | Description |
|-------|-------------|
| `init` | Agent initialized, contains session ID |
| `system` | Status changes, compaction notifications |
| `assistant_text` | Agent's text output |
| `tool_use` | Agent is invoking a tool |
| `tool_result` | Tool execution completed |
| `tool_progress` | Long-running tool progress update |
| `result` | Final result with cost data |
| `error` | Error occurred |

### Tool Plugins

Claude Code's built-in tools (Read, Write, Bash, etc.) cannot be extended directly. The only way to add custom tools is through MCP servers. The `ToolPlugin` system uses the Claude Agent SDK's `createSdkMcpServer()` to register tools that run **in the same process** — no subprocess, no IPC, no network call.

```
Orchestrator
  └── ToolRegistry
        ├── linearPlugin (af-linear)  →  16 typed tools
        └── future plugins...         →  more tools
              │
              ▼
        createSdkMcpServer()  →  in-process MCP server
              │
              ▼
        query({ mcpServers })  →  tools appear alongside Read, Write, Bash
```

When the Claude provider is active, agents call `af_linear_get_issue({ issue_id: "SUP-123" })` directly instead of `Bash("pnpm af-linear get-issue SUP-123")`. Both paths call the same `runLinear()` function — the plugin is a typed wrapper, not a reimplementation.

Non-Claude providers continue using the CLI via Bash. See `docs/providers.md` for details.

Key files:

- `tools/types.ts` — `ToolPlugin` and `ToolPluginContext` interfaces
- `tools/registry.ts` — `ToolRegistry` creates MCP servers from plugins
- `tools/plugins/linear.ts` — Linear plugin (16 tools wrapping `runLinear()`)
- `tools/linear-runner.ts` — shared `runLinear()` used by both CLI and plugin

### Provider Resolution

Provider is selected dynamically per agent using a 10-tier resolution cascade:

```
1. Issue label override (provider:codex)          — explicit human override
2. Mention context override ("use codex")         — explicit human override
3. Config providers.byWorkType                    — static config (.agentfactory/config.yaml)
4. Config providers.byProject                     — static config
5. MAB-based intelligent routing                  — learned routing (feature-flagged)
6. Env var AGENT_PROVIDER_{WORKTYPE}              — static fallback
7. Env var AGENT_PROVIDER_{PROJECT}               — static fallback
8. Config providers.default                       — static fallback
9. Env var AGENT_PROVIDER                         — static fallback
10. Hardcoded 'claude'                            — ultimate fallback
```

This allows configurations like "use Claude for development, Codex for QA" with multiple override mechanisms. See [Providers](./providers.md) for details.

### Linear Integration

The Linear package (`packages/linear/`) provides:

- **LinearAgentClient** — wraps `@linear/sdk` with retry logic and convenience methods
- **AgentSession** — lifecycle management (start, emit activities, update plan, complete)
- **Work type routing** — maps issue status to work type (Backlog -> development, Finished -> QA)
- **Status transitions** — automatic status updates as work progresses
- **Activity streaming** — thoughts, actions, and responses visible in Linear's issue view
- **Plan tracking** — nested task checklists with state (pending, inProgress, completed, canceled)

### Server Components

The server package (`packages/server/`) provides Redis-backed infrastructure:

- **WorkQueue** — sorted set-based priority queue with atomic claim/release
- **SessionStorage** — key-value session state (status, cost, timestamps)
- **WorkerStorage** — worker registration, heartbeat, and capacity tracking
- **IssueLock** — per-issue mutex with pending queue for parking incoming work
- **AgentTracking** — QA attempt counts and agent-worked history
- **WebhookIdempotency** — dedup webhook deliveries with TTL

## Work Types

Issues flow through work stations based on their Linear status:

| Status | Work Type | Agent Role |
|--------|-----------|------------|
| — | `research` | Discovery and analysis phase |
| — | `backlog-creation` | Create issues from research findings |
| Backlog | `development` | Implement the feature or fix |
| Started | `inflight` | Continue in-progress work |
| Finished | `qa` | Validate the implementation |
| Delivered | `acceptance` | Final acceptance testing |
| Rejected | `refinement` | Address feedback and rework |
| — | `merge` | Handle PR merge operations |
| — | `security` | Security scanning (SAST, dependency audit) |

Additional coordination types exist for parent issues with sub-issues:

| Work Type | Description |
|-----------|-------------|
| `coordination` | Orchestrates sub-issue development in parallel |
| `inflight-coordination` | Coordinate in-flight sub-issues |
| `qa-coordination` | Runs QA on all sub-issues, promotes parent if all pass |
| `acceptance-coordination` | Validates all sub-issues, merges PR |
| `refinement-coordination` | Coordinate refinement of sub-issues |

## Crash Recovery

AgentFactory includes built-in crash recovery:

1. **State persistence** — each worktree contains `.agent/state.json` with session state
2. **Heartbeat monitoring** — agents write `.agent/heartbeat.json` every 10 seconds
3. **Crash detection** — stale heartbeat (>30s) indicates a crashed agent
4. **Automatic resume** — orchestrator rebuilds prompt from saved state and resumes
5. **Recovery limits** — configurable max attempts (default: 3) to prevent infinite loops

State file structure:

```
../myrepo.wt/PROJ-123-DEV/.agent/
  ├── state.json      # Session state (issue, work type, prompt, status)
  ├── heartbeat.json  # Last heartbeat timestamp + metrics
  ├── todos.json      # Task list state (survives restarts)
  └── progress.log    # Append-only event log for debugging
```

## Inactivity Timeout

Instead of fixed session timeouts, AgentFactory uses inactivity-based monitoring:

- Each agent tracks `lastActivityAt` from provider events
- A background timer checks all agents periodically
- Agents idle longer than `inactivityTimeoutMs` are stopped
- An optional `maxSessionTimeoutMs` provides a hard cap

This allows long-running agents (large test suites, big refactors) to run as long as they're making progress.

## Workflow Governor / Workflow Engine

The Workflow Governor (`packages/core/src/governor/`) is the central lifecycle manager. It observes all issues across projects and decides what work to dispatch based on issue status, active sessions, cooldowns, and human overrides.

> **Note:** The internal architecture is migrating from "Decision Engine" to "Workflow Engine" (SUP-1756). The Workflow Engine adds structured workflow graphs, parallelism primitives, and gate-based pause/resume. The governor's external API remains backwards-compatible.

### Architecture

```
Platform Webhooks ──► PlatformAdapter.normalizeWebhookEvent()
                              │
                              ▼
                      GovernorEventBus (Redis Stream)
                              │
                    ┌─────────┴──────────┐
                    │                    │
             webhook events        poll-snapshot events
             (real-time)           (every 5 min safety net)
                    │                    │
                    └─────────┬──────────┘
                              │
                    EventDeduplicator
                       (skip if same issue+status within 10s)
                              │
                    Workflow Engine (decideAction)
                              │
                    dispatchWork → Redis work queue → Workers
```

### Two Governor Classes

| Class | Mode | Use Case |
|-------|------|----------|
| `WorkflowGovernor` | Poll-only | Simple periodic scan loop, CLI `--once` mode |
| `EventDrivenGovernor` | Hybrid event + poll | Production: real-time webhook events with periodic safety net |

Both share the same `decideAction()` pure function and dependency injection interface.

### Workflow Engine (Decision Engine)

For each issue, the governor evaluates:

1. **Status** — maps to a potential action (e.g., Backlog → `trigger-development`)
2. **Active session** — skip if an agent is already running
3. **Cooldown** — skip if QA just failed (prevents retry loops)
4. **Parent issue** — routes to coordination work types
5. **Hold override** — skip if a human commented `HOLD`
6. **Priority override** — reorder if `PRIORITY HIGH` / `PRIORITY URGENT`
7. **Workflow strategy** — considers top-of-funnel phases (research, backlog-creation)
8. **Stuck agent detection** — NUDGE action to inject redirect messages via `injectMessage()`

### WorkflowRegistry and Transition Engine

The Workflow Engine is built on two key components in `packages/core/src/workflow/`:

**WorkflowRegistry** — an in-memory registry that manages `WorkflowDefinition` resolution with layered overrides, following the same pattern as `TemplateRegistry`. Definitions are loaded from up to four layers (later overrides earlier):

1. Built-in default (`workflow/defaults/workflow.yaml`)
2. Project-level override (`.agentfactory/workflow.yaml`)
3. External store (Redis-backed, for distributed hot-reload)
4. Inline config override (programmatic, highest priority)

The registry provides escalation strategy resolution (mapping cycle count to strategy via the escalation ladder), parallelism group lookup, and circuit breaker limits. It supports hot-reload — an external `WorkflowRegistryWatcher` can push updated definitions at runtime via `setWorkflow()`.

**Transition Engine** (`evaluateTransitions()`) — a pure function that replaces the hard-coded switch statement in the legacy decision engine. It evaluates the workflow definition's transition table against the current issue status and context:

1. Filter transitions whose `from` status matches the issue's current status
2. Sort by priority (higher first), then by definition order
3. Pick the first matching transition (unconditional, or whose condition expression evaluates to true)
4. Check escalation strategy for override actions (`decompose`, `escalate-human`)
5. Map the target phase name to a `GovernorAction` (e.g., phase `qa` → action `trigger-qa`)

Condition expressions use a built-in expression evaluator with access to issue properties, phase completion state, and sub-issue metadata. For parent issues, the engine also checks parallelism groups — if the target phase belongs to a group, it returns a `trigger-parallel-group` action instead.

```
WorkflowRegistry                      Transition Engine
  │                                      │
  │  getWorkflow() ───────────────────►  evaluateTransitions(ctx)
  │  getEscalationStrategy(cycle) ──►      │
  │  getParallelismGroup(phase) ───►       │ 1. Match transitions by status
  │                                        │ 2. Evaluate condition expressions
  │                                        │ 3. Apply escalation overrides
  │                                        │ 4. Map phase → GovernorAction
  │                                        ▼
  │                                   TransitionResult { action, reason }
```

### Workflow Parallelism

The Workflow Engine supports structured parallelism patterns (SUP-1231):

- **Fan-out** — spawn multiple agents in parallel (e.g., sub-issue development)
- **Fan-in** — wait for all parallel agents to complete before proceeding
- **Race** — proceed when the first of N parallel agents completes

Parallelism is configured with `maxConcurrent` to limit resource usage.

### Workflow Gates

Workflow gates allow pausing and resuming workflows based on external signals (SUP-1229):

- **Signal gate** — pauses until an external event (webhook, API call) is received
- **Timer gate** — pauses for a configurable duration (e.g., wait 5 minutes before retry)
- **Webhook gate** — pauses until a specific webhook payload is received

Gates have configurable timeouts — if the signal isn't received within the timeout, the workflow resumes with a timeout status.

### GovernorDependencies

All external state is injected through the `GovernorDependencies` interface:

```typescript
interface GovernorDependencies {
  listIssues(project: string): Promise<GovernorIssue[]>
  hasActiveSession(issueId: string): Promise<boolean>
  isWithinCooldown(issueId: string): Promise<boolean>
  isParentIssue(issueId: string): Promise<boolean>
  isHeld(issueId: string): Promise<boolean>
  getOverridePriority(issueId: string): Promise<OverridePriority | null>
  getWorkflowStrategy(issueId: string): Promise<string | undefined>
  isResearchCompleted(issueId: string): Promise<boolean>
  isBacklogCreationCompleted(issueId: string): Promise<boolean>
  dispatchWork(issueId: string, action: GovernorAction): Promise<void>
}
```

### PlatformAdapter

The `PlatformAdapter` interface abstracts platform-specific operations for multi-platform support:

```typescript
interface PlatformAdapter {
  readonly name: string
  normalizeWebhookEvent(payload: unknown): GovernorEvent[] | null
  scanProjectIssues(project: string): Promise<GovernorIssue[]>
  toGovernorIssue(native: unknown): Promise<GovernorIssue>
  isParentIssue(issueId: string): Promise<boolean>
}
```

`LinearPlatformAdapter` (in `packages/linear`) implements this for Linear. Additional adapters (Asana, Jira, etc.) would follow the same pattern.

### GovernorEventBus

Events flow through the `GovernorEventBus` interface:

```typescript
interface GovernorEventBus {
  publish(event: GovernorEvent): Promise<string>
  subscribe(): AsyncIterable<{ id: string; event: GovernorEvent }>
  ack(eventId: string): Promise<void>
  close(): Promise<void>
}
```

Two implementations:
- `InMemoryEventBus` — for testing and single-process CLI
- `RedisEventBus` — production, uses Redis Streams with consumer groups

### Governor Mode

The webhook server supports three modes via `governorMode` in `WebhookConfig`:

| Mode | Webhooks | Governor Events | Use Case |
|------|----------|----------------|----------|
| `direct` | Dispatch directly | Not published | Default, no governor needed |
| `event-bridge` | Dispatch AND publish events | Published to Redis Stream | Dual-write for safe rollout |
| `governor-only` | Only publish events | Published to Redis Stream | Governor handles all lifecycle |

### Human Override Commands

Users can override the governor by adding Linear comments:

- `HOLD` — Pause all automated processing
- `RESUME` — Resume automated processing
- `PRIORITY HIGH` / `PRIORITY URGENT` — Override priority for next dispatch

## Merge Queue Architecture

The merge queue handles automated PR rebase and merge after agents complete their work:

```
Agent completes PR
        │
        ▼
  Acceptance passes
        │
        ▼
  ┌─────────────┐
  │ Merge Queue  │──── Queue entries stored in Redis
  │  (sorted by  │     with priority, status, retry count
  │   priority)  │
  └──────┬──────┘
         │
    ┌────▼────┐
    │ Rebase  │──── git rebase onto main
    │ + Test  │──── run testCommand
    └────┬────┘
         │
    ┌────▼────────┐
    │  Mergiraf   │──── Syntax-aware conflict resolution
    │ (optional)  │     for supported file types
    └────┬────────┘
         │
    ┌────▼────┐
    │  Merge  │──── strategy: rebase, merge, or squash
    └────┬────┘
         │
    ┌────▼────────┐
    │  Cleanup    │──── Delete branch, update issue status
    └─────────────┘
```

**Providers:** `local` (built-in), `github-native` (GitHub merge queue API), `mergify`, `trunk`.

**Escalation:** Configurable policies for conflicts (`reassign`, `notify`, `park`) and test failures (`notify`, `park`, `retry`).

## Code Intelligence Architecture

The code intelligence system provides codebase navigation tools for agents:

```
Source Files (.ts, .tsx, .js, .py, .go, .rs)
        │
        ▼
  ┌──────────────────┐
  │  Tree-sitter AST │──── Language-specific symbol extraction
  │    Parsing       │     (functions, classes, interfaces, types)
  └────────┬─────────┘
           │
     ┌─────┴──────┐
     │            │
┌────▼────┐ ┌────▼──────┐
│  BM25   │ │ Semantic  │
│ Index   │ │ Embeddings│
└────┬────┘ └─────┬─────┘
     │            │
     └─────┬──────┘
           │
  ┌────────▼─────────┐
  │  Hybrid Search   │──── BM25 + semantic similarity
  │  (reranking)     │     with Cohere/Voyage reranking
  └────────┬─────────┘
           │
  ┌────────▼─────────┐
  │   PageRank       │──── Import graph analysis
  │   Repo Map       │     for file importance ranking
  └──────────────────┘
```

**6 core tools:** `af_code_search_code`, `af_code_search_symbols`, `af_code_get_repo_map`, `af_code_find_type_usages`, `af_code_validate_cross_deps`, `af_code_check_duplicate`.

**3 optional file reservation tools** (active during parallel coordination): `af_code_reserve_files`, `af_code_check_conflicts`, `af_code_release_files`.

**Deduplication:** xxHash64 exact match + SimHash near-duplicate detection.

See [Code Intelligence](./code-intelligence.md) for tool usage and configuration.

## Distributed Architecture

For horizontal scaling, AgentFactory supports a coordinator + worker topology:

```
┌─────────────────┐     ┌──────────┐     ┌──────────────────┐
│  Webhook Server  │────>│  Redis   │<────│  Worker Node 1    │
│  (enqueues work) │     │  Queue   │     │  (claims + runs)  │
└─────────────────┘     │          │     └──────────────────┘
                        │          │     ┌──────────────────┐
                        │          │<────│  Worker Node 2    │
                        └──────────┘     └──────────────────┘
```

Workers are stateless — all coordination happens through Redis. Scale by adding more worker processes.
