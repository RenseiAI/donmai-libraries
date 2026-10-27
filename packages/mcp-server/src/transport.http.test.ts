import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createFleetMcpServer } from './server.js'
import { startHttpTransport } from './transport.js'

// Regression tests for the MCP HTTP transport: the unauthenticated request path
// must reject or bound large bodies rather than buffering and processing them.

const ENV_KEYS = ['MCP_API_KEY', 'WORKER_API_KEY'] as const
const OVERSIZED_BYTES = 64 * 1024 * 1024

describe('MCP HTTP transport (security regression)', () => {
  const saved: Record<string, string | undefined> = {}
  let httpServer: http.Server
  let baseUrl: string

  async function start(): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0, host: '127.0.0.1' })
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
    httpServer?.closeAllConnections?.()
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.restoreAllMocks()
  })

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    }).then(
      (r) => ({ status: r.status, error: undefined as unknown }),
      (error: unknown) => ({ status: 0, error }),
    )

  it('refuses an oversized unauthenticated body instead of processing it', async () => {
    await start()
    // Valid-looking JSON-RPC envelope padded far past any sane request size.
    const padding = 'a'.repeat(OVERSIZED_BYTES)
    const res = await post(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { padding } }),
    )
    // Refused with 413 (or the connection is cut once the limit is hit), never processed.
    expect(res.status === 413 || res.status === 0).toBe(true)
    // The server must still be alive and serving afterwards.
    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
  })

  it('rejects an unauthenticated request with 401 when an API key is configured', async () => {
    process.env.MCP_API_KEY = 'test-key-for-regression'
    await start()
    const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(res.status).toBe(401)
  })

  it('rejects an oversized unauthenticated request with 401 before reading the body when a key is configured', async () => {
    process.env.MCP_API_KEY = 'test-key-for-regression'
    await start()
    const res = await post('a'.repeat(OVERSIZED_BYTES))
    expect(res.status === 401 || res.status === 0).toBe(true)
    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
  })

  it('rejects a request with a wrong API key', async () => {
    process.env.MCP_API_KEY = 'test-key-for-regression'
    await start()
    const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
      authorization: 'Bearer wrong-key',
    })
    expect(res.status).toBe(401)
  })
})
