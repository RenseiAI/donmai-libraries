# Codex Integration Guide

This guide covers setup, configuration, and operation of the OpenAI Codex agent provider within AgentFactory. Codex supports two execution modes: a long-lived **App Server** (recommended) and a simpler **Exec fallback**.

---

## 1. Prerequisites & Setup

### Codex CLI Installation

Install the `codex` CLI binary. Ensure the installed version supports both `codex exec` and `codex app-server` subcommands.

```bash
# Install via npm (check OpenAI docs for current instructions)
npm install -g @openai/codex
```

Verify the installation:

```bash
codex --version
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CODEX_BIN` | No | `'codex'` (on PATH) | Absolute path to the `codex` binary. Resolved in order: `config.env.CODEX_BIN` > `process.env.CODEX_BIN` > `'codex'`. See `AppServerProcessManager` constructor and `CodexProvider.createExecHandle()`. |
| `CODEX_USE_APP_SERVER` | No | unset (Exec mode) | Set to `1` or `true` to enable App Server mode. Checked by `isAppServerEnabled()` in `codex-provider.ts`. |
| `OPENAI_API_KEY` | Yes | none | Your OpenAI API key. Codex expects this in the environment for all API calls. |

### Model Selection

Model selection is currently controlled by the Codex CLI / App Server configuration itself. AgentFactory does not pass a model parameter to Codex. This is tracked as a future enhancement in **SUP-1735**.

### Example `.env`

```bash
CODEX_BIN=/usr/local/bin/codex
CODEX_USE_APP_SERVER=1
OPENAI_API_KEY=sk-...
```

---

## 2. Execution Modes

### App Server Mode (`CODEX_USE_APP_SERVER=1`)

The recommended mode for production use. A single long-lived `codex app-server` process communicates with AgentFactory via **JSON-RPC 2.0 over stdio**.

**Architecture:**

```
orchestrator --> codex app-server (long-lived, one process)
                    |-- thread_1 (agent session A)
                    |-- thread_2 (agent session B)
                    +-- thread_3 (agent session C)
```

**Capabilities:**
- Multiple concurrent threads on a single process
- Message injection (mid-turn steering via `turn/steer`, between-turn via `turn/start`)
- Session resume via `thread/resume`
- Streaming notifications (`item/*`, `turn/*`, `thread/*`)
- Sandbox support via `sandboxPolicy` (type: `workspaceWrite`)

**Protocol flow:**
1. `initialize` request + `initialized` notification (handshake)
2. `thread/start` or `thread/resume`
3. `turn/start` with prompt
4. Stream `item/*`, `turn/*`, `thread/*` notifications
5. `thread/unsubscribe` on completion

**Process lifecycle:** The `AppServerProcessManager` spawns the process once and reuses it across all threads. It is created lazily on first use and destroyed via `shutdown()`.

### Exec Fallback Mode (Default)

The backward-compatible mode. Each agent session spawns a new `codex exec` child process that emits a **JSONL event stream** on stdout.

**CLI invocation patterns:**

```bash
# New session
codex exec --json --full-auto -C <cwd> "<prompt>"

# Resume session
codex exec resume --json --full-auto <session_id> "<prompt>"
```

**Capabilities:**
- One process per session
- JSONL event stream parsing (`thread.started`, `turn.started`, `turn.completed`, `item.*`, etc.)
- Session resume via `codex exec resume`
- No message injection (throws an error if attempted)
- No mid-turn steering

**When to use Exec mode:**
- CI/CD pipelines where long-lived processes are undesirable
- Environments where `codex app-server` is unavailable
- Simple single-shot tasks that do not require injection or steering

---

## 3. Provider Resolution

AgentFactory resolves which provider to use per agent spawn using a priority cascade. The Codex provider is selected when the resolution returns `'codex'`.

**Sync resolution order** (from `resolveProviderName()` in `packages/core/src/providers/index.ts`):

| Priority | Source | Example |
|----------|--------|---------|
| 1 | Issue label | `provider:codex` label on the issue |
| 2 | Mention context | `"use codex"`, `"@codex"`, `"provider:codex"` in prompt/mention text |
| 3 | Config `providers.byWorkType` | `{ qa: 'codex' }` in `.donmai/config.yaml` |
| 4 | Config `providers.byProject` | `{ Backend: 'codex' }` in `.donmai/config.yaml` |
| 5 | Env var `AGENT_PROVIDER_{WORKTYPE}` | `AGENT_PROVIDER_QA=codex` |
| 6 | Env var `AGENT_PROVIDER_{PROJECT}` | `AGENT_PROVIDER_BACKEND=codex` |
| 7 | Config `providers.default` | `default: 'codex'` in `.donmai/config.yaml` |
| 8 | Env var `AGENT_PROVIDER` | `AGENT_PROVIDER=codex` |
| 9 | Hardcoded fallback | `'claude'` |

Higher-priority sources always override lower ones. Aliases are supported: `opus` and `sonnet` map to `claude`, `gemini` maps to `a2a`.

