import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@donmai/server', () => ({
  isRedisConfigured: vi.fn(),
  RedisPosteriorStore: vi.fn(),
  createRedisObservationStore: vi.fn(() => ({ recordObservation: vi.fn() })),
}))
vi.mock('@donmai/core', () => ({
  wrapEventsWithRecorder: vi.fn((events: unknown) => ({ ...(events as object), __wrapped: true })),
}))

import { withRoutingRecorder } from './routing-recorder'
import { isRedisConfigured, createRedisObservationStore } from '@donmai/server'
import { wrapEventsWithRecorder } from '@donmai/core'

type Events = Parameters<typeof withRoutingRecorder>[0]
const baseEvents = { onAgentComplete: vi.fn() } as unknown as Events

describe('withRoutingRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ROUTING_RECORDER_ENABLED
  })

  it('returns events unchanged (and never touches Redis) when ROUTING_RECORDER_ENABLED=false', () => {
    process.env.ROUTING_RECORDER_ENABLED = 'false'
    const out = withRoutingRecorder(baseEvents)
    expect(out).toBe(baseEvents)
    expect(isRedisConfigured).not.toHaveBeenCalled()
    expect(wrapEventsWithRecorder).not.toHaveBeenCalled()
  })

  it('returns events unchanged when Redis is not configured', () => {
    vi.mocked(isRedisConfigured).mockReturnValue(false)
    const out = withRoutingRecorder(baseEvents)
    expect(out).toBe(baseEvents)
    expect(wrapEventsWithRecorder).not.toHaveBeenCalled()
  })

  it('wraps events with the Redis stores when enabled and configured', () => {
    vi.mocked(isRedisConfigured).mockReturnValue(true)
    const out = withRoutingRecorder(baseEvents)
    expect(wrapEventsWithRecorder).toHaveBeenCalledWith(
      baseEvents,
      expect.objectContaining({
        observationStore: expect.anything(),
        posteriorStore: expect.anything(),
      }),
    )
    expect(out).not.toBe(baseEvents)
  })

  it('falls back to unwrapped events when store construction throws', () => {
    vi.mocked(isRedisConfigured).mockReturnValue(true)
    vi.mocked(createRedisObservationStore).mockImplementation(() => {
      throw new Error('redis down')
    })
    const out = withRoutingRecorder(baseEvents)
    expect(out).toBe(baseEvents)
  })
})
