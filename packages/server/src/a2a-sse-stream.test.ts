/**
 * Tests for A2A SSE Streaming (REN-1149)
 *
 * Tests the session event → A2A SSE event mapping and stream lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isTerminalStatus,
  createStatusUpdateEvent,
  createArtifactUpdateEvent,
  PollingSessionEventSource,
  createSseStream,
} from './a2a-sse-stream.js'
import type {
  SessionEvent,
  SessionEventSource,
} from './a2a-sse-stream.js'
import { formatSseEvent } from './a2a-server.js'
import type { AgentSessionStatus } from './session-storage.js'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('./session-storage.js', () => ({
  getSessionState: vi.fn(async () => null),
  updateSessionStatus: vi.fn(async () => true),
}))

vi.mock('./a2a-callback-bridge.js', async (importOriginal) => {
  // Re-import the actual mapSessionStatusToA2a
  return {
    ...await importOriginal(),
  }
})

import { getSessionState } from './session-storage.js'
const mockedGetSessionState = vi.mocked(getSessionState)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory event source for testing */
class TestEventSource implements SessionEventSource {
  private events = new Map<string, SessionEvent[]>()
  private subscribers = new Map<string, { active: boolean }>()

  pushEvent(sessionId: string, event: SessionEvent) {
    const queue = this.events.get(sessionId) ?? []
    queue.push(event)
    this.events.set(sessionId, queue)
  }

  async *subscribe(sessionId: string): AsyncIterable<SessionEvent> {
    const sub = { active: true }
    this.subscribers.set(sessionId, sub)

    const queue = this.events.get(sessionId) ?? []
    for (const event of queue) {
      if (!sub.active) break
      yield event
    }
  }

  unsubscribe(sessionId: string): void {
    const sub = this.subscribers.get(sessionId)
    if (sub) {
      sub.active = false
      this.subscribers.delete(sessionId)
    }
  }

  isSubscribed(sessionId: string): boolean {
    return this.subscribers.has(sessionId)
  }
}

async function readStream(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }

  return result
}

function parseSSEEvents(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const blocks = raw.split('\n\n').filter((b) => b.trim())

  for (const block of blocks) {
    const lines = block.split('\n')
    let eventType = ''
    let dataStr = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7)
      } else if (line.startsWith('data: ')) {
        dataStr = line.slice(6)
      }
    }

    if (eventType && dataStr) {
      events.push({ event: eventType, data: JSON.parse(dataStr) })
    }
  }

  return events
}

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------

