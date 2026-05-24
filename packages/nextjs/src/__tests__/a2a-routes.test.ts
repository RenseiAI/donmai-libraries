/**
 * Tests for A2A route handlers (REN-1147)
 *
 * Tests the agent-card.json GET handler and the /api/a2a POST handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createAgentCardHandler } from '../handlers/a2a/agent-card.js'
import { createA2aRpcHandler } from '../handlers/a2a/rpc.js'
import type { A2aServerConfig } from '@donmai/server'
import type { A2aTask, A2aMessage, A2aAgentCard, JsonRpcResponse } from '@donmai/server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<A2aTask> = {}): A2aTask {
  return {
    id: 'task-1',
    status: 'submitted',
    messages: [],
    artifacts: [],
    ...overrides,
  }
}

function makeMessage(text: string, role: 'user' | 'agent' = 'user'): A2aMessage {
  return { role, parts: [{ type: 'text', text }] }
}

function createJsonRpcRequest(
  method: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>,
): NextRequest {
  const body = { jsonrpc: '2.0', id: 1, method, params }
  return new NextRequest('http://localhost/api/a2a', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-api-key',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const baseA2aConfig: A2aServerConfig = {
  name: 'TestAgent',
  description: 'A test agent',
  url: 'https://test.example.com/a2a',
  version: '1.0.0',
  streaming: true,
  authSchemes: [{ type: 'http', scheme: 'bearer' }],
}

// ---------------------------------------------------------------------------
// Agent Card Handler
// ---------------------------------------------------------------------------

describe('createAgentCardHandler', () => {
  it('returns a valid AgentCard JSON response', async () => {
    const handler = createAgentCardHandler({ a2aConfig: baseA2aConfig })
    const response = await handler()

    expect(response.status).toBe(200)
    const body = (await response.json()) as A2aAgentCard

    expect(body.name).toBe('TestAgent')
    expect(body.description).toBe('A test agent')
    expect(body.url).toBe('https://test.example.com/a2a')
    expect(body.version).toBe('1.0.0')
    expect(body.capabilities.streaming).toBe(true)
    expect(body.capabilities.pushNotifications).toBe(false)
    expect(body.capabilities.stateTransitionHistory).toBe(false)
    expect(body.authentication).toEqual([{ type: 'http', scheme: 'bearer' }])
    expect(body.skills.length).toBeGreaterThan(0)
    expect(body.defaultInputContentTypes).toEqual(['text/plain'])
    expect(body.defaultOutputContentTypes).toEqual(['text/plain'])
  })

  it('sets Cache-Control header', async () => {
    const handler = createAgentCardHandler({ a2aConfig: baseA2aConfig })
    const response = await handler()

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })

  it('auto-generates skills from AgentWorkType when none provided', async () => {
    const config: A2aServerConfig = {
      name: 'Worker',
      description: 'Generic worker',
      url: 'https://worker.example.com/a2a',
    }
    const handler = createAgentCardHandler({ a2aConfig: config })
    const response = await handler()
    const body = (await response.json()) as A2aAgentCard

    const skillIds = body.skills.map((s) => s.id)
    expect(skillIds).toContain('code-development')
    expect(skillIds).toContain('quality-assurance')
    expect(skillIds).toContain('research-analysis')
  })

  it('uses explicit skills when provided', async () => {
    const config: A2aServerConfig = {
      ...baseA2aConfig,
      skills: [{ id: 'custom', name: 'Custom', description: 'Custom skill' }],
    }
    const handler = createAgentCardHandler({ a2aConfig: config })
    const response = await handler()
    const body = (await response.json()) as A2aAgentCard

    expect(body.skills).toHaveLength(1)
    expect(body.skills[0].id).toBe('custom')
  })

  it('omits authentication when no authSchemes provided', async () => {
    const config: A2aServerConfig = {
      name: 'NoAuth',
      description: 'No auth agent',
      url: 'https://noauth.example.com/a2a',
    }
    const handler = createAgentCardHandler({ a2aConfig: config })
    const response = await handler()
    const body = (await response.json()) as A2aAgentCard

    expect(body.authentication).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// A2A RPC Handler
// ---------------------------------------------------------------------------

describe('createA2aRpcHandler', () => {
  const defaultCallbacks = {
    onSendMessage: vi.fn(async () => makeTask()),
    onGetTask: vi.fn(async () => makeTask()),
    onCancelTask: vi.fn(async () => makeTask({ status: 'canceled' })),
  }

  // Always allow auth in tests by default
  const alwaysAuth = () => true

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('JSON-RPC validation', () => {
    it('returns -32700 Parse error for invalid JSON body', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = new NextRequest('http://localhost/api/a2a', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        },
        body: 'not json',
      })

      const response = await handler(request)
      expect(response.status).toBe(400)

      const body = (await response.json()) as JsonRpcResponse
      expect(body.error?.code).toBe(-32700)
      expect(body.error?.message).toBe('Parse error')
    })

    it('returns -32600 Invalid Request when jsonrpc version is wrong', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = new NextRequest('http://localhost/api/a2a', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'tasks/get', params: { taskId: 'x' } }),
      })

      const response = await handler(request)
      expect(response.status).toBe(400)

      const body = (await response.json()) as JsonRpcResponse
      expect(body.error?.code).toBe(-32600)
      expect(body.error?.message).toBe('Invalid Request')
    })

    it('returns -32600 Invalid Request when method is missing', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = new NextRequest('http://localhost/api/a2a', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      })

      const response = await handler(request)
      expect(response.status).toBe(400)

      const body = (await response.json()) as JsonRpcResponse
      expect(body.error?.code).toBe(-32600)
    })
  })

  describe('authentication', () => {
    it('returns 401 when auth fails', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: () => false,
      })

      const request = createJsonRpcRequest('tasks/get', { taskId: 'task-1' })
      const response = await handler(request)

      const body = (await response.json()) as JsonRpcResponse
      expect(body.error?.code).toBe(-32000)
      expect(body.error?.message).toBe('Unauthorized')
      expect(response.status).toBe(401)
    })

    it('passes request through when auth succeeds', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest('tasks/get', { taskId: 'task-1' })
      const response = await handler(request)

      expect(response.status).toBe(200)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.result).toBeDefined()
    })
  })

  describe('method routing', () => {
    it('routes message/send and returns task', async () => {
      const task = makeTask({ id: 'task-42', status: 'working' })
      const onSendMessage = vi.fn(async () => task)
      const handler = createA2aRpcHandler({
        callbacks: { ...defaultCallbacks, onSendMessage },
        verifyAuth: alwaysAuth,
      })

      const message = makeMessage('Hello agent')
      const request = createJsonRpcRequest('message/send', { message })
      const response = await handler(request)

      expect(response.status).toBe(200)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.result).toEqual(task)
      expect(body.jsonrpc).toBe('2.0')
      expect(onSendMessage).toHaveBeenCalledWith(message, undefined)
    })

    it('routes tasks/get and returns task', async () => {
      const task = makeTask({ id: 'task-99', status: 'completed' })
      const onGetTask = vi.fn(async () => task)
      const handler = createA2aRpcHandler({
        callbacks: { ...defaultCallbacks, onGetTask },
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest('tasks/get', { taskId: 'task-99' })
      const response = await handler(request)

      expect(response.status).toBe(200)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.result).toEqual(task)
      expect(onGetTask).toHaveBeenCalledWith('task-99')
    })

    it('routes tasks/cancel and returns canceled task', async () => {
      const task = makeTask({ id: 'task-5', status: 'canceled' })
      const onCancelTask = vi.fn(async () => task)
      const handler = createA2aRpcHandler({
        callbacks: { ...defaultCallbacks, onCancelTask },
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest('tasks/cancel', { taskId: 'task-5' })
      const response = await handler(request)

      expect(response.status).toBe(200)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.result).toEqual(task)
      expect(onCancelTask).toHaveBeenCalledWith('task-5')
    })

    it('returns -32601 for unknown methods', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest('foo/bar')
      const response = await handler(request)

      expect(response.status).toBe(404)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.error?.code).toBe(-32601)
      expect(body.error?.message).toContain('Method not found')
    })

    it('returns -32602 when taskId is missing from tasks/get', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest('tasks/get', {})
      const response = await handler(request)

      expect(response.status).toBe(400)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.error?.code).toBe(-32602)
    })

    it('returns -32001 when task not found', async () => {
      const onGetTask = vi.fn(async () => null)
      const handler = createA2aRpcHandler({
        callbacks: { ...defaultCallbacks, onGetTask },
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest('tasks/get', { taskId: 'missing' })
      const response = await handler(request)

      const body = (await response.json()) as JsonRpcResponse
      expect(body.error?.code).toBe(-32001)
      expect(body.error?.message).toBe('Task not found')
    })
  })

  describe('SSE streaming', () => {
    it('delegates to onStreamRequest when Accept: text/event-stream and handler provided', async () => {
      const sseResponse = new Response('data: test\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
      const onStreamRequest = vi.fn(async () => sseResponse)

      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
        onStreamRequest,
      })

      const request = createJsonRpcRequest(
        'message/send',
        { message: makeMessage('hi') },
        { Accept: 'text/event-stream' },
      )

      const response = await handler(request)
      expect(onStreamRequest).toHaveBeenCalled()
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    })

    it('falls through to JSON-RPC when Accept: text/event-stream but no stream handler', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest(
        'message/send',
        { message: makeMessage('hi') },
        { Accept: 'text/event-stream' },
      )

      const response = await handler(request)
      expect(response.status).toBe(200)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.result).toBeDefined()
    })

    it('returns 401 for SSE streaming when auth fails', async () => {
      const onStreamRequest = vi.fn(async () => new Response(''))
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: () => false,
        onStreamRequest,
      })

      const request = createJsonRpcRequest(
        'message/send',
        { message: makeMessage('hi') },
        { Accept: 'text/event-stream' },
      )

      const response = await handler(request)
      expect(response.status).toBe(401)
      expect(onStreamRequest).not.toHaveBeenCalled()
    })
  })

  describe('response format', () => {
    it('always includes jsonrpc 2.0 version', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = createJsonRpcRequest('tasks/get', { taskId: 'x' })
      const response = await handler(request)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.jsonrpc).toBe('2.0')
    })

    it('echoes back the request id', async () => {
      const handler = createA2aRpcHandler({
        callbacks: defaultCallbacks,
        verifyAuth: alwaysAuth,
      })

      const request = new NextRequest('http://localhost/api/a2a', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tasks/get', params: { taskId: 'x' } }),
      })

      const response = await handler(request)
      const body = (await response.json()) as JsonRpcResponse
      expect(body.id).toBe(42)
    })
  })
})
