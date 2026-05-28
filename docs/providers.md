# Providers

Donmai abstracts coding agents behind a unified `AgentProvider` interface. This allows you to use different agents for different tasks and swap providers without changing orchestration logic.

## Supported Providers

| Provider | Status | Agent |
|----------|--------|-------|
| `claude` | Production | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via `@anthropic-ai/claude-agent-sdk` |
| `codex` | Experimental | [OpenAI Codex](https://platform.openai.com/) -- two modes: **App Server** (long-lived JSON-RPC 2.0 process, concurrent threads, message injection) and **Exec fallback** (one CLI process per session, JSONL events). See [`docs/codex-guide.md`](codex-guide.md) for Codex-specific setup. |
| `amp` | Experimental | [Amp](https://amp.dev/) |
| `spring-ai` | Experimental | [Spring AI](https://spring.io/projects/spring-ai) agents via HTTP (JSONL events, JAR process) |
| `a2a` | Experimental | Any [A2A protocol](https://a2a-protocol.org) compatible agent (JSON-RPC 2.0, SSE streaming) |

### Spring AI Provider Setup

The Spring AI provider spawns a Spring AI agent as a JAR child process:

```bash
# Required
SPRING_AI_JAR=/path/to/spring-ai-agent.jar    # Path to the Spring AI agent JAR

# Optional
SPRING_AI_JAVA_HOME=/usr/lib/jvm/java-21       # Java home (default: system Java)
```

**How it works:**
- **New session:** `java -jar <JAR> --prompt "<prompt>" --cwd <cwd> --json`
- **Resume:** `java -jar <JAR> --resume <sessionId> --prompt "<prompt>" --cwd <cwd> --json`

The JAR emits JSONL events on stdout:

| JSONL Event | Maps To |
|-------------|---------|
| `session.started` | `init` (sessionId) |
| `assistant.message` | `assistant_text` |
| `tool.invocation` | `tool_use` |
| `tool.result` | `tool_result` |
| `turn.completed` | `result` (success, usage) |
| `turn.failed` | `result` (failure) |
| `error` | `error` |

**Limitations:** No message injection support. No session resume (sessions are stateless).

### A2A Provider Setup

The A2A provider invokes external agents over HTTP using the [A2A protocol](https://a2a-protocol.org) (v0.3.0):

```bash
# Required
A2A_AGENT_URL=https://agent.example.com       # Base URL of the A2A agent

# Optional — per-work-type URL override
A2A_AGENT_URL_RESEARCH=https://research-agent.example.com

# Authentication (choose one)
A2A_API_KEY=your-api-key                       # Sent as x-api-key header
A2A_BEARER_TOKEN=your-bearer-token             # Sent as Authorization: Bearer header
```

**Protocol details:**
- **Discovery:** `GET /.well-known/agent-card.json`
- **Task creation:** `POST /a2a` with JSON-RPC 2.0 (`message/send` or `message/stream`)
- **Task lifecycle:** submitted → working → completed/failed/canceled
- **Streaming:** SSE events (`TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`)
- **Input required:** A paused state that requests user input (mapped to `injectMessage`)

**Limitations:** Session resume depends on the remote agent's capabilities.

## Provider Interface

Every provider implements:

```typescript
interface AgentProvider {
  readonly name: 'claude' | 'codex' | 'amp' | 'spring-ai' | 'a2a'

  /** Spawn a new agent session */
  spawn(config: AgentSpawnConfig): AgentHandle

  /** Resume a previously interrupted session */
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle
}
```

And returns an `AgentHandle`:

```typescript
interface AgentHandle {
  /** Session ID for crash recovery / resume */
  sessionId: string | null

  /** Async stream of normalized events */
  stream: AsyncIterable<AgentEvent>

  /** Inject a follow-up message into the running session */
  injectMessage(text: string): Promise<void>

  /** Stop the agent */
  stop(): Promise<void>
}
```

## Configuration

### Global Default

```bash
export AGENT_PROVIDER=claude
```

### Per-Work-Type Override

Use different providers for different work phases:

```bash
export AGENT_PROVIDER=claude          # Default for development
export AGENT_PROVIDER_QA=codex        # Use Codex for QA
export AGENT_PROVIDER_ACCEPTANCE=amp  # Use Amp for acceptance
```

### Per-Project Override

Use different providers for different projects:

```bash
export AGENT_PROVIDER_FRONTEND=claude
export AGENT_PROVIDER_BACKEND=codex
```

### Resolution Order

Provider is resolved per agent using a 10-tier cascade (highest to lowest priority):

| Tier | Source | Example |
|------|--------|---------|
| 1 | Issue label | `provider:codex` label on the Linear issue |
| 2 | Mention context | "use codex", "@codex", or "provider:codex" in prompt text |
| 3 | Config `providers.byWorkType` | `providers: { byWorkType: { qa: codex } }` in config.yaml |
| 4 | Config `providers.byProject` | `providers: { byProject: { Social: amp } }` in config.yaml |
| 5 | MAB routing | Thompson Sampling learned routing (when `routing.enabled: true`) |
| 6 | Env `AGENT_PROVIDER_{WORKTYPE}` | `AGENT_PROVIDER_QA=codex` |
| 7 | Env `AGENT_PROVIDER_{PROJECT}` | `AGENT_PROVIDER_SOCIAL=amp` |
| 8 | Config `providers.default` | `providers: { default: codex }` in config.yaml |
| 9 | Env `AGENT_PROVIDER` | `AGENT_PROVIDER=claude` |
| 10 | Hardcoded | `claude` |

Tiers 1-2 are explicit human overrides. Tiers 3-4 are static config. Tier 5 is learned routing (feature-flagged). Tiers 6-10 are fallbacks. Without MAB routing enabled, tier 5 is skipped (9 tiers total).

**Provider aliases** are supported: `opus` and `sonnet` resolve to `claude`, `gemini` resolves to `a2a`.

### Label-Based Selection

Add a `provider:<name>` label to a Linear issue to override the provider for that specific issue:

```
Labels: provider:codex
```

This is the highest-priority override — it beats all config and environment settings.

### Mention-Based Selection

Include a provider reference in the agent prompt or mention context:

```
"Use codex for this task"
"@codex implement this feature"
"provider:spring-ai"
```

Matching is case-insensitive and word-boundary aware.

### Config-File Selection

Set provider routing in `.donmai/config.yaml`:

```yaml
providers:
  default: claude
  byWorkType:
    qa: codex
    acceptance: amp
  byProject:
    Backend: codex
    Social: spring-ai
```

### MAB Intelligent Routing

When `routing.enabled: true` in config, Thompson Sampling selects the optimal provider based on historical performance. See [Configuration](./configuration.md#routing--mab-intelligent-routing) for parameter details.

### Programmatic Selection

```typescript
import { createProvider, resolveProviderName } from '@donmai/core'

// Create a specific provider
const claude = createProvider('claude')

// Resolve based on context
const name = resolveProviderName({
  project: 'Social',
  workType: 'qa',
})
const provider = createProvider(name)

// Pass to orchestrator
const orchestrator = createOrchestrator({
  provider: claude,
})
```

## Event Normalization

All providers emit the same `AgentEvent` types regardless of the underlying SDK:

| Event Type | Description | Key Fields |
|------------|-------------|------------|
| `init` | Session started | `sessionId` |
| `system` | Status change, compaction | `subtype`, `message` |
| `assistant_text` | Agent text output | `text` |
| `tool_use` | Tool invocation started | `toolName`, `input` |
| `tool_result` | Tool execution completed | `content`, `isError` |
| `tool_progress` | Long tool in progress | `toolName`, `elapsedSeconds` |
| `result` | Agent finished | `success`, `cost`, `message` |
| `error` | Error occurred | `message`, `code` |

Every event also carries a `raw` field with the provider's original event data.

## Cost Tracking

The `result` event includes cost data when available:

```typescript
interface AgentCostData {
  inputTokens?: number
  outputTokens?: number
  totalCostUsd?: number
  numTurns?: number
}
```

Cost is accumulated on the `AgentProcess` object and can be used for budgeting:

```typescript
orchestrator.events.onAgentComplete = (agent) => {
  console.log(`${agent.identifier}: $${agent.totalCostUsd?.toFixed(4)}`)
  console.log(`  Input:  ${agent.inputTokens} tokens`)
  console.log(`  Output: ${agent.outputTokens} tokens`)
}
```

## Tool Plugins (Claude Provider)

When using the Claude provider, agents receive **typed, in-process tools** instead of shelling out to CLI commands via Bash. This is powered by the `ToolPlugin` system and the Claude Agent SDK's `createSdkMcpServer()`.

### Why MCP?

Claude Code has a fixed set of built-in tools (Read, Write, Bash, etc.). The **only extension mechanism** for adding custom tools is MCP (Model Context Protocol) servers — when you pass `mcpServers` to `query()`, the SDK discovers each server's tools and adds them to the model's tool palette.

However, standard MCP transports (stdio, SSE, HTTP) all run in separate processes, which would negate the performance benefit. `createSdkMcpServer()` is special: it creates an MCP server **in the same process**. Despite the MCP naming, there's no IPC, no child process, no network call. The SDK calls your handler function directly. It's essentially a way to say "here are additional tools with Zod schemas — add them to the agent's tool list."

### How It Works

```
query({ mcpServers: { 'af-linear': createSdkMcpServer({ tools: [...] }) } })
    │
    ├─ SDK discovers tools via MCP protocol (in-process, no IPC)
    ├─ Model sees: Read, Write, Bash, ..., af_linear_get_issue, af_linear_create_issue, ...
    ├─ Model calls af_linear_get_issue({ issue_id: "SUP-123" })
    ├─ SDK routes to handler (same process)
    └─ Handler calls runLinear() directly → returns JSON result
```

### Benefits Over CLI

| | CLI (`pnpm af-linear`) | Tool Plugin (`af_linear_*`) |
|---|---|---|
| **Overhead** | Subprocess per call | In-process function call |
| **Input validation** | Runtime arg parsing | Zod schema at invocation |
| **Prompt tokens** | Full CLI docs in prompt | Tool schemas self-document |
| **Error handling** | Parse stderr | Structured `{ isError: true }` |
| **Type safety** | String args | Typed params |

### Provider Compatibility

Tool plugins only activate for the Claude provider. Non-Claude providers (Codex, Amp) continue using the Bash-based CLI -- their prompts receive the `{{linearCli}}` CLI instructions as before. This is controlled by the `useToolPlugins` template variable.

**Codex** does not support in-process MCP servers. However, Codex agents can invoke MCP tools via the Codex CLI's own MCP server configuration. Donmai passively observes these calls and maps them to normalized `tool_use` / `tool_result` events (item type `mcpToolCall` in App Server mode, `mcp_tool_call` in Exec mode). See [`docs/codex-guide.md`](codex-guide.md) for details on Codex capabilities and limitations.

### Available Plugins

| Plugin | Server Name | Tools | Description |
|--------|-------------|-------|-------------|
| `linearPlugin` | `af-linear` | 16 | Linear issue management (get, create, update, comments, relations, etc.) |

### Registering Plugins

The orchestrator automatically registers built-in plugins. To add custom plugins programmatically:

```typescript
import { ToolRegistry, linearPlugin } from '@donmai/core'
import type { ToolPlugin } from '@donmai/core'

const myPlugin: ToolPlugin = {
  name: 'my-tools',
  description: 'Custom tools for my workflow',
  createTools: (context) => [
    tool('my_custom_action', 'Do something', { param: z.string() },
      async (args) => ({ content: [{ type: 'text', text: 'result' }] })
    ),
  ],
}

const registry = new ToolRegistry()
registry.register(linearPlugin)
registry.register(myPlugin)

// Pass servers to AgentSpawnConfig
const servers = registry.createServers({ env: process.env, cwd: process.cwd() })
```

## Writing a Custom Provider

To add support for a new coding agent:

1. Create a class implementing `AgentProvider`
2. Map native events to `AgentEvent` types in the `spawn()` method
3. Return an `AgentHandle` with the async iterable stream

```typescript
import type { AgentProvider, AgentSpawnConfig, AgentHandle, AgentEvent } from '@donmai/core'

class MyProvider implements AgentProvider {
  readonly name = 'my-agent' as any // Extend AgentProviderName first

  spawn(config: AgentSpawnConfig): AgentHandle {
    // 1. Start your agent process
    // 2. Create an async generator that yields AgentEvents
    // 3. Return an AgentHandle

    return {
      sessionId: null,
      stream: this.createStream(config),
      injectMessage: async (text) => { /* send follow-up */ },
      stop: async () => { /* kill the process */ },
    }
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    // Resume from previous session
    return this.spawn({ ...config, /* add resume context */ })
  }

  private async *createStream(config: AgentSpawnConfig): AsyncIterable<AgentEvent> {
    // Yield normalized events
    yield { type: 'init', sessionId: 'my-session-id', raw: {} }

    // ... process your agent's output ...

    yield {
      type: 'result',
      success: true,
      message: 'Done',
      cost: { inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.01 },
      raw: {},
    }
  }
}
```

Then register it:

```typescript
const orchestrator = createOrchestrator({
  provider: new MyProvider(),
})
```