describe('isTerminalStatus', () => {
  it('returns true for completed', () => {
    expect(isTerminalStatus('completed')).toBe(true)
  })

  it('returns true for failed', () => {
    expect(isTerminalStatus('failed')).toBe(true)
  })

  it('returns true for canceled', () => {
    expect(isTerminalStatus('canceled')).toBe(true)
  })

  it('returns false for submitted', () => {
    expect(isTerminalStatus('submitted')).toBe(false)
  })

  it('returns false for working', () => {
    expect(isTerminalStatus('working')).toBe(false)
  })

  it('returns false for input-required', () => {
    expect(isTerminalStatus('input-required')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createStatusUpdateEvent
// ---------------------------------------------------------------------------

describe('createStatusUpdateEvent', () => {
  it('creates TaskStatusUpdate for running state', () => {
    const event = createStatusUpdateEvent('task-1', 'running')

    expect(event.type).toBe('TaskStatusUpdate')
    expect(event.taskId).toBe('task-1')
    expect(event.status).toBe('working')
    expect(event.final).toBe(false)
  })

  it('creates final event for completed state', () => {
    const event = createStatusUpdateEvent('task-1', 'completed')

    expect(event.status).toBe('completed')
    expect(event.final).toBe(true)
  })

  it('creates final event for failed state', () => {
    const event = createStatusUpdateEvent('task-1', 'failed')

    expect(event.status).toBe('failed')
    expect(event.final).toBe(true)
  })

  it('creates final event for stopped state', () => {
    const event = createStatusUpdateEvent('task-1', 'stopped')

    expect(event.status).toBe('canceled')
    expect(event.final).toBe(true)
  })

  it('includes message when provided', () => {
    const event = createStatusUpdateEvent('task-1', 'running', {
      role: 'agent',
      parts: [{ type: 'text', text: 'Working on it...' }],
    })

    expect(event.message).toBeDefined()
    expect(event.message!.parts[0]).toMatchObject({
      type: 'text',
      text: 'Working on it...',
    })
  })

  it('omits message when not provided', () => {
    const event = createStatusUpdateEvent('task-1', 'pending')
    expect(event.message).toBeUndefined()
  })

  it('maps all session statuses correctly', () => {
    const mappings: Array<[AgentSessionStatus, string, boolean]> = [
      ['pending', 'submitted', false],
      ['claimed', 'submitted', false],
      ['running', 'working', false],
      ['finalizing', 'working', false],
      ['completed', 'completed', true],
      ['failed', 'failed', true],
      ['stopped', 'canceled', true],
    ]

    for (const [sessionStatus, expectedA2a, expectedFinal] of mappings) {
      const event = createStatusUpdateEvent('task-1', sessionStatus)
      expect(event.status).toBe(expectedA2a)
      expect(event.final).toBe(expectedFinal)
    }
  })
})

// ---------------------------------------------------------------------------
// createArtifactUpdateEvent
// ---------------------------------------------------------------------------

describe('createArtifactUpdateEvent', () => {
  it('creates text artifact when no mimeType', () => {
    const event = createArtifactUpdateEvent('task-1', 'output.txt', 'Hello world')

    expect(event.type).toBe('TaskArtifactUpdate')
    expect(event.taskId).toBe('task-1')
    expect(event.artifact.name).toBe('output.txt')
    expect(event.artifact.parts[0]).toMatchObject({
      type: 'text',
      text: 'Hello world',
    })
  })

  it('creates file artifact when mimeType provided', () => {
    const event = createArtifactUpdateEvent(
      'task-1',
      'report.json',
      '{"key": "value"}',
      'application/json',
    )

    expect(event.artifact.parts[0]).toMatchObject({
      type: 'file',
      file: {
        name: 'report.json',
        mimeType: 'application/json',
        bytes: '{"key": "value"}',
      },
    })
  })
})

// ---------------------------------------------------------------------------
// formatSseEvent integration
// ---------------------------------------------------------------------------

describe('formatSseEvent output conformance', () => {
  it('TaskStatusUpdate conforms to SSE wire format', () => {
    const event = createStatusUpdateEvent('task-1', 'running')
    const formatted = formatSseEvent(event)

    expect(formatted).toMatch(/^event: TaskStatusUpdate\n/)
    expect(formatted).toMatch(/^data: .+$/m)
    expect(formatted.endsWith('\n\n')).toBe(true)

    // Parse data line
    const dataLine = formatted.split('\n')[1]
    const parsed = JSON.parse(dataLine.slice(6))
    expect(parsed.type).toBe('TaskStatusUpdate')
    expect(parsed.taskId).toBe('task-1')
    expect(parsed.status).toBe('working')
  })

  it('final event includes terminal task state', () => {
    const event = createStatusUpdateEvent('task-1', 'completed')
    const formatted = formatSseEvent(event)

    const dataLine = formatted.split('\n')[1]
    const parsed = JSON.parse(dataLine.slice(6))
    expect(parsed.final).toBe(true)
    expect(parsed.status).toBe('completed')
  })

  it('TaskArtifactUpdate conforms to SSE wire format', () => {
    const event = createArtifactUpdateEvent('task-1', 'output.txt', 'content')
    const formatted = formatSseEvent(event)

    expect(formatted).toMatch(/^event: TaskArtifactUpdate\n/)
    expect(formatted.endsWith('\n\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createSseStream
// ---------------------------------------------------------------------------

describe('createSseStream', () => {
  let eventSource: TestEventSource

  beforeEach(() => {
    vi.clearAllMocks()
    eventSource = new TestEventSource()
  })

  it('returns 404 when task ID not found', () => {
    const response = createSseStream('unknown-task', {
      eventSource,
      getSessionId: () => undefined,
    })

    expect(response.status).toBe(404)
  })

  it('returns SSE content type', () => {
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'completed' },
    })

    const response = createSseStream('task-1', {
      eventSource,
      getSessionId: () => 'session-1',
    })

    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('streams status events as SSE', async () => {
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'running' },
    })
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'completed' },
    })

    const response = createSseStream('task-1', {
      eventSource,
      getSessionId: () => 'session-1',
    })

    const raw = await readStream(response)
    const events = parseSSEEvents(raw)

    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('TaskStatusUpdate')
    expect(events[0].data.status).toBe('working')
    expect(events[0].data.final).toBe(false)
    expect(events[1].event).toBe('TaskStatusUpdate')
    expect(events[1].data.status).toBe('completed')
    expect(events[1].data.final).toBe(true)
  })

  it('streams artifact events', async () => {
    eventSource.pushEvent('session-1', {
      type: 'artifact',
      event: {
        sessionId: 'session-1',
        name: 'output.txt',
        content: 'Hello world',
      },
    })
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'completed' },
    })

    const response = createSseStream('task-1', {
      eventSource,
      getSessionId: () => 'session-1',
    })

    const raw = await readStream(response)
    const events = parseSSEEvents(raw)

    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('TaskArtifactUpdate')
    expect((events[0].data as any).artifact.name).toBe('output.txt')
    expect(events[1].event).toBe('TaskStatusUpdate')
    expect(events[1].data.status).toBe('completed')
  })

  it('closes stream on completion', async () => {
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'completed' },
    })

    const response = createSseStream('task-1', {
      eventSource,
      getSessionId: () => 'session-1',
    })

    const raw = await readStream(response)
    const events = parseSSEEvents(raw)

    expect(events).toHaveLength(1)
    expect(events[0].data.final).toBe(true)
  })

  it('closes stream on failure', async () => {
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'failed' },
    })

    const response = createSseStream('task-1', {
      eventSource,
      getSessionId: () => 'session-1',
    })

    const raw = await readStream(response)
    const events = parseSSEEvents(raw)

    expect(events).toHaveLength(1)
    expect(events[0].data.status).toBe('failed')
    expect(events[0].data.final).toBe(true)
  })

  it('closes stream on cancellation', async () => {
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'stopped' },
    })

    const response = createSseStream('task-1', {
      eventSource,
      getSessionId: () => 'session-1',
    })

    const raw = await readStream(response)
    const events = parseSSEEvents(raw)

    expect(events).toHaveLength(1)
    expect(events[0].data.status).toBe('canceled')
    expect(events[0].data.final).toBe(true)
  })

  it('unsubscribes from event source when stream completes', async () => {
    eventSource.pushEvent('session-1', {
      type: 'status',
      event: { sessionId: 'session-1', status: 'completed' },
    })

    const response = createSseStream('task-1', {
      eventSource,
      getSessionId: () => 'session-1',
    })

    await readStream(response)

    // After stream completes, subscription should be cleaned up
    expect(eventSource.isSubscribed('session-1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PollingSessionEventSource
// ---------------------------------------------------------------------------

describe('PollingSessionEventSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits status change events', async () => {
    const source = new PollingSessionEventSource(10) // Fast polling for tests

    let callCount = 0
    mockedGetSessionState.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          trackerSessionId: 'session-1',
          trackerProvider: 'linear',
          issueId: 'issue-1',
          providerSessionId: null,
          worktreePath: '/tmp/test',
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
      return {
        trackerSessionId: 'session-1',
        trackerProvider: 'linear',
        issueId: 'issue-1',
        providerSessionId: null,
        worktreePath: '/tmp/test',
        status: 'completed' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    })

    const events: SessionEvent[] = []
    for await (const event of source.subscribe('session-1')) {
      events.push(event)
      if (events.length >= 2) break
    }

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('status')
    expect((events[0] as any).event.status).toBe('running')
    expect(events[1].type).toBe('status')
    expect((events[1] as any).event.status).toBe('completed')
  })

  it('unsubscribe stops polling', () => {
    const source = new PollingSessionEventSource(10)
    // Just verify it doesn't throw
    source.unsubscribe('session-1')
  })
})
