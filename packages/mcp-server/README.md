# @donmai/mcp-server

MCP server that exposes [Donmai](https://github.com/RenseiAI/donmai-libraries) fleet management capabilities to any MCP-aware client (Claude Desktop, Cursor, etc.).

## Installation

```bash
npm install @donmai/mcp-server
```

Requires a running Redis instance and the `@donmai/server` package for session storage.

## Tools

| Tool | Description |
|------|-------------|
| `submit-task` | Submit a development task to the fleet work queue |
| `get-task-status` | Get current status of a task by session or issue ID |
| `list-fleet` | List agents and their statuses with optional filtering |
| `get-cost-report` | Get cost/token usage for a task or the entire fleet |
| `forward-prompt` | Forward a follow-up prompt to a running agent session |
| `stop-agent` | Request to stop a running agent |

Real-time fleet resources are also available via MCP resource subscriptions with notification polling.

## Usage

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentfactory": {
      "command": "npx",
      "args": ["@donmai/mcp-server", "--stdio"]
    }
  }
}
```

### HTTP

Start the server on a specific port for remote access:

```bash
af-mcp-server --port 3100
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--stdio` | Use STDIO transport (for IDE integration) |
| `--port <number>` | Start HTTP transport on the given port |
| `--host <address>` | Bind HTTP server to a specific address. Defaults to `127.0.0.1` when no API key is configured, `0.0.0.0` when one is |
| `--allow-unauthenticated-remote` | Allow a non-loopback `--host` without an API key (not recommended) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection URL (e.g., `redis://localhost:6379`) |
| `MCP_API_KEY` | No | API key for MCP authentication (`WORKER_API_KEY` is also accepted). Required to bind a non-loopback host |
| `MCP_HOST` | No | Bind address for HTTP mode (same default as `--host`) |
| `MCP_ALLOW_UNAUTHENTICATED_REMOTE` | No | Set to `1` to allow a non-loopback host without an API key. Logs a warning; anyone who can reach the port can call every tool |

### Network exposure

Without an API key the HTTP server listens on loopback (`127.0.0.1`) only, and
starting it on any non-loopback host fails with an error unless
`MCP_ALLOW_UNAUTHENTICATED_REMOTE=1` is set. Set `MCP_API_KEY` to serve remote clients.

## Related Packages

| Package | Description |
|---------|-------------|
| [@donmai/core](https://www.npmjs.com/package/@donmai/core) | Core orchestrator |
| [@donmai/server](https://www.npmjs.com/package/@donmai/server) | Redis-backed work queue and session storage |
| [@donmai/cli](https://www.npmjs.com/package/@donmai/cli) | CLI tools (worker, orchestrator) |
| [@donmai/nextjs](https://www.npmjs.com/package/@donmai/nextjs) | Next.js webhook server |

## License

MIT
