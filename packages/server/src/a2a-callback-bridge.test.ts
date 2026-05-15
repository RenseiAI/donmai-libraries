/**
 * Tests for A2A Callback Bridge (REN-1148)
 *
 * Tests the three A2A server callbacks that bridge external A2A requests
 * into the AgentFactory work queue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  A2aTaskMap,
  mapSessionStatusToA2a,
  createA2aCallbackBridge,
} from './a2a-callback-bridge.js'
import type { A2aMessage } from './a2a-types.js'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('./work-queue.js', () => ({
  queueWork: vi.fn(async () => true),
}))

vi.mock('./session-storage.js', () => ({
  getSessionState: vi.fn(async () => null),
  updateSessionStatus: vi.fn(async () => true),
}))

// Import mocked modules for test control
import { queueWork } from './work-queue.js'
import { getSessionState, updateSessionStatus } from './session-storage.js'

const mockedQueueWork = vi.mocked(queueWork)
const mockedGetSessionState = vi.mocked(getSessionState)
const mockedUpdateSessionStatus = vi.mocked(updateSessionStatus)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string, role: 'user' | 'agent' = 'user'): A2aMessage {
  return { role, parts: [{ type: 'text', text }] }
}

// ---------------------------------------------------------------------------
// A2aTaskMap
// ---------------------------------------------------------------------------

describe('A2aTaskMap', () => {
  let taskMap: A2aTaskMap

  beforeEach(() => {
    taskMap = new A2aTaskMap()
  })

  it('creates a mapping and returns a task ID', () => {
    const taskId = taskMap.create('session-1')

    expect(taskId).toMatch(/^a2a-/)
    expect(taskMap.getSessionId(taskId)).toBe('session-1')
    expect(taskMap.getTaskId('session-1')).toBe(taskId)
  })

  it('returns existing task ID for same session', () => {
    const taskId1 = taskMap.create('session-1')
    const taskId2 = taskMap.create('session-1')

    expect(taskId1).toBe(taskId2)
  })

  it('creates unique task IDs for different sessions', () => {
    const taskId1 = taskMap.create('session-1')
    const taskId2 = taskMap.create('session-2')

    expect(taskId1).not.toBe(taskId2)
  })

  it('returns undefined for unknown task ID', () => {
    expect(taskMap.getSessionId('unknown')).toBeUndefined()
  })

  it('returns undefined for unknown session ID', () => {
    expect(taskMap.getTaskId('unknown')).toBeUndefined()
  })

  it('stores and retrieves messages', () => {
    const taskId = taskMap.create('session-1')
    const msg1 = makeMessage('Hello')
    const msg2 = makeMessage('World')

    taskMap.addMessage(taskId, msg1)
    taskMap.addMessage(taskId, msg2)

    const messages = taskMap.getMessages(taskId)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual(msg1)
    expect(messages[1]).toEqual(msg2)
  })

  it('returns empty array for unknown task messages', () => {
    expect(taskMap.getMessages('unknown')).toEqual([])
  })

  it('deletes a mapping', () => {
    const taskId = taskMap.create('session-1')
    taskMap.addMessage(taskId, makeMessage('test'))

    taskMap.delete(taskId)

    expect(taskMap.getSessionId(taskId)).toBeUndefined()
    expect(taskMap.getTaskId('session-1')).toBeUndefined()
    expect(taskMap.getMessages(taskId)).toEqual([])
  })

  it('tracks size correctly', () => {
    expect(taskMap.size).toBe(0)

    taskMap.create('session-1')
    expect(taskMap.size).toBe(1)

    taskMap.create('session-2')
    expect(taskMap.size).toBe(2)

    const taskId = taskMap.getTaskId('session-1')!
    taskMap.delete(taskId)
    expect(taskMap.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// mapSessionStatusToA2a
// ---------------------------------------------------------------------------

describe('mapSessionStatusToA2a', () => {
  it('maps pending to submitted', () => {
    expect(mapSessionStatusToA2a('pending')).toBe('submitted')
  })

  it('maps claimed to submitted', () => {
    expect(mapSessionStatusToA2a('claimed')).toBe('submitted')
  })

  it('maps running to working', () => {
    expect(mapSessionStatusToA2a('running')).toBe('working')
  })

  it('maps finalizing to working', () => {
    expect(mapSessionStatusToA2a('finalizing')).toBe('working')
  })

  it('maps completed to completed', () => {
    expect(mapSessionStatusToA2a('completed')).toBe('completed')
  })

  it('maps failed to failed', () => {
    expect(mapSessionStatusToA2a('failed')).toBe('failed')
  })

  it('maps stopped to canceled', () => {
    expect(mapSessionStatusToA2a('stopped')).toBe('canceled')
  })
})

// ---------------------------------------------------------------------------
// createA2aCallbackBridge — onSendMessage
// ---------------------------------------------------------------------------

describe('createA2aCallbackBridge', () => {
  let taskMap: A2aTaskMap

  beforeEach(() => {
    vi.clearAllMocks()
    taskMap = new A2aTaskMap()
    mockedQueueWork.mockResolvedValue(true)
    mockedGetSessionState.mockResolvedValue(null)
    mockedUpdateSessionStatus.mockResolvedValue(true)
  })

  describe('onSendMessage', () => {
    it('creates a QueuedWork item with correct fields from A2A message', async () => {
      const { onSendMessage } = createA2aCallbackBridge(taskMap)

      const message = makeMessage('Build the feature')
      const task = await onSendMessage(message)

      expect(task.id).toMatch(/^a2a-/)
      expect(task.status).toBe('submitted')
      expect(task.messages).toHaveLength(1)
      expect(task.messages[0]).toEqual(message)
      expect(task.artifacts).toEqual([])

      expect(mockedQueueWork).toHaveBeenCalledOnce()
      const workItem = mockedQueueWork.mock.calls[0][0]
      expect(workItem.prompt).toBe('Build the feature')
      expect(workItem.issueId).toBe('a2a-external')
      expect(workItem.priority).toBe(3)
      expect(workItem.workType).toBe('development')
      expect(workItem.sessionId).toMatch(/^a2a-session-/)
    })

    it('returns a unique A2A task ID mapped to the session ID', async () => {
      const { onSendMessage } = createA2aCallbackBridge(taskMap)

      const task1 = await onSendMessage(makeMessage('Task 1'))
      const task2 = await onSendMessage(makeMessage('Task 2'))

      expect(task1.id).not.toBe(task2.id)
      expect(taskMap.getSessionId(task1.id)).toBeDefined()
      expect(taskMap.getSessionId(task2.id)).toBeDefined()
    })

    it('uses custom config values', async () => {
      const { onSendMessage } = createA2aCallbackBridge(taskMap, {
        defaultIssueId: 'custom-issue',
        defaultIssueIdentifier: 'CUSTOM',
        defaultPriority: 1,
        projectName: 'TestProject',
      })

      await onSendMessage(makeMessage('hello'))

      const workItem = mockedQueueWork.mock.calls[0][0]
      expect(workItem.issueId).toBe('custom-issue')
      expect(workItem.issueIdentifier).toMatch(/^CUSTOM-/)
      expect(workItem.priority).toBe(1)
      expect(workItem.projectName).toBe('TestProject')
    })

    it('concatenates multiple text parts into prompt', async () => {
      const { onSendMessage } = createA2aCallbackBridge(taskMap)

      const message: A2aMessage = {
        role: 'user',
        parts: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      }
      await onSendMessage(message)

      const workItem = mockedQueueWork.mock.calls[0][0]
      expect(workItem.prompt).toBe('Part 1\nPart 2')
    })

    it('uses fallback prompt when no text parts exist', async () => {
      const { onSendMessage } = createA2aCallbackBridge(taskMap)

      const message: A2aMessage = {
        role: 'user',
        parts: [{ type: 'data', data: { key: 'value' } }],
      }
      await onSendMessage(message)

      const workItem = mockedQueueWork.mock.calls[0][0]
      expect(workItem.prompt).toBe('A2A task request')
    })

    it('throws when queueWork fails', async () => {
      mockedQueueWork.mockResolvedValue(false)
      const { onSendMessage } = createA2aCallbackBridge(taskMap)

      await expect(onSendMessage(makeMessage('hello'))).rejects.toThrow(
        'Failed to queue work item',
      )
    })

    it('handles follow-up message to existing task', async () => {
      const { onSendMessage } = createA2aCallbackBridge(taskMap)

      // First message creates the task
      const task = await onSendMessage(makeMessage('Start'))
      const taskId = task.id

      // Follow-up message
      const followUp = await onSendMessage(makeMessage('Continue'), taskId)

      expect(followUp.id).toBe(taskId)
      expect(followUp.messages).toHaveLength(2)

      // Only one queueWork call (for the initial message)
      expect(mockedQueueWork).toHaveBeenCalledOnce()
    })

    it('throws for follow-up to unknown task', async () => {
      const { onSendMessage } = createA2aCallbackBridge(taskMap)

      await expect(
        onSendMessage(makeMessage('hello'), 'unknown-task'),
      ).rejects.toThrow('Task not found: unknown-task')
    })
  })

  // ---------------------------------------------------------------------------
  // onGetTask
  // ---------------------------------------------------------------------------

  describe('onGetTask', () => {
    it('returns correct A2A state for each session status', async () => {
      const { onSendMessage, onGetTask } = createA2aCallbackBridge(taskMap)

      const task = await onSendMessage(makeMessage('hello'))
      const taskId = task.id
      const sessionId = taskMap.getSessionId(taskId)!

      // Test each status mapping
      const statusMappings: Array<[string, string]> = [
        ['pending', 'submitted'],
        ['claimed', 'submitted'],
        ['running', 'working'],
        ['finalizing', 'working'],
        ['completed', 'completed'],
        ['failed', 'failed'],
        ['stopped', 'canceled'],
      ]

      for (const [sessionStatus, expectedA2a] of statusMappings) {
        mockedGetSessionState.mockResolvedValueOnce({
          trackerSessionId: sessionId,
        trackerProvider: 'linear',
          issueId: 'a2a-external',
          providerSessionId: null,
          worktreePath: '/tmp/test',
          status: sessionStatus as any,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })

        const result = await onGetTask(taskId)
        expect(result).not.toBeNull()
        expect(result!.status).toBe(expectedA2a)
        expect(result!.id).toBe(taskId)
      }
    })

    it('returns null for unknown task ID', async () => {
      const { onGetTask } = createA2aCallbackBridge(taskMap)
      const result = await onGetTask('unknown-task-id')
      expect(result).toBeNull()
    })

    it('returns submitted when no session state is found', async () => {
      const { onSendMessage, onGetTask } = createA2aCallbackBridge(taskMap)

      const task = await onSendMessage(makeMessage('hello'))
      mockedGetSessionState.mockResolvedValueOnce(null)

      const result = await onGetTask(task.id)
      expect(result).not.toBeNull()
      expect(result!.status).toBe('submitted')
    })

    it('includes stored messages in the response', async () => {
      const { onSendMessage, onGetTask } = createA2aCallbackBridge(taskMap)

      const message = makeMessage('Build feature X')
      const task = await onSendMessage(message)
      mockedGetSessionState.mockResolvedValueOnce(null)

      const result = await onGetTask(task.id)
      expect(result!.messages).toHaveLength(1)
      expect(result!.messages[0]).toEqual(message)
    })
  })

  // ---------------------------------------------------------------------------
  // onCancelTask
  // ---------------------------------------------------------------------------

  describe('onCancelTask', () => {
    it('cancels a running session and returns canceled state', async () => {
      const { onSendMessage, onCancelTask } = createA2aCallbackBridge(taskMap)

      const task = await onSendMessage(makeMessage('hello'))
      const sessionId = taskMap.getSessionId(task.id)!

      mockedGetSessionState.mockResolvedValueOnce({
        trackerSessionId: sessionId,
        trackerProvider: 'linear',
        issueId: 'a2a-external',
        providerSessionId: null,
        worktreePath: '/tmp/test',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const result = await onCancelTask(task.id)
      expect(result).not.toBeNull()
      expect(result!.status).toBe('canceled')
      expect(result!.id).toBe(task.id)
      expect(mockedUpdateSessionStatus).toHaveBeenCalledWith(sessionId, 'stopped')
    })

    it('returns null for unknown task ID', async () => {
      const { onCancelTask } = createA2aCallbackBridge(taskMap)
      const result = await onCancelTask('unknown-task-id')
      expect(result).toBeNull()
    })

    it('throws error for already-completed tasks', async () => {
      const { onSendMessage, onCancelTask } = createA2aCallbackBridge(taskMap)

      const task = await onSendMessage(makeMessage('hello'))
      const sessionId = taskMap.getSessionId(task.id)!

      mockedGetSessionState.mockResolvedValueOnce({
        trackerSessionId: sessionId,
        trackerProvider: 'linear',
        issueId: 'a2a-external',
        providerSessionId: null,
        worktreePath: '/tmp/test',
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      await expect(onCancelTask(task.id)).rejects.toThrow(
        'Cannot cancel task in completed state',
      )
    })

    it('throws error for already-failed tasks', async () => {
      const { onSendMessage, onCancelTask } = createA2aCallbackBridge(taskMap)

      const task = await onSendMessage(makeMessage('hello'))
      const sessionId = taskMap.getSessionId(task.id)!

      mockedGetSessionState.mockResolvedValueOnce({
        trackerSessionId: sessionId,
        trackerProvider: 'linear',
        issueId: 'a2a-external',
        providerSessionId: null,
        worktreePath: '/tmp/test',
        status: 'failed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      await expect(onCancelTask(task.id)).rejects.toThrow(
        'Cannot cancel task in failed state',
      )
    })

    it('handles missing session state gracefully', async () => {
      const { onSendMessage, onCancelTask } = createA2aCallbackBridge(taskMap)

      const task = await onSendMessage(makeMessage('hello'))
      mockedGetSessionState.mockResolvedValueOnce(null)

      const result = await onCancelTask(task.id)
      expect(result).not.toBeNull()
      expect(result!.status).toBe('canceled')
      // Should not call updateSessionStatus when session doesn't exist
      expect(mockedUpdateSessionStatus).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Task ID ↔ Session ID mapping consistency
  // ---------------------------------------------------------------------------

  describe('bidirectional mapping consistency', () => {
    it('maintains consistent mapping through full lifecycle', async () => {
      const { onSendMessage, onGetTask, onCancelTask } = createA2aCallbackBridge(taskMap)

      // Create
      const task = await onSendMessage(makeMessage('hello'))
      const taskId = task.id
      const sessionId = taskMap.getSessionId(taskId)!

      expect(taskMap.getTaskId(sessionId)).toBe(taskId)
      expect(taskMap.getSessionId(taskId)).toBe(sessionId)

      // Get
      mockedGetSessionState.mockResolvedValueOnce({
        trackerSessionId: sessionId,
        trackerProvider: 'linear',
        issueId: 'a2a-external',
        providerSessionId: null,
        worktreePath: '/tmp/test',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const retrieved = await onGetTask(taskId)
      expect(retrieved!.id).toBe(taskId)

      // Cancel
      mockedGetSessionState.mockResolvedValueOnce({
        trackerSessionId: sessionId,
        trackerProvider: 'linear',
        issueId: 'a2a-external',
        providerSessionId: null,
        worktreePath: '/tmp/test',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const canceled = await onCancelTask(taskId)
      expect(canceled!.id).toBe(taskId)
      expect(canceled!.status).toBe('canceled')
    })
  })
})
