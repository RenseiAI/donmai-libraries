# MCP Server

The `@donmai/mcp-server` package exposes Donmai fleet capabilities as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server. Any MCP-aware client can interact with the fleet — submit tasks, check status, view costs, and control agents.

## Quick Start

### Streamable HTTP (default)

```bash
# Start the MCP server on port 3100
npx af-mcp-server

# Custom port and host
npx af-mcp-server --port 8080 --host 127.0.0.1
```

The server exposes two endpoints:
- **`/mcp`** — MCP protocol endpoint (Streamable HTTP transport)
- **`/health`** — Health check endpoint

### STDIO Mode

For local CLI integration (e.g., Claude Desktop):

```bash
npx af-mcp-server --stdio
```

In STDIO mode, the server reads MCP messages from stdin and writes responses to stdout.

## Transport Modes

| Mode | Flag | Protocol | Use Case |
|------|------|----------|----------|
| **Streamable HTTP** | (default) | HTTP POST to `/mcp` | Remote access, web clients, Spring AI |
| **STDIO** | `--stdio` | stdin/stdout | Local CLI, Claude Desktop, IDE agents |

### Streamable HTTP

The default mode runs an HTTP server with the MCP Streamable HTTP transport:

```
Client ──HTTP POST──► http://host:port/mcp ──► MCP Server ──► Fleet
```

Environment variables:
- `MCP_PORT` — Server port (default: `3100`)
- `MCP_HOST` — Server bind address (default: `0.0.0.0`)

### STDIO

STDIO mode uses stdin/stdout for communication, suitable for local process integration:

```
Client ──stdin──► MCP Server ──stdout──► Client
```

## Authentication

Authentication is optional in development and required in production.

### API Key Authentication

Set one of these environment variables to enable auth:

| Variable | Description |
|----------|-------------|
| `MCP_API_KEY` | MCP-specific API key (checked first) |
| `WORKER_API_KEY` | Shared worker API key (fallback) |

When configured, clients must include the key in the `Authorization` header:

```
Authorization: Bearer your-api-key
```

If neither variable is set, all requests are allowed (development mode).

### Health Check

The `/health` endpoint is always accessible (no auth required):

```bash
curl http://localhost:3100/health
# {"status":"ok","server":"agentfactory-fleet","auth":true}
```

## Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `submit-task` | `issueId`, `description`, `workType`, `priority` | Submit a new task to the fleet work queue |
| `get-task-status` | task ID or issue ID | Check the status of a running task |
| `list-fleet` | optional: `status`, `workType` | List active agents and their assignments |
| `get-cost-report` | — | Retrieve aggregated cost/token data across the fleet |
| `stop-agent` | `sessionId` | Request a running agent to stop |
| `forward-prompt` | `sessionId`, `prompt` | Inject a follow-up message into a running agent session |

### Work Types for `submit-task`

`research`, `backlog-creation`, `development`, `inflight`, `inflight-coordination`, `qa`, `acceptance`, `refinement`, `refinement-coordination`, `coordination`, `qa-coordination`, `acceptance-coordination`, `merge`, `security`

### Session Statuses for `get-task-status`

`pending`, `claimed`, `running`, `finalizing`, `completed`, `failed`, `stopped`

## Resources

| URI | Description |
|-----|-------------|
| `fleet://agents` | Current fleet state — all active agents with assignments |
| `fleet://issues/{id}` | Issue progress details — status, agent, cost, PR URL |
| `fleet://logs/{id}` | Agent execution logs — streaming event log |

## Client Setup

### Claude Desktop

Add to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agentfactory": {
      "command": "npx",
      "args": ["af-mcp-server", "--stdio"]
    }
  }
}
```

Or for remote HTTP access:

```json
{
  "mcpServers": {
    "agentfactory": {
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### Spring AI Client

Connect a Spring AI application to the Donmai fleet:

```java
@Configuration
public class McpConfig {
    @Bean
    public McpClient agentFactoryClient() {
        return McpClient.builder()
            .transport(new HttpMcpTransport("http://localhost:3100/mcp"))
            .header("Authorization", "Bearer " + apiKey)
            .build();
    }
}
```

### Programmatic (Node.js)

```typescript
import { createFleetMcpServer } from '@donmai/mcp-server'
import { startHttpTransport, startStdioTransport } from '@donmai/mcp-server'

const server = createFleetMcpServer()

// HTTP mode
await startHttpTransport(server, { port: 3100, host: '0.0.0.0' })

// Or STDIO mode
await startStdioTransport(server)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PORT` | `3100` | HTTP server port |
| `MCP_HOST` | `0.0.0.0` | HTTP server bind address |
| `MCP_API_KEY` | — | MCP-specific authentication key |
| `WORKER_API_KEY` | — | Shared worker authentication key (fallback) |
| `REDIS_URL` | — | Redis connection URL (required for fleet operations) |
| `LINEAR_API_KEY` | — | Linear API key (required for issue operations) |