**Async resolution** (`resolveProviderNameAsync()`) inserts MAB-based intelligent routing between priorities 4 and 5 (when enabled via `routingConfig.enabled`).

---

## 4. Feature Comparison Matrix

| Capability | Claude | Codex (App Server) | Codex (Exec) |
|---|:---:|:---:|:---:|
| **Message injection** | Yes | Yes | No |
| **Session resume** | Yes | Yes | Yes |
| **Mid-turn steering** | Yes | Yes (`turn/steer`) | No |
| **Between-turn injection** | Yes | Yes (`turn/start` on existing thread) | No |
| **In-process MCP tools** | Yes (`createSdkMcpServer`) | No | No |
| **MCP tool observation** | N/A (uses in-process) | Yes (passive, via `mcpToolCall` events) | Yes (passive, via `mcp_tool_call` events) |
| **Approval bridge** | Managed by SDK | `'onRequest'` (with bridge) or `'unlessTrusted'` | Via `--full-auto` / `--approval-mode` flags |
| **Sandbox** | Yes (SDK-managed) | Yes (`sandboxPolicy: workspaceWrite`) | Yes (`--sandbox workspace-write`) |
| **Concurrent threads** | One process per session | Multiple threads per process | One process per session |
| **Token tracking** | Yes (input + output) | Yes (input + output via `turn.usage`) | Yes (input + output via `turn.completed`) |
| **USD cost calculation** | Yes (`total_cost_usd`) | Yes (estimate via `calculateCostUsd`) | No (tokens only) |
| **Tool plugins** | Yes (in-process MCP servers) | No (uses CLI/Bash fallback) | No (uses CLI/Bash fallback) |

---

## 5. Known Limitations

### 1. No in-process MCP server support

Codex does not support the `createSdkMcpServer()` in-process MCP pattern used by the Claude provider. Tool plugins (e.g., `linearPlugin`) are not injected as MCP servers. Instead, Codex agents receive CLI-based tool instructions via the `{{linearCli}}` template variable.

Codex does *observe* MCP tool calls made by the Codex CLI itself (via its own MCP server configuration) and maps them to normalized `tool_use` / `tool_result` events.

### 2. Model selection via tier mapping

Model selection is supported via `config.model`, `CODEX_MODEL_TIER` (maps `opus`/`sonnet`/`haiku` to Codex equivalents), or `CODEX_MODEL` env var. See `resolveCodexModel()` in `codex-app-server-provider.ts`. Direct model IDs from the Claude provider (e.g., `claude-sonnet-4-5`) are not automatically translated — use tier mapping or explicit Codex model names.

### 3. USD cost calculation is estimate-based

Codex cost is calculated from token counts using a built-in pricing table (`CODEX_PRICING`). Costs are estimates based on known per-model rates, not API-reported values. Unknown models fall back to default (gpt-5-codex) pricing. See `calculateCostUsd()` in `codex-app-server-provider.ts`.

### 4. Instructions passthrough

System instructions are now passed to Codex via the `instructions` field on `thread/start`. Instructions are built from `config.baseInstructions` or loaded from `AGENTS.md`/`CLAUDE.md` in the worktree root. Fine-grained per-tool permissions are not supported — use the approval bridge instead. See `buildBaseInstructions()` in `codex-app-server-provider.ts`.

### 5. Single personality

The App Server provider hardcodes `personality: 'concise'` when calling `thread/resume`. This is not configurable. See `codex-app-server-provider.ts` line 849.

### 6. 60-second notification timeout

The App Server event stream uses a 60-second `setTimeout` as a notification polling interval. If no notifications arrive within 60 seconds (e.g., during a long tool execution), the loop cycles but continues. This is a defensive measure against hanging, not a hard timeout. See `codex-app-server-provider.ts` line 937.

### 7. No process crash recovery

If the `codex app-server` process crashes, all active threads are lost. The `AppServerProcessManager` rejects all pending requests and marks itself as uninitialized, but it does not automatically restart. A new process is created on the next `spawn()` or `resume()` call. Active sessions at the time of the crash receive an error event.

### 8. Approval policy is coarse

The App Server approval policy supports two values:
- `'onRequest'` -- when `config.autonomous` is `true` (all tool executions flow through the approval bridge for safety evaluation; the bridge auto-approves safe commands and declines destructive patterns)
- `'unlessTrusted'` -- when `config.autonomous` is `false`

The Exec mode similarly maps to `--full-auto` (autonomous) or `--approval-mode untrusted` (non-autonomous). Per-tool granularity is handled by the approval bridge in App Server mode, but not available in Exec mode.

See `resolveApprovalPolicy()` in `codex-app-server-provider.ts`.

---

## 6. Migration Guide: `codex exec` to App Server Mode

### Overview

Migrating from Exec fallback mode to App Server mode enables message injection, mid-turn steering, concurrent threads, and more efficient resource usage. The migration is controlled by a single environment variable.

### Step 1: Verify Codex CLI version

Ensure your `codex` binary supports the `app-server` subcommand:

```bash
codex app-server --help
```

If this command is not recognized, update your Codex CLI.

