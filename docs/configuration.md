# Configuration Reference

Complete reference for all Donmai configuration options.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `LINEAR_ACCESS_TOKEN` | Linear API key — used by the Next.js webhook server and `createDefaultLinearClientResolver()` |
| `LINEAR_API_KEY` | Linear API key — used by CLI tools (`af-orchestrator`, `af-worker`, etc.) |

> **Tip:** Set both to the same Linear API key value. If you only use CLI tools, `LINEAR_API_KEY` is sufficient. If you only use the Next.js server, `LINEAR_ACCESS_TOKEN` is sufficient.

### Webhook Server

| Variable | Default | Description |
|----------|---------|-------------|
| `LINEAR_WEBHOOK_SECRET` | — | Secret for verifying Linear webhook signatures |
| `LINEAR_CLIENT_ID` | — | OAuth app client ID (multi-workspace) |
| `LINEAR_CLIENT_SECRET` | — | OAuth app client secret |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | App URL for OAuth redirects |
| `REDIS_URL` | — | Redis connection URL for distributed workers |

### Agent Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PROVIDER` | `claude` | Default provider: `claude`, `codex`, `amp`, `spring-ai`, `a2a` |
| `AGENT_PROVIDER_{WORKTYPE}` | — | Per-work-type override (e.g., `AGENT_PROVIDER_QA=codex`) |
| `AGENT_PROVIDER_{PROJECT}` | — | Per-project override (e.g., `AGENT_PROVIDER_SOCIAL=amp`) |

### Worker Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_API_URL` | — | Webhook server URL (for remote workers) |
| `WORKER_API_KEY` | — | API key for worker authentication |

### Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_INACTIVITY_TIMEOUT_MS` | `300000` (5 min) | Stop agent after this idle period |
| `AGENT_MAX_SESSION_TIMEOUT_MS` | unlimited | Hard cap on session duration |
| `AGENT_HEARTBEAT_INTERVAL_MS` | `10000` (10 sec) | Heartbeat write interval |
| `AGENT_HEARTBEAT_TIMEOUT_MS` | `30000` (30 sec) | Heartbeat staleness threshold |
| `AGENT_MAX_RECOVERY_ATTEMPTS` | `3` | Max crash recovery attempts |

### Auto-Trigger

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_AUTO_QA` | `false` | Auto-trigger QA when issues move to Finished |
| `ENABLE_AUTO_ACCEPTANCE` | `false` | Auto-trigger acceptance when issues move to Delivered |
| `AUTO_QA_REQUIRE_AGENT_WORKED` | `true` | Only auto-QA issues previously worked by agent |
| `AUTO_ACCEPTANCE_REQUIRE_AGENT_WORKED` | `true` | Only auto-accept agent-worked issues |
| `AUTO_QA_PROJECTS` | (all) | Comma-separated project names to auto-QA |
| `AUTO_ACCEPTANCE_PROJECTS` | (all) | Comma-separated project names to auto-accept |
| `AUTO_QA_EXCLUDE_LABELS` | — | Labels that exclude from auto-QA |
| `AUTO_ACCEPTANCE_EXCLUDE_LABELS` | — | Labels that exclude from auto-acceptance |

### Governor

| Variable | Default | Description |
|----------|---------|-------------|
| `GOVERNOR_MODE` | `direct` | Webhook governor mode: `direct`, `event-bridge`, `governor-only` |
| `GOVERNOR_PROJECTS` | — | Comma-separated projects to scan |
| `GOVERNOR_POLL_INTERVAL_MS` | `300000` (5 min) | Poll sweep interval for event-driven mode safety net |

## Repository Configuration (`.donmai/config.yaml`)

The declarative config file controls repository-level settings. Place it at `.donmai/config.yaml` in your repo root.

### `profiles:` + `dispatch:` — Profile-Based Agent Configuration (preferred)

A **profile** bundles provider + model + effort + provider-specific config + sub-agent overrides into a single named unit. The `dispatch:` section routes work types and projects to named profiles. This replaces the flat `providers:` + `models:` sections, which could not couple a provider with a specific model or reasoning effort per work type.

```yaml
profiles:
  codex-dev:
    provider: codex
    model: gpt-5.4
    effort: high
    openai:
      serviceTier: fast
      reasoningSummary: concise
    subAgent:
      model: gpt-5.4-mini
      effort: low

  claude-coord:
    provider: claude
    model: claude-opus-4-7
    effort: xhigh
    anthropic:
      contextWindow: 1000000
    subAgent:
      provider: claude
      model: claude-sonnet-4-6
      effort: medium

  claude-qa:
    provider: claude
    model: claude-sonnet-4-6
    effort: medium

