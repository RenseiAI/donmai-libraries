import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @renseiai/agentfactory-server ────────────────────────────────────────
vi.mock('@renseiai/agentfactory-server', () => ({
  getAllSessions: vi.fn(),
  getSessionsByStatus: vi.fn(),
  getSessionState: vi.fn(),
  getSessionStateByIssue: vi.fn(),
  storeSessionState: vi.fn(),
  updateSessionStatus: vi.fn(),
  publishUrgent: vi.fn(),
}))

// ── Mock @modelcontextprotocol/sdk ──────────────────────────────────────────
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(),
}))

import {
  getAllSessions,
  getSessionsByStatus,
  getSessionState,
  getSessionStateByIssue,
  storeSessionState,
  updateSessionStatus,
  publishUrgent,
} from '@renseiai/agentfactory-server'
import { registerFleetTools } from './tools.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

/** Capture tool registrations from registerFleetTools */
function captureTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>()
  const fakeMcpServer = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler)
    },
  }
  registerFleetTools(fakeMcpServer as never)
  return tools
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    trackerSessionId: 'ses-123',
    trackerProvider: 'linear',
    issueId: 'issue-abc',
    issueIdentifier: 'SUP-100',
    providerSessionId: null,
    worktreePath: '/tmp/wt',
    status: 'running',
    priority: 3,
    workType: 'development',
    queuedAt: 1000,
    totalCostUsd: 0.5,
    inputTokens: 1000,
    outputTokens: 500,
    agentId: 'agent-001',
    ...overrides,
  }
}

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

// ── Tests ───────────────────────────────────────────────────────────────────

let tools: Map<string, ToolHandler>

beforeEach(() => {
  vi.resetAllMocks()
  tools = captureTools()
})

describe('registerFleetTools', () => {
  it('registers all 6 expected tools', () => {
    expect(tools.size).toBe(6)
    expect([...tools.keys()].sort()).toEqual([
      'forward-prompt',
      'get-cost-report',
      'get-task-status',
      'list-fleet',
      'stop-agent',
      'submit-task',
    ])
  })
})

