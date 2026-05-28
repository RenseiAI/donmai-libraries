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
| `--host <address>` | Bind HTTP server to a specific address |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection URL (e.g., `redis://localhost:6379`) |
| `MCP_AUTH_SECRET` | No | API key for MCP authentication |

## Related Packages

| Package | Description |
|---------|-------------|
| [@donmai/core](https://www.npmjs.com/package/@donmai/core) | Core orchestrator |
| [@donmai/server](https://www.npmjs.com/package/@donmai/server) | Redis-backed work queue and session storage |
| [@donmai/cli](https://www.npmjs.com/package/@donmai/cli) | CLI tools (worker, orchestrator) |
| [@donmai/nextjs](https://www.npmjs.com/package/@donmai/nextjs) | Next.js webhook server |

## License

MIT
