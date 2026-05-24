import { vi } from 'vitest'
import type {
  AgentProvider,
  AgentHandle,
  AgentEvent,
  AgentProviderName,
} from '@donmai/core'

export function createMockAgentHandle(events: AgentEvent[] = []): AgentHandle {
  return {
    sessionId: 'mock-session-id',
    stream: (async function* () {
      for (const event of events) {
        yield event
      }
    })(),
    injectMessage: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }
}

export function createMockProvider(name: AgentProviderName = 'claude'): AgentProvider {
  const handle = createMockAgentHandle()
  return {
    name,
    capabilities: {
      supportsMessageInjection: name === 'claude' || name === 'a2a',
      supportsSessionResume: true,
      emitsSubagentEvents: name === 'claude',
    },
    spawn: vi.fn().mockReturnValue(handle),
    resume: vi.fn().mockReturnValue(handle),
  }
}