describe('submit-task', () => {
  it('creates a pending session and returns task info', async () => {
    const handler = tools.get('submit-task')!
    vi.mocked(storeSessionState).mockResolvedValue({
      trackerSessionId: 'mcp-123-issue-1', trackerProvider: 'linear',
      issueId: 'issue-1',
      status: 'pending',
      priority: 2,
      workType: 'research',
    } as never)

    const result = await handler({ issueId: 'issue-1', workType: 'research', priority: 2 })
    const data = parseResult(result)

    expect(data.submitted).toBe(true)
    expect(data.issueId).toBe('issue-1')
    expect(data.status).toBe('pending')
    expect(data.workType).toBe('research')
    expect(data.priority).toBe(2)
    expect(storeSessionState).toHaveBeenCalledOnce()
  })

  it('defaults to development work type and priority 3', async () => {
    const handler = tools.get('submit-task')!
    vi.mocked(storeSessionState).mockResolvedValue({
      trackerSessionId: 'mcp-123-issue-2', trackerProvider: 'linear',
      issueId: 'issue-2',
      status: 'pending',
      priority: 3,
      workType: 'development',
    } as never)

    await handler({ issueId: 'issue-2' })

    const callArgs = vi.mocked(storeSessionState).mock.calls[0][1] as Record<string, unknown>
    expect(callArgs.workType).toBe('development')
    expect(callArgs.priority).toBe(3)
  })

  it('returns error when storeSessionState throws', async () => {
    const handler = tools.get('submit-task')!
    vi.mocked(storeSessionState).mockRejectedValue(new Error('Redis down'))

    const result = await handler({ issueId: 'issue-1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Redis down')
  })
})

describe('get-task-status', () => {
  it('returns session when found by session ID', async () => {
    const handler = tools.get('get-task-status')!
    const session = makeSession()
    vi.mocked(getSessionState).mockResolvedValue(session as never)

    const result = await handler({ taskId: 'ses-123' })
    const data = parseResult(result)

    expect(data.trackerSessionId).toBe('ses-123')
    expect(result.isError).toBeUndefined()
  })

  it('falls back to issue-based lookup', async () => {
    const handler = tools.get('get-task-status')!
    vi.mocked(getSessionState).mockResolvedValue(null as never)
    vi.mocked(getSessionStateByIssue).mockResolvedValue(makeSession() as never)

    const result = await handler({ taskId: 'issue-abc' })

    expect(getSessionStateByIssue).toHaveBeenCalledWith('issue-abc')
    expect(result.isError).toBeUndefined()
  })

  it('returns error when task not found', async () => {
    const handler = tools.get('get-task-status')!
    vi.mocked(getSessionState).mockResolvedValue(null as never)
    vi.mocked(getSessionStateByIssue).mockResolvedValue(null as never)

    const result = await handler({ taskId: 'unknown' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No task found')
  })
})

describe('list-fleet', () => {
  it('returns all sessions when no filter', async () => {
    const handler = tools.get('list-fleet')!
    const sessions = [makeSession(), makeSession({ trackerSessionId: 'ses-456' })]
    vi.mocked(getAllSessions).mockResolvedValue(sessions as never)

    const result = await handler({})
    const data = parseResult(result)

    expect(data.total).toBe(2)
    expect(data.returned).toBe(2)
    expect(getAllSessions).toHaveBeenCalledOnce()
  })

  it('filters by status', async () => {
    const handler = tools.get('list-fleet')!
    vi.mocked(getSessionsByStatus).mockResolvedValue([makeSession()] as never)

    const result = await handler({ status: ['running'] })
    const data = parseResult(result)

    expect(getSessionsByStatus).toHaveBeenCalledWith(['running'])
    expect(data.total).toBe(1)
  })

  it('respects limit parameter', async () => {
    const handler = tools.get('list-fleet')!
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession({ trackerSessionId: `ses-${i}` }),
    )
    vi.mocked(getAllSessions).mockResolvedValue(sessions as never)

    const result = await handler({ limit: 5 })
    const data = parseResult(result)

    expect(data.total).toBe(30)
    expect(data.returned).toBe(5)
  })

  it('defaults limit to 20', async () => {
    const handler = tools.get('list-fleet')!
    const sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ trackerSessionId: `ses-${i}` }),
    )
    vi.mocked(getAllSessions).mockResolvedValue(sessions as never)

    const result = await handler({})
    const data = parseResult(result)

    expect(data.returned).toBe(20)
  })
})

describe('get-cost-report', () => {
  it('returns single-task cost when taskId provided', async () => {
    const handler = tools.get('get-cost-report')!
    vi.mocked(getSessionState).mockResolvedValue(
      makeSession({ totalCostUsd: 1.23, inputTokens: 5000, outputTokens: 2000 }) as never,
    )

    const result = await handler({ taskId: 'ses-123' })
    const data = parseResult(result)

    expect(data.totalCostUsd).toBe(1.23)
    expect(data.inputTokens).toBe(5000)
    expect(data.outputTokens).toBe(2000)
  })

  it('returns fleet-wide cost when no taskId', async () => {
    const handler = tools.get('get-cost-report')!
    vi.mocked(getAllSessions).mockResolvedValue([
      makeSession({ totalCostUsd: 1.0, inputTokens: 1000, outputTokens: 500 }),
      makeSession({ totalCostUsd: 2.0, inputTokens: 2000, outputTokens: 1000 }),
    ] as never)

    const result = await handler({})
    const data = parseResult(result)

    expect(data.totalSessions).toBe(2)
    expect(data.totalCostUsd).toBe(3.0)
    expect(data.totalInputTokens).toBe(3000)
    expect(data.totalOutputTokens).toBe(1500)
  })

  it('returns error when single task not found', async () => {
    const handler = tools.get('get-cost-report')!
    vi.mocked(getSessionState).mockResolvedValue(null as never)
    vi.mocked(getSessionStateByIssue).mockResolvedValue(null as never)

    const result = await handler({ taskId: 'unknown' })

    expect(result.isError).toBe(true)
  })
})