dispatch:
  default: codex-dev                 # Profile used when no byWorkType / byProject match
  byWorkType:
    coordination: claude-coord       # Coordinators get Opus with 1M context
    qa: claude-qa                    # QA uses Sonnet
  byProject:
    Backend: codex-dev               # All Backend work uses codex-dev
```

#### `profiles.<name>` fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | `claude`, `codex`, `amp`, `spring-ai`, `a2a` |
| `model` | string | No | Free-form model ID (e.g., `gpt-5.4`, `claude-opus-4-7`). Passed through to the provider SDK unvalidated. Omit to use provider default. |
| `effort` | enum | No | Normalized reasoning effort: `low`, `medium`, `high`, `xhigh`. Mapped to provider-native params (see below). |
| `subAgent` | object | No | Overrides for Task/coordinator sub-agents — `{ provider?, model?, effort? }`. Unset fields inherit from the parent profile. |
| `openai` | map | No | Raw OpenAI/Codex options (e.g., `serviceTier`, `reasoningSummary`). Extracted when the resolved provider is `codex` or `spring-ai`. |
| `anthropic` | map | No | Raw Anthropic options (e.g., `contextWindow`). Extracted for `claude` and `amp`. |
| `codex` | map | No | Codex-specific options (e.g., `useAppServer`). |
| `gemini` | map | No | Raw Google options (e.g., `thinkingBudget`, `temperature`). Extracted for `a2a`. |

#### `dispatch:` fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `default` | string | Yes | Profile name used when nothing else matches. Must reference a key in `profiles`. |
| `byWorkType` | map | No | Work-type → profile name. Keys: `development`, `qa`, `acceptance`, `research`, `backlog-creation`, `refinement`, `coordination`, etc. |
| `byProject` | map | No | Linear project name → profile name. |

Dispatch selection priority: **`byWorkType` > `byProject` > `default`**.

#### Effort level mapping

The normalized `effort` enum is translated to each provider's native parameter:

| `effort` | Claude (`effort`) | Codex/OpenAI (`reasoningEffort`) | Gemini (`thinkingBudget` tokens) |
|----------|-------------------|----------------------------------|----------------------------------|
| `low` | `low` | `low` | 4,096 |
| `medium` | `medium` | `medium` | 16,384 |
| `high` | `high` | `high` | 32,768 |
| `xhigh` | `xhigh` | `xhigh` | 65,536 |

#### Provider-specific config selection

The profile carries four optional raw-options blocks (`openai`, `anthropic`, `codex`, `gemini`). At spawn time, only the block that matches the resolved provider is forwarded to the provider as `providerConfig`:

| Resolved provider | Block used |
|-------------------|------------|
| `codex` | `openai` |
| `claude` | `anthropic` |
| `amp` | `anthropic` |
| `a2a` | `gemini` |
| `spring-ai` | `openai` |

This lets a single profile carry settings for multiple providers and lets label/env overrides swap the provider without losing the right options.

#### Sub-agent resolution

Sub-agent fields cascade (highest first):
1. Platform dispatch sub-agent model (from `QueuedWork.subAgentModel`)
2. Env `AGENT_SUB_MODEL`
3. `profiles.<name>.subAgent.{provider,model,effort}`
4. Inherited from the parent profile (provider/model/effort)

#### Override cascade (within a resolved profile)

After `dispatch` picks a profile, individual fields can still be overridden. Priority (highest wins):

| Tier | Source | Overrides |
|------|--------|-----------|
| 1 | Platform dispatch model (`QueuedWork.model`) | `model` |
| 2 | Issue label `model:<id>` / `provider:<name>` | `model`, `provider` |
| 3 | Mention context (`use codex`, `@codex`, `provider:codex`) | `provider` |
| 4 | Env `AGENT_PROVIDER_{WORKTYPE}` / `AGENT_MODEL_{WORKTYPE}` | `provider`, `model` |
| 5 | Env `AGENT_PROVIDER_{PROJECT}` / `AGENT_MODEL_{PROJECT}` | `provider`, `model` |
| 6 | Env `AGENT_PROVIDER` / `AGENT_MODEL` | `provider`, `model` |
| 7 | Profile defaults | — |

`effort` is not overridable via label/env — it is taken from the profile.

#### Validation rules

- `profiles` and `dispatch` must both be present or both absent. Using one without the other is a schema error.
- Every name in `dispatch.default`, `dispatch.byWorkType.*`, and `dispatch.byProject.*` must exist as a key in `profiles`.
- Legacy `providers:` and `models:` sections are **silently ignored** when `profiles` is present.

### `providers:` / `models:` — Legacy Provider Selection

> **Superseded by `profiles` + `dispatch`.** These sections still parse and work when `profiles` is not defined, but they can't couple a provider with a model or effort per work type. Prefer profiles for anything new.

Route agents to different providers by work type or project:

```yaml
providers:
  default: claude                    # Default for all agents
  byWorkType:
    qa: codex                        # Use Codex for QA
    acceptance: amp                  # Use Amp for acceptance
  byProject:
    Backend: codex                   # Use Codex for Backend project
    Social: spring-ai               # Use Spring AI for Social project
