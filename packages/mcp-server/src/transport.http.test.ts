import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
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

  async function start(maxBodyBytes?: number): Promise<void> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0, host: '127.0.0.1', maxBodyBytes })
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

  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'regression-test', version: '0.0.0' },
    },
  })

  it('serves a legitimate small JSON-RPC initialize with 200 when no key is configured', async () => {
    await start()
    const res = await post(initialize)
    expect(res.status).toBe(200)
  })

  it('serves a legitimate authenticated initialize with 200 when a key is configured', async () => {
    process.env.MCP_API_KEY = 'test-key-for-regression'
    await start()
    const res = await post(initialize, { authorization: 'Bearer test-key-for-regression' })
    expect(res.status).toBe(200)
  })

  it('refuses a Content-Length over the configured limit with 413 before any body is sent', async () => {
    await start(1024)
    const { port } = httpServer.address() as AddressInfo
    // Limit is 1 KiB; declare 100 KiB (well under the SDK's own default cap, so only
    // this server's configured bound can refuse it). Send headers only, never the body.
    // The server must answer 413 immediately instead of waiting to read it.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': String(100 * 1024),
          },
        },
        (r) => {
          r.resume()
          resolve(r.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.flushHeaders()
      setTimeout(() => {
        req.destroy()
        reject(new Error('server did not respond before body was sent'))
      }, 2000).unref()
    })
    expect(status).toBe(413)
  })

  // Send a body with Transfer-Encoding: chunked and no Content-Length.
  const postChunked = (body: string, chunkSize = 256) =>
    new Promise<number>((resolve, reject) => {
      const { port } = httpServer.address() as AddressInfo
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'transfer-encoding': 'chunked',
          },
        },
        (r) => {
          r.resume()
          resolve(r.statusCode ?? 0)
        },
      )
      // The server may cut the connection after a 413 while we are still writing.
      req.on('error', () => resolve(0))
      for (let i = 0; i < body.length; i += chunkSize) req.write(body.slice(i, i + chunkSize))
      req.end()
    })

  it('refuses a chunked body (no Content-Length) over the configured limit with 413', async () => {
    await start(1024)
    const status = await postChunked('a'.repeat(2048))
    expect(status).toBe(413)
  })

  it('serves a legitimate ~500 byte chunked JSON-RPC request with 200', async () => {
    await start(1024)
    const padded = JSON.stringify({
      ...JSON.parse(initialize),
      params: { ...JSON.parse(initialize).params, _meta: { pad: 'x'.repeat(250) } },
    })
    expect(padded.length).toBeGreaterThan(400)
    expect(padded.length).toBeLessThan(1024)
    const status = await postChunked(padded, 100)
    expect(status).toBe(200)
  })
})
