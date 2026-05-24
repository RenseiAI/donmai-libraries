/**
 * Redis Event Bus
 *
 * Production GovernorEventBus backed by Redis Streams.
 * Uses a consumer group for reliable delivery and horizontal scaling.
 *
 * Stream: `governor:events`
 * Consumer group: `governor-group`
 * MAXLEN: 10,000 (approximate trim)
 */

import type { GovernorEvent, GovernorEventBus } from '@donmai/core'
import { getRedisClient } from './redis.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RedisEventBusConfig {
  /** Redis stream key (default: 'governor:events') */
  streamKey?: string
  /** Consumer group name (default: 'governor-group') */
  groupName?: string
  /** Consumer name within the group (default: hostname or random) */
  consumerName?: string
  /** Max stream length — approximate trim (default: 10000) */
  maxLen?: number
  /** Block timeout in milliseconds for XREADGROUP (default: 5000) */
  blockMs?: number
}

const DEFAULT_STREAM_KEY = 'governor:events'
const DEFAULT_GROUP_NAME = 'governor-group'
const DEFAULT_MAX_LEN = 10_000
const DEFAULT_BLOCK_MS = 5_000

// ---------------------------------------------------------------------------
// RedisEventBus
// ---------------------------------------------------------------------------

export class RedisEventBus implements GovernorEventBus {
  private readonly streamKey: string
  private readonly groupName: string
  private readonly consumerName: string
  private readonly maxLen: number
  private readonly blockMs: number
  private closed = false
  private groupCreated = false

  constructor(config: RedisEventBusConfig = {}) {
    this.streamKey = config.streamKey ?? DEFAULT_STREAM_KEY
    this.groupName = config.groupName ?? DEFAULT_GROUP_NAME
    this.consumerName = config.consumerName ?? `governor-${process.pid}-${Date.now()}`
    this.maxLen = config.maxLen ?? DEFAULT_MAX_LEN
    this.blockMs = config.blockMs ?? DEFAULT_BLOCK_MS
  }

  /**
   * Ensure the consumer group exists. Idempotent — safe to call multiple times.
   */
  private async ensureGroup(): Promise<void> {
    if (this.groupCreated) return

    const redis = getRedisClient()
    try {
      await redis.xgroup('CREATE', this.streamKey, this.groupName, '0', 'MKSTREAM')
    } catch (err: unknown) {
      // BUSYGROUP = group already exists, which is fine
      if (err instanceof Error && !err.message.includes('BUSYGROUP')) {
        throw err
      }
    }
    this.groupCreated = true
  }

  async publish(event: GovernorEvent): Promise<string> {
    if (this.closed) {
      throw new Error('Event bus is closed')
    }

    const redis = getRedisClient()
    const payload = JSON.stringify(event)

    // XADD with approximate MAXLEN trim
    const id = await redis.xadd(
      this.streamKey,
      'MAXLEN',
      '~',
      String(this.maxLen),
      '*',
      'data',
      payload,
    )

    if (!id) {
      throw new Error('XADD returned null — stream write failed')
    }

    return id
  }

  async *subscribe(): AsyncGenerator<{ id: string; event: GovernorEvent }> {
    await this.ensureGroup()

    const redis = getRedisClient()

    // First, re-deliver any pending messages (from previous crash)
    yield* this.readPending(redis)

    // Then read new messages
    while (!this.closed) {
      try {
        const results = await redis.xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'COUNT',
          '1',
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.streamKey,
          '>',
        )

        if (!results || (results as unknown[]).length === 0) {
          continue // timeout, loop back
        }

        for (const [, messages] of results as Array<[string, Array<[string, string[]]>]>) {
          for (const [id, fields] of messages) {
            const event = this.parseEvent(fields)
            if (event) {
              yield { id, event }
            } else {
              // Malformed event — ack and skip
              await this.ack(id)
            }
          }
        }
      } catch (err) {
        if (this.closed) return
        // Log and continue on transient errors
        console.error('[redis-event-bus] Error reading from stream:', err)
        // Brief backoff before retry
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  async ack(eventId: string): Promise<void> {
    const redis = getRedisClient()
    await redis.xack(this.streamKey, this.groupName, eventId)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  // ---- Internal ----

  /**
   * Re-deliver pending messages (claimed but not acked from a previous run).
   */
  private async *readPending(
    redis: ReturnType<typeof getRedisClient>,
  ): AsyncGenerator<{ id: string; event: GovernorEvent }> {
    try {
      const results = await redis.xreadgroup(
        'GROUP',
        this.groupName,
        this.consumerName,
        'COUNT',
        '100',
        'STREAMS',
        this.streamKey,
        '0', // '0' = read pending messages
      )

      if (!results || (results as unknown[]).length === 0) return

      for (const [, messages] of results as Array<[string, Array<[string, string[]]>]>) {
        for (const [id, fields] of messages) {
          if (!fields || fields.length === 0) continue // already acked
          const event = this.parseEvent(fields)
          if (event) {
            yield { id, event }
          } else {
            await this.ack(id)
          }
        }
      }
    } catch (err) {
      console.error('[redis-event-bus] Error reading pending messages:', err)
    }
  }

  /**
   * Parse a Redis stream message fields array into a GovernorEvent.
   * Fields come as [key1, val1, key2, val2, ...].
   */
  private parseEvent(fields: string[]): GovernorEvent | null {
    try {
      // Find the 'data' field
      for (let i = 0; i < fields.length; i += 2) {
        if (fields[i] === 'data') {
          return JSON.parse(fields[i + 1]) as GovernorEvent
        }
      }
      return null
    } catch {
      return null
    }
  }
}