```

A parallel `models:` section with the same shape (`default`, `byWorkType`, `byProject`, plus `subAgent`) controls the model ID. When both `profiles` and `providers`/`models` are defined, the profile config wins and the legacy sections are ignored.

Legacy config-file settings integrate with the full [resolution cascade](#provider-resolution-cascade) — they sit between label/mention overrides and environment variable fallbacks.

### `routing:` — MAB Intelligent Routing

Enable Thompson Sampling-based provider selection that learns optimal routing from outcomes:

```yaml
routing:
  enabled: true                      # Enable MAB routing (default: false)
  explorationRate: 0.1               # 0-1, fraction of requests to explore (default: 0.1)
  windowSize: 100                    # Observation window size (default: 100)
  discountFactor: 0.99               # Discount for older observations (default: 0.99)
  minObservationsForExploit: 5       # Min data points before exploiting (default: 5)
  changeDetectionThreshold: 0.2      # Threshold for detecting model drift (default: 0.2)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable MAB-based intelligent routing |
| `explorationRate` | number (0-1) | `0.1` | Fraction of requests to explore random providers |
| `windowSize` | integer | `100` | Number of recent observations to consider |
| `discountFactor` | number (0-1) | `0.99` | Exponential discount for older observations |
| `minObservationsForExploit` | integer | `5` | Minimum observations before choosing best provider |
| `changeDetectionThreshold` | number | `0.2` | Threshold for detecting provider performance changes |

The routing engine tracks task completion, PR creation, QA results, cost, and wall-clock time per (provider, workType) pair. It builds Beta distribution posteriors and uses Thompson Sampling to balance exploration vs. exploitation.

### `mergeQueue:` — Merge Queue

Configure automated PR rebase and merge:

```yaml
mergeQueue:
  provider: local                    # Merge queue provider (default: local)
  enabled: false                     # Enable merge queue integration (default: false)
  autoMerge: true                    # Auto-add approved PRs to queue (default: true)
  strategy: rebase                   # rebase, merge, or squash (default: rebase)
  testCommand: "pnpm test"           # Command to run after rebase (default: "pnpm test")
  testTimeout: 300000                # Timeout for test command in ms (default: 300000)
  lockFileRegenerate: true           # Regenerate lock files after rebase (default: true)
  mergiraf: true                     # Syntax-aware conflict resolution (default: true)
  pollInterval: 10000                # Queue polling interval in ms (default: 10000)
  maxRetries: 2                      # Max retries for failed merges (default: 2)
  deleteBranchOnMerge: true          # Delete branch after merge (default: true)
  concurrency: 1                     # Max concurrent merge operations (default: 1)
  requiredChecks:                    # CI checks that must pass (provider-specific)
    - "ci/build"
    - "ci/test"
  escalation:
    onConflict: reassign             # reassign, notify, or park (default: reassign)
    onTestFailure: notify            # notify, park, or retry (default: notify)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `provider` | string | `local` | `local`, `github-native`, `mergify`, `trunk` |
| `enabled` | boolean | `false` | Enable merge queue integration |
| `autoMerge` | boolean | `true` | Automatically add approved PRs to queue |
| `strategy` | string | `rebase` | Merge strategy: `rebase`, `merge`, `squash` |
| `testCommand` | string | `pnpm test` | Command to run after rebase |
| `testTimeout` | number | `300000` | Test command timeout in milliseconds |
| `lockFileRegenerate` | boolean | `true` | Regenerate lock files after rebase |
| `mergiraf` | boolean | `true` | Use mergiraf for syntax-aware conflict resolution |
| `pollInterval` | number | `10000` | Queue polling interval in milliseconds |
| `maxRetries` | number | `2` | Max retries for failed merges |
| `deleteBranchOnMerge` | boolean | `true` | Delete PR branch after successful merge |
| `requiredChecks` | string[] | — | CI checks required before merge |
| `concurrency` | number | `1` | Max concurrent merge operations (>1 enables parallel merge pool) |
| `escalation.onConflict` | string | `reassign` | Policy for merge conflicts |
| `escalation.onTestFailure` | string | `notify` | Policy for test failures after rebase |

### `quality:` — Quality Gates

```yaml
quality:
  baselineEnabled: false             # Capture baseline metrics (default: false)
  ratchetEnabled: false              # Enforce quality ratchet (default: false)
  boyscoutRule: true                 # Include "leave it better" instructions (default: true)
  tddWorkflow: true                  # Include TDD workflow instructions (default: true)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `baselineEnabled` | boolean | `false` | Capture quality baseline from `main` before agent starts |
