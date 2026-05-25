import type {
  AgentInitEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  AgentResultEvent,
  AgentErrorEvent,
} from '@donmai/core'

export function makeInitEvent(overrides: Partial<AgentInitEvent> = {}): AgentInitEvent {
  return {
    type: 'init',
    sessionId: 'test-session-id',
    raw: {},
    ...overrides,
  }
}

export function makeToolUseEvent(overrides: Partial<AgentToolUseEvent> = {}): AgentToolUseEvent {
  return {
    type: 'tool_use',
    toolName: 'Bash',
    input: { command: 'echo hello' },
    raw: {},
    ...overrides,
  }
}

export function makeToolResultEvent(overrides: Partial<AgentToolResultEvent> = {}): AgentToolResultEvent {
  return {
    type: 'tool_result',
    content: 'hello',
    isError: false,
    raw: {},
    ...overrides,
  }
}

export function makeResultEvent(overrides: Partial<AgentResultEvent> = {}): AgentResultEvent {
  return {
    type: 'result',
    success: true,
    message: 'Work completed successfully',
    cost: { inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.05, numTurns: 10 },
    raw: {},
    ...overrides,
  }
}

export function makeErrorEvent(overrides: Partial<AgentErrorEvent> = {}): AgentErrorEvent {
  return {
    type: 'error',
    message: 'Something went wrong',
    raw: {},
    ...overrides,
  }
}
