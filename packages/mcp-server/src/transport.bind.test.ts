import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createFleetMcpServer } from './server.js'
import { isLoopbackHost, startHttpTransport } from './transport.js'

const ENV_KEYS = ['MCP_API_KEY', 'WORKER_API_KEY', 'MCP_HOST', 'MCP_ALLOW_UNAUTHENTICATED_REMOTE'] as const

describe('MCP HTTP transport bind policy', () => {
  const saved: Record<string, string | undefined> = {}
  let httpServer: http.Server | undefined
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    httpServer = undefined
  })

  afterEach(async () => {
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.restoreAllMocks()
  })

  it('listens on 127.0.0.1 by default when no API key is configured', async () => {
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0 })
    expect((httpServer.address() as AddressInfo).address).toBe('127.0.0.1')
  })

  it('refuses to start on 0.0.0.0 without an API key', async () => {
    await expect(
      startHttpTransport(createFleetMcpServer(), { port: 0, host: '0.0.0.0' }),
    ).rejects.toThrow(/API key/i)
  })

  it('refuses a non-loopback MCP_HOST without an API key', async () => {
    process.env.MCP_HOST = '0.0.0.0'
    await expect(startHttpTransport(createFleetMcpServer(), { port: 0 })).rejects.toThrow(/API key/i)
  })

  it('starts on 0.0.0.0 without a key only with explicit opt-in, and warns', async () => {
    httpServer = await startHttpTransport(createFleetMcpServer(), {
      port: 0,
      host: '0.0.0.0',
      allowUnauthenticatedRemote: true,
    })
    expect((httpServer.address() as AddressInfo).address).toBe('0.0.0.0')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*unauthenticated/i))
  })

  it('honours MCP_ALLOW_UNAUTHENTICATED_REMOTE=1', async () => {
    process.env.MCP_ALLOW_UNAUTHENTICATED_REMOTE = '1'
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0, host: '0.0.0.0' })
    expect((httpServer.address() as AddressInfo).address).toBe('0.0.0.0')
    expect(warn).toHaveBeenCalled()
  })

  it('allows 0.0.0.0 when an API key is configured', async () => {
    process.env.MCP_API_KEY = 'test-key-for-bind-policy'
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0, host: '0.0.0.0' })
    expect((httpServer.address() as AddressInfo).address).toBe('0.0.0.0')
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats an empty MCP_API_KEY as no key (refuses 0.0.0.0, binds loopback by default)', async () => {
    process.env.MCP_API_KEY = ''
    await expect(
      startHttpTransport(createFleetMcpServer(), { port: 0, host: '0.0.0.0' }),
    ).rejects.toThrow(/API key/i)
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0 })
    expect((httpServer.address() as AddressInfo).address).toBe('127.0.0.1')
  })

  it.each(['0', 'false', 'true', ''])(
    'MCP_ALLOW_UNAUTHENTICATED_REMOTE=%j does not opt in',
    async (value) => {
      process.env.MCP_ALLOW_UNAUTHENTICATED_REMOTE = value
      await expect(
        startHttpTransport(createFleetMcpServer(), { port: 0, host: '0.0.0.0' }),
      ).rejects.toThrow(/API key/i)
    },
  )

  it('an explicit host option beats MCP_HOST', async () => {
    process.env.MCP_HOST = '0.0.0.0'
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0, host: '127.0.0.1' })
    expect((httpServer.address() as AddressInfo).address).toBe('127.0.0.1')
  })

  it('allowUnauthenticatedRemote:false beats the env opt-in', async () => {
    process.env.MCP_ALLOW_UNAUTHENTICATED_REMOTE = '1'
    await expect(
      startHttpTransport(createFleetMcpServer(), {
        port: 0,
        host: '0.0.0.0',
        allowUnauthenticatedRemote: false,
      }),
    ).rejects.toThrow(/API key/i)
  })

  it('does not warn for a loopback host without a key', async () => {
    httpServer = await startHttpTransport(createFleetMcpServer(), { port: 0, host: 'localhost' })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('isLoopbackHost', () => {
  // ::ffff:127.0.0.1 (IPv4-mapped) is deliberately NOT treated as loopback: be conservative.
  it.each([
    ['127.0.0.1', true],
    ['127.5.6.7', true],
    ['::1', true],
    ['[::1]', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['0.0.0.0', false],
    ['::', false],
    ['[::]', false],
    ['', false],
    ['::ffff:0.0.0.0', false],
    ['::ffff:127.0.0.1', false],
    ['127.0.0.1.nip.io', false],
    ['localhost.evil.com', false],
    ['10.0.0.1', false],
    ['example.com', false],
  ])('%j -> %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected)
  })
})