| `ratchetEnabled` | boolean | `false` | Enforce that agents don't regress test counts, typecheck errors, or lint errors |
| `boyscoutRule` | boolean | `true` | Include boy scout rule instructions in agent prompts |
| `tddWorkflow` | boolean | `true` | Include TDD workflow instructions in agent prompts |

See [Quality Gates](./quality-gates.md) for details on baseline capture and ratchet enforcement.

### `codeIntelligence:` — Code Intelligence Enforcement

Control how agents use code intelligence tools:

```yaml
codeIntelligence:
  enforceUsage: false           # Require agents to use af_code_* tools before Grep/Glob (default: false)
  fallbackAfterAttempt: true    # Allow Grep/Glob after at least one af_code_* tool call (default: true)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enforceUsage` | boolean | `false` | When true, agents must use `af_code_*` tools before falling back to Grep/Glob |
| `fallbackAfterAttempt` | boolean | `true` | Allow traditional search tools after at least one code intelligence tool call |

When `enforceUsage` is enabled, the orchestrator includes prompt instructions directing agents to prefer `af_code_search_code` over `Grep` and `af_code_search_symbols` over `Glob` for initial codebase exploration.

### `mergeDriver:` — Git Merge Driver

Select the git merge driver used in agent worktrees:

```yaml
mergeDriver: mergiraf              # Syntax-aware merging (default: "default")
```