describe('stop-agent', () => {
  it('stops a running task', async () => {
    const handler = tools.get('stop-agent')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'running' }) as never)
    vi.mocked(updateSessionStatus).mockResolvedValue(true as never)

    const result = await handler({ taskId: 'ses-123' })
    const data = parseResult(result)

    expect(data.stopped).toBe(true)
    expect(data.previousStatus).toBe('running')
    expect(data.newStatus).toBe('stopped')
    expect(updateSessionStatus).toHaveBeenCalledWith('ses-123', 'stopped')
  })

  it('stops a pending task', async () => {
    const handler = tools.get('stop-agent')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'pending' }) as never)
    vi.mocked(updateSessionStatus).mockResolvedValue(true as never)

    const result = await handler({ taskId: 'ses-123' })
    const data = parseResult(result)

    expect(data.stopped).toBe(true)
    expect(data.previousStatus).toBe('pending')
  })

  it('rejects stopping a completed task', async () => {
    const handler = tools.get('stop-agent')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'completed' }) as never)

    const result = await handler({ taskId: 'ses-123' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('cannot be stopped')
  })

  it('returns error when task not found', async () => {
    const handler = tools.get('stop-agent')!
    vi.mocked(getSessionState).mockResolvedValue(null as never)
    vi.mocked(getSessionStateByIssue).mockResolvedValue(null as never)

    const result = await handler({ taskId: 'unknown' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No task found')
  })

  it('returns error when Redis update fails', async () => {
    const handler = tools.get('stop-agent')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'running' }) as never)
    vi.mocked(updateSessionStatus).mockResolvedValue(false as never)

    const result = await handler({ taskId: 'ses-123' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Failed to update')
  })
})

describe('forward-prompt', () => {
  it('forwards a prompt to a running session via agent inbox', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'running' }) as never)
    vi.mocked(publishUrgent).mockResolvedValue('1234567890-0')

    const result = await handler({ taskId: 'ses-123', message: 'Please also fix the tests' })
    const data = parseResult(result)

    expect(data.forwarded).toBe(true)
    expect(data.streamId).toBe('1234567890-0')
    expect(data.taskId).toBe('ses-123')
    expect(publishUrgent).toHaveBeenCalledWith('agent-001', expect.objectContaining({
      type: 'directive',
      sessionId: 'ses-123',
      payload: 'Please also fix the tests',
    }))
  })

  it('forwards a prompt to a claimed session', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'claimed' }) as never)
    vi.mocked(publishUrgent).mockResolvedValue('1234567891-0')

    const result = await handler({ taskId: 'ses-123', message: 'extra context' })
    const data = parseResult(result)

    expect(data.forwarded).toBe(true)
    expect(data.sessionStatus).toBe('claimed')
  })

  it('falls back to issue-based lookup', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(null as never)
    vi.mocked(getSessionStateByIssue).mockResolvedValue(makeSession() as never)
    vi.mocked(publishUrgent).mockResolvedValue('1234567892-0')

    const result = await handler({ taskId: 'issue-abc', message: 'msg' })

    expect(getSessionStateByIssue).toHaveBeenCalledWith('issue-abc')
    expect(result.isError).toBeUndefined()
  })

  it('rejects forwarding to a completed session', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'completed' }) as never)

    const result = await handler({ taskId: 'ses-123', message: 'hello' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Prompts can only be forwarded to running or claimed')
  })

  it('rejects forwarding to a stopped session', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'stopped' }) as never)

    const result = await handler({ taskId: 'ses-123', message: 'hello' })

    expect(result.isError).toBe(true)
  })

  it('returns error when task not found', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(null as never)
    vi.mocked(getSessionStateByIssue).mockResolvedValue(null as never)

    const result = await handler({ taskId: 'unknown', message: 'hello' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No task found')
  })

  it('returns error when session has no agentId', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'running', agentId: undefined }) as never)

    const result = await handler({ taskId: 'ses-123', message: 'hello' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('no agentId')
  })

  it('returns error when publishUrgent throws', async () => {
    const handler = tools.get('forward-prompt')!
    vi.mocked(getSessionState).mockResolvedValue(makeSession({ status: 'running' }) as never)
    vi.mocked(publishUrgent).mockRejectedValue(new Error('Redis not configured'))

    const result = await handler({ taskId: 'ses-123', message: 'hello' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Redis not configured')
  })
})