### Step 2: Enable App Server mode

Set the environment variable:

```bash
export CODEX_USE_APP_SERVER=1
```

Or add to your `.env` file:

```bash
CODEX_USE_APP_SERVER=1
```

This is the **only required change**. The `CodexProvider` class automatically delegates to `CodexAppServerProvider` when this variable is set.

### Step 3: Verify operation

Monitor logs for App Server initialization:

```
[CodexAppServer] Process started (PID: ...)
```

Confirm that threads are being created rather than individual processes:

```
Thread thread/started: {"thread":{"id":"..."}}
```

### Breaking Changes

| Behavior | Exec Mode | App Server Mode |
|----------|-----------|-----------------|
| **Process model** | One process per session | Single shared process, multiple threads |
| **Event format** | JSONL (`thread.started`, `turn.completed`) | JSON-RPC 2.0 notifications (`thread/started`, `turn/completed`) |
| **Message injection** | Throws error | Supported (mid-turn and between-turn) |
| **Session resume** | `codex exec resume <id>` | `thread/resume` JSON-RPC call |
| **Process exit = session end** | Yes | No (process is shared) |
| **stderr collection** | Collected for error reporting | Not collected (process shared) |

### Step 4: Update monitoring (if applicable)

If you monitor Codex agent processes by PID count:
- **Exec mode**: One PID per active agent session
- **App Server mode**: One PID total, regardless of active sessions

### Rollback Plan

To revert to Exec mode, unset the environment variable:

```bash
unset CODEX_USE_APP_SERVER
# or
export CODEX_USE_APP_SERVER=0
```

No other changes are required. The `CodexProvider` falls back to Exec mode automatically. Session IDs from App Server threads are not compatible with `codex exec resume` -- active sessions created under App Server mode cannot be resumed in Exec mode (and vice versa).

---

## 7. Troubleshooting

### `Error: App server process is not running`

**Cause:** A JSON-RPC request was made but the `codex app-server` process is not running or was killed.

**Fix:**
- Check that `CODEX_BIN` points to a valid `codex` binary
- Check that `OPENAI_API_KEY` is set
- Look at stderr/logs for crash output from the Codex process
- The process manager will attempt to start a new process on the next `spawn()` call

### `Error: App server stdin is not writable`

**Cause:** The process has crashed or its stdin pipe was closed.

**Fix:** Same as above. The process needs to be restarted. This typically happens after a crash that was not yet detected by the exit handler.

### `Error: JSON-RPC request timed out: <method> (id=<N>)`

**Cause:** The App Server did not respond within the 30-second timeout (`timeoutMs` default in `AppServerProcessManager.request()`).

**Fix:**
- The Codex process may be overloaded or hung
- Check system resources (CPU, memory)
- Consider restarting the App Server via `shutdown()` followed by a new `spawn()`

### `Error: Codex provider does not support mid-session message injection`

**Cause:** `injectMessage()` was called on a Codex Exec mode session. Exec mode does not support injection.

**Fix:**
- Enable App Server mode (`CODEX_USE_APP_SERVER=1`) to use message injection
- Or stop and resume the session with a new prompt instead of injecting

### `Error: No active session for message injection`

**Cause:** `injectMessage()` was called before the thread was started or after it was stopped.

**Fix:** Ensure the agent session is active (has a `sessionId`) before injecting messages. Wait for the `init` event before calling `injectMessage()`.

### `Error: Failed to start thread: no thread ID returned`

**Cause:** The `thread/start` JSON-RPC call succeeded but the response did not contain a thread ID.

**Fix:**
- This indicates a Codex App Server protocol issue
- Check the Codex binary version -- it may not support the expected protocol
- Review the raw JSON-RPC response in the error event

### `Codex process exited with code <N>`

**Cause:** The `codex exec` process exited with a non-zero exit code (Exec mode).

**Common exit codes:**
- `1` -- General error (check stderr for details)
- `2` -- Invalid arguments (check the constructed CLI args)
- `127` -- `codex` binary not found (check `CODEX_BIN` and PATH)

**Fix:** Review the `stderr` field in the `result` event for the actual error message.

### `App server exited: code=<N> signal=<S>`

**Cause:** The long-lived App Server process exited unexpectedly.

**Fix:**
- All active threads are lost when this happens
- The process manager rejects all pending requests
- A new process will be created on the next `spawn()` or `resume()` call
- If this happens frequently, investigate system resources and Codex CLI stability

### `Unhandled App Server notification: <method>`

**Cause:** The App Server sent a notification type that AgentFactory does not recognize.

**Fix:** This is typically harmless -- the event is emitted as a `system` event with subtype `unknown`. If you see this frequently, the Codex protocol may have been updated. Check for AgentFactory updates.

### Agent receives CLI instructions instead of tool plugins

**Cause:** Tool plugins (e.g., `linearPlugin`) are only injected as in-process MCP servers for the Claude provider. Codex agents receive the `{{linearCli}}` template instructions instead.

**This is expected behavior.** See [Known Limitations](#1-no-in-process-mcp-server-support) above.