| Value | Description |
|-------|-------------|
| `default` | Standard git line-based merge (the default) |
| `mergiraf` | Syntax-aware merging via [mergiraf](https://mergiraf.org/) for supported file types |

When set to `mergiraf`, Donmai configures the worktree's `.gitattributes` and `.git/config` to use mergiraf as a custom merge driver. This reduces merge conflicts in structured files (TypeScript, JSON, YAML, etc.). See the [mergiraf setup guide](./guides/mergiraf-setup.md) for installation instructions.

### `packageManager:` — Package Manager

Specify the package manager used by the project:

```yaml
packageManager: pnpm               # default: "pnpm"
```

| Value | Description |
|-------|-------------|
| `pnpm` | pnpm (default) |
| `npm` | npm |
| `yarn` | Yarn |
| `bun` | Bun |
| `none` | No package manager — disables dependency linking and helper scripts (for non-Node projects) |

Injected into workflow templates as `{{packageManager}}`. Set to `none` for non-Node projects (Go, Rust, Python, etc.).

### `linearCli:` — Linear CLI Command

Override the command used to invoke the Linear CLI:

```yaml
linearCli: "npx -y @donmai/cli af-linear"
```

Default: `"pnpm af-linear"`. Override this for non-Node projects or custom setups:

```yaml
# Non-Node project — use npx to run without local install
linearCli: "npx -y @donmai/cli af-linear"

# Custom wrapper script
linearCli: "./tools/af-linear.sh"

# Absolute path
linearCli: "/usr/local/bin/af-linear"
```

Injected into workflow templates as `{{linearCli}}` (when `useToolPlugins` is false).

### `buildCommand:`, `testCommand:`, `validateCommand:` — Command Overrides

Override the build, test, and validation commands for non-Node or custom projects:

```yaml
buildCommand: "cargo build"
testCommand: "cargo test"
validateCommand: "cargo clippy"
```

| Option | Template Variable | Default | Description |
|--------|------------------|---------|-------------|
| `buildCommand` | `{{buildCommand}}` | — | Build command (e.g., `cargo build`, `cmake --build build`, `make`) |
| `testCommand` | `{{testCommand}}` | — | Test command (e.g., `cargo test`, `ctest --test-dir build`, `make test`) |
| `validateCommand` | `{{validateCommand}}` | — | Validation command — replaces typecheck for compiled projects (e.g., `cargo clippy`, `go vet ./...`) |

These commands are injected into workflow templates and used by quality gates. When not set, agents use the package manager defaults (e.g., `pnpm build`, `pnpm test`).

### `projectPaths:` — Project Directory Mapping

Map Linear project names to their root directories within a monorepo. Supports two forms:

**String shorthand** — project name maps to a path:

```yaml
projectPaths:
  Frontend: "apps/web"
  Backend: "apps/api"
  Shared: "packages/shared"
```

**Object form** — per-project overrides for package manager, build, test, and validate commands:

```yaml
projectPaths:
  Frontend: "apps/web"                     # String shorthand
  Backend:
    path: "apps/api"
    packageManager: npm
    testCommand: "npm test"
  "Family iOS":
    path: "apps/family-ios"
    packageManager: none
    buildCommand: "make build"
    testCommand: "make test"
    validateCommand: "swiftlint"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | Yes | Root directory for this project within the repo |
| `packageManager` | string | No | Package manager override (`pnpm`, `npm`, `yarn`, `bun`, `none`) |
| `buildCommand` | string | No | Build command override |
| `testCommand` | string | No | Test command override |
| `validateCommand` | string | No | Validation command override |

Per-project values override the repo-wide defaults. String shorthand values are normalized to `{ path: value }` internally.

> **Note:** `projectPaths` and `allowedProjects` are mutually exclusive. When `projectPaths` is set, its keys become the allowed project list.

### Provider Resolution Cascade

When `profiles` + `dispatch` are configured (preferred), resolution runs in two phases — see the [profile override cascade](#override-cascade-within-a-resolved-profile) above.

The cascade below applies only when `profiles` is **not** set and the legacy `providers:` / `models:` sections are in use (async mode with MAB routing):

| Tier | Source | Description |
|------|--------|-------------|
| 1 | Issue label | `provider:codex` label on the Linear issue |
| 2 | Mention context | "use codex", "@codex", or "provider:codex" in prompt |
| 3 | Config `providers.byWorkType` | Work-type override from `.donmai/config.yaml` |
| 4 | Config `providers.byProject` | Project override from `.donmai/config.yaml` |
| 5 | MAB routing | Thompson Sampling learned routing (when `routing.enabled: true`) |
| 6 | Env `AGENT_PROVIDER_{WORKTYPE}` | e.g., `AGENT_PROVIDER_QA=codex` |
| 7 | Env `AGENT_PROVIDER_{PROJECT}` | e.g., `AGENT_PROVIDER_SOCIAL=amp` |
| 8 | Config `providers.default` | Default provider from config file |
| 9 | Env `AGENT_PROVIDER` | Global environment variable |
| 10 | Hardcoded | `claude` |

Without MAB routing enabled, the synchronous cascade skips tier 5 (9 tiers total).

## Route Factory Configuration

### `createAllRoutes(config)`

Central factory that creates all 21+ route handlers from a single config:

```typescript
import { createAllRoutes, createDefaultLinearClientResolver } from '@donmai/nextjs'

const routes = createAllRoutes({
  // Required: how to resolve a Linear API client
  linearClient: createDefaultLinearClientResolver(),

  // Optional: customize prompt generation
  generatePrompt: (identifier, workType, mentionContext) => string,

  // Optional: detect work type from a free-text prompt
  detectWorkTypeFromPrompt: (prompt, validWorkTypes) => AgentWorkType | undefined,

  // Optional: assign priority to work types
  getPriority: (workType) => number,

  // Optional: auto-trigger configuration
  autoTrigger: {
    enableAutoQA: true,
    enableAutoAcceptance: false,
    autoQARequireAgentWorked: true,
    autoAcceptanceRequireAgentWorked: true,
    autoQAProjects: [],
    autoAcceptanceProjects: [],
    autoQAExcludeLabels: [],
    autoAcceptanceExcludeLabels: [],
  },

  // Optional: build context for parent QA/acceptance coordination
  buildParentQAContext: (identifier, subIssues) => string,
  buildParentAcceptanceContext: (identifier, subIssues) => string,

  // Optional: governor integration mode
  // 'direct' (default) — webhooks dispatch work directly
  // 'event-bridge' — dual-write: dispatch AND publish governor events
  // 'governor-only' — only publish events, governor handles all dispatch
  governorMode: 'event-bridge',

  // Optional: OAuth configuration
  oauth: {
    clientId: process.env.LINEAR_CLIENT_ID,
    clientSecret: process.env.LINEAR_CLIENT_SECRET,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    successRedirect: '/?oauth=success',
  },

  // Optional: webhook secret (defaults to LINEAR_WEBHOOK_SECRET env)
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
})
```

### AllRoutes Structure

The returned `routes` object maps directly to Next.js App Router:

```
routes.webhook.POST          → /webhook (POST)
routes.webhook.GET           → /webhook (GET — health check)
routes.oauth.callback.GET    → /callback (GET)

routes.workers.register.POST → /api/workers/register
routes.workers.list.GET      → /api/workers
routes.workers.detail.GET    → /api/workers/[id]
routes.workers.detail.DELETE → /api/workers/[id]
routes.workers.heartbeat.POST → /api/workers/[id]/heartbeat
routes.workers.poll.GET      → /api/workers/[id]/poll

routes.sessions.list.GET     → /api/sessions
routes.sessions.detail.GET   → /api/sessions/[id]
routes.sessions.claim.POST   → /api/sessions/[id]/claim
routes.sessions.status.*     → /api/sessions/[id]/status
routes.sessions.lockRefresh.POST    → /api/sessions/[id]/lock-refresh
routes.sessions.prompts.*    → /api/sessions/[id]/prompts
routes.sessions.transferOwnership.POST → /api/sessions/[id]/transfer-ownership
routes.sessions.activity.POST → /api/sessions/[id]/activity
routes.sessions.completion.POST → /api/sessions/[id]/completion
routes.sessions.externalUrls.POST → /api/sessions/[id]/external-urls
routes.sessions.progress.POST → /api/sessions/[id]/progress
routes.sessions.toolError.POST → /api/sessions/[id]/tool-error

routes.public.stats.GET      → /api/public/stats
routes.public.sessions.GET   → /api/public/sessions
routes.public.sessionDetail.GET → /api/public/sessions/[id]

routes.cleanup.POST          → /api/cleanup
routes.cleanup.GET           → /api/cleanup
```

## Middleware Configuration

### `createAgentFactoryMiddleware(config?)`

```typescript
import { createAgentFactoryMiddleware } from '@donmai/nextjs'

const { middleware } = createAgentFactoryMiddleware({
  // Optional: customize route classification
  routes: {
    public: ['/api/public/', '/dashboard', '/'],
    protected: ['/api/sessions', '/api/workers'],
    webhook: '/webhook',
  },
  // Optional: customize rate limits
  rateLimits: {
    public: { max: 60, windowMs: 60_000 },
    webhook: { max: 10, windowMs: 1_000 },
  },
})
```

## Linear Client Resolver

### `createDefaultLinearClientResolver(config?)`

Resolves a Linear API client from environment variables, with workspace OAuth token fallback:

```typescript
import { createDefaultLinearClientResolver } from '@donmai/nextjs'

// Uses LINEAR_ACCESS_TOKEN env by default
const resolver = createDefaultLinearClientResolver()

// Custom env var name
const resolver = createDefaultLinearClientResolver({
  apiKeyEnvVar: 'MY_LINEAR_API_KEY',
})
```

The resolver implements the `LinearClientResolver` interface:

```typescript
interface LinearClientResolver {
  getClient(organizationId?: string): Promise<LinearAgentClient> | LinearAgentClient
}
```

When an `organizationId` is provided, it checks Redis for a stored OAuth token (from the OAuth callback flow). Otherwise falls back to the API key from the environment variable.

## Orchestrator Configuration

### `createOrchestrator(config)`

```typescript
import { createOrchestrator } from '@donmai/core'

const orchestrator = createOrchestrator({
  provider: myProvider,              // Agent provider instance
  maxConcurrent: 3,                  // Max concurrent agents
  project: 'MyProject',             // Project name filter
  // worktreePath defaults to '../{repoName}.wt/' (sibling directory)
  // worktreePath: '../myrepo.wt/',  // Git worktree base path
  linearApiKey: 'lin_api_...',      // Linear API key
  autoTransition: true,             // Auto-update issue status
  sandboxEnabled: false,            // Enable agent sandboxing
  inactivityTimeoutMs: 300_000,     // 5 minutes
  maxSessionTimeoutMs: 7_200_000,   // 2 hour hard cap
  workTypeTimeouts: {
    qa: { inactivityTimeoutMs: 600_000 },
    development: { inactivityTimeoutMs: 300_000 },
  },
})
```

## Worktree Directory Configuration

### Default layout

By default, worktrees are created in a **sibling directory** next to the repository:

```
my-project/               # your repo
my-project.wt/            # worktree root (sibling)
  SUP-123/                # one worktree per branch
  SUP-456/
```

This replaces the previous `.worktrees/` (in-repo) default, which caused VSCode and Cursor to crash due to filesystem watcher storms on large fleets.

### `worktree.directory` config key

Override the default in `.donmai/config.yaml`:

```yaml
apiVersion: v1
kind: RepositoryConfig
repository: github.com/yourorg/yourrepo
worktree:
  directory: "../{repoName}.wt/"   # default — sibling directory
```

Template variables:

| Variable | Description |
|----------|-------------|
| `{repoName}` | Name of the repository directory (e.g., `agentfactory`) |
| `{branch}` | Branch name for the worktree (e.g., `SUP-123`) |

Examples:

```yaml
# Sibling directory (default)
worktree:
  directory: "../{repoName}.wt/"

# Custom absolute path
worktree:
  directory: "/tmp/worktrees/{repoName}/"

# Legacy in-repo layout (not recommended)
worktree:
  directory: ".worktrees/"
```

### Migrating from `.worktrees/`

If you have existing worktrees under `.worktrees/`, run the migration command:

```bash
pnpm af-migrate-worktrees
```

This moves active worktrees to the new sibling directory and updates git worktree references.

### Worktrunk compatibility

[Worktrunk](https://github.com/nicholasgasior/worktrunk) (`wt`, MIT, Rust, v0.31+) uses the same `../{repoName}.wt/` sibling directory pattern by default. The two tools complement each other:

- **`wt`** -- manual worktree management (create, list, switch, clean up)
- **Donmai** -- automated worktree management for orchestrated agent fleets

They work side by side in the same directory without conflict. `wt` is recommended as a companion tool for manual worktree operations when developing alongside an agent fleet.

## CLI Runner Functions

All CLI tools are available as programmatic functions via subpath exports:

```typescript
import { runOrchestrator } from '@donmai/cli/orchestrator'
import { runWorker } from '@donmai/cli/worker'
import { runWorkerFleet } from '@donmai/cli/worker-fleet'
import { runCleanup } from '@donmai/cli/cleanup'
import { runQueueAdmin } from '@donmai/cli/queue-admin'
import { runLogAnalyzer } from '@donmai/cli/analyze-logs'
import { runLinear, parseLinearArgs } from '@donmai/cli/linear'
```

These functions accept config objects and return Promises — use them to build thin CLI wrappers with your own env loading strategy.

### `runLinear(config)`

Executes Linear CLI commands programmatically:

```typescript
import { runLinear } from '@donmai/cli/linear'

const result = await runLinear({
  command: 'get-issue',
  args: {},
  positionalArgs: ['PROJ-123'],
  apiKey: process.env.LINEAR_API_KEY,
})

console.log(result.output) // { id, identifier, title, ... }
```

The `LinearRunnerConfig` interface:

```typescript
interface LinearRunnerConfig {
  command: string                                    // Command name (e.g., 'get-issue')
  args: Record<string, string | string[] | boolean>  // Named arguments
  positionalArgs: string[]                           // Positional arguments
  apiKey?: string                                    // LINEAR_API_KEY
}
```
