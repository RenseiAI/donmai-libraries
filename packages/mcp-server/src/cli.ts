#!/usr/bin/env node

import { createFleetMcpServer } from './server.js'
import { startStdioTransport, startHttpTransport } from './transport.js'
import { stopResourceNotificationPoller } from './resources.js'

const args = process.argv.slice(2)
const transportType = args.includes('--stdio') ? 'stdio' : 'http'

const server = createFleetMcpServer()

if (transportType === 'stdio') {
  console.error('[mcp-server] Starting in STDIO mode')
  await startStdioTransport(server)

  // Graceful shutdown for STDIO mode
  const shutdown = () => {
    console.error('[mcp-server] Shutting down...')
    stopResourceNotificationPoller()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} else {
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : undefined
  const hostIdx = args.indexOf('--host')
  const host = hostIdx !== -1 ? args[hostIdx + 1] : undefined

  const httpServer = await startHttpTransport(server, {
    port,
    host,
    allowUnauthenticatedRemote: args.includes('--allow-unauthenticated-remote') ? true : undefined,
  })

  // Graceful shutdown for HTTP mode — close server before exiting
  const shutdown = () => {
    console.log('[mcp-server] Shutting down...')
    stopResourceNotificationPoller()
    httpServer.close(() => {
      process.exit(0)
    })
    // Force exit after 5s if connections don't drain
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
