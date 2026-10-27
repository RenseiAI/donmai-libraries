import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import http from 'node:http'
import { verifyMcpAuth, isMcpAuthConfigured } from './auth.js'

export interface HttpTransportOptions {
  port?: number
  host?: string
  /**
   * Allow binding a non-loopback host without an API key. Off by default; also
   * enabled by MCP_ALLOW_UNAUTHENTICATED_REMOTE=1. Anyone who can reach the
   * port can then call every MCP tool.
   */
  allowUnauthenticatedRemote?: boolean
}

const LOOPBACK_HOST = '127.0.0.1'

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h === LOOPBACK_HOST || /^127\.\d+\.\d+\.\d+$/.test(h)
}

export async function startStdioTransport(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

export async function startHttpTransport(
  server: McpServer,
  options: HttpTransportOptions = {}
): Promise<http.Server> {
  const port = options.port ?? parseInt(process.env.MCP_PORT ?? '3100', 10)
  const authConfigured = isMcpAuthConfigured()
  // Without an API key the server is loopback-only by default.
  const host = options.host ?? process.env.MCP_HOST ?? (authConfigured ? '0.0.0.0' : LOOPBACK_HOST)
  const allowRemote =
    options.allowUnauthenticatedRemote ?? process.env.MCP_ALLOW_UNAUTHENTICATED_REMOTE === '1'

  if (!authConfigured && !isLoopbackHost(host)) {
    if (!allowRemote) {
      throw new Error(
        `Refusing to listen on non-loopback host "${host}" without an API key. ` +
          'Set MCP_API_KEY (or WORKER_API_KEY), bind to 127.0.0.1, or explicitly opt in with ' +
          'MCP_ALLOW_UNAUTHENTICATED_REMOTE=1 / allowUnauthenticatedRemote.'
      )
    }
    console.warn(
      `[mcp-server] WARNING: listening on ${host} with NO API key (unauthenticated remote access explicitly allowed). ` +
        'Anyone who can reach this port can call every MCP tool.'
    )
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })

  const httpServer = http.createServer(async (req, res) => {
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', server: 'agentfactory-fleet', auth: isMcpAuthConfigured() }))
      return
    }

    // MCP endpoint — verify auth for non-health endpoints
    if (req.url === '/mcp') {
      const authResult = verifyMcpAuth(req.headers.authorization)
      if (!authResult.authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: authResult.error }))
        return
      }

      await transport.handleRequest(req, res)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. Use /mcp for MCP protocol or /health for health check.' }))
  })

  await server.connect(transport)

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      console.log(`[mcp-server] AgentFactory Fleet MCP server listening on http://${host}:${port}`)
      console.log(`[mcp-server] MCP endpoint: http://${host}:${port}/mcp`)
      console.log(`[mcp-server] Health check: http://${host}:${port}/health`)
      console.log(`[mcp-server] Auth: ${isMcpAuthConfigured() ? 'enabled' : 'disabled (dev mode)'}`)
      resolve(httpServer)
    })
  })
}
