/**
 * Redis Streams Observation Store
 *
 * Append-only log of routing observations backed by Redis Streams.
 * Uses XADD / XRANGE / XREVRANGE for durable, ordered storage with
 * configurable stream trimming via MAXLEN ~.
 */

import { getRedisClient, isRedisConfigured } from './redis.js'
import type { ObservationStore, ObservationQueryResult } from '@donmai/core'
import { ROUTING_KEYS } from '@donmai/core'
import type { RoutingObservation } from '@donmai/core'
import type { AgentProviderName } from '@donmai/core'
import type { AgentWorkType } from '@donmai/core'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/** Default maximum stream length for MAXLEN ~ trimming */
const DEFAULT_MAX_STREAM_LENGTH = 10_000

/**
 * Serialize a RoutingObservation into flat string key-value pairs
 * suitable for Redis Streams (which require all values to be strings).
 */
function serializeObservation(obs: RoutingObservation): string[] {
  const fields: string[] = [
    'id', obs.id,
    'provider', obs.provider,
    'workType', obs.workType,
    'issueIdentifier', obs.issueIdentifier,
    'sessionId', obs.sessionId,
    'reward', String(obs.reward),
    'taskCompleted', String(obs.taskCompleted),
    'prCreated', String(obs.prCreated),
    'qaResult', obs.qaResult,
    'totalCostUsd', String(obs.totalCostUsd),
    'wallClockMs', String(obs.wallClockMs),
    'timestamp', String(obs.timestamp),
    'confidence', String(obs.confidence),
  ]

  if (obs.project !== undefined) {
    fields.push('project', obs.project)
  }

  if (obs.explorationReason !== undefined) {
    fields.push('explorationReason', obs.explorationReason)
  }

  return fields
}

/**
 * Deserialize a flat string map from a Redis Stream entry back into
 * a RoutingObservation object.
 */
function deserializeObservation(fields: Record<string, string>): RoutingObservation {
  return {
    id: fields.id!,
    provider: fields.provider! as AgentProviderName,
    workType: fields.workType! as AgentWorkType,
    issueIdentifier: fields.issueIdentifier!,
    sessionId: fields.sessionId!,
    reward: Number(fields.reward),
    taskCompleted: fields.taskCompleted === 'true',
    prCreated: fields.prCreated === 'true',
    qaResult: fields.qaResult! as RoutingObservation['qaResult'],
    totalCostUsd: Number(fields.totalCostUsd),
    wallClockMs: Number(fields.wallClockMs),
    timestamp: Number(fields.timestamp),
    confidence: Number(fields.confidence),
    ...(fields.project !== undefined ? { project: fields.project } : {}),
    ...(fields.explorationReason !== undefined ? { explorationReason: fields.explorationReason } : {}),
  }
}

interface ParsedEntry {
  streamId: string
  observation: RoutingObservation
}

/**
 * Parse Redis Stream entries (returned as [id, [field, value, ...]][])
 * into observation objects with their stream IDs preserved for cursor pagination.
 */
function parseStreamEntries(entries: [string, string[]][]): ParsedEntry[] {
  return entries.map(([streamId, flatFields]) => {
    const fields: Record<string, string> = {}
    for (let i = 0; i < flatFields.length; i += 2) {
      fields[flatFields[i]!] = flatFields[i + 1]!
    }
    return { streamId, observation: deserializeObservation(fields) }
  })
}

/**
 * Decrement a Redis Stream ID by one sequence number for exclusive cursor bounds.
 * Stream IDs have format "{ms}-{seq}". We decrement the sequence.
 */
function decrementStreamId(id: string): string {
  const [ms, seq] = id.split('-')
  const seqNum = Number(seq)
  if (seqNum > 0) {
    return `${ms}-${seqNum - 1}`
  }
  // If seq is 0, move to previous millisecond with max sequence
  return `${Number(ms) - 1}-18446744073709551615`
}

export interface RedisObservationStoreOptions {
  /** Maximum stream length for MAXLEN ~ trimming (default: 10,000) */
  maxStreamLength?: number
}

/**
 * Create a Redis Streams–backed ObservationStore.
 *
 * When Redis is not configured the store degrades gracefully:
 * - recordObservation is a no-op (logs a warning once)
 * - getObservations / getRecentObservations return empty arrays
 */
export function createRedisObservationStore(
  options: RedisObservationStoreOptions = {},
): ObservationStore {
  const maxLen = options.maxStreamLength ?? DEFAULT_MAX_STREAM_LENGTH
  const streamKey = ROUTING_KEYS.observations

  const store: ObservationStore = {
    async recordObservation(obs: RoutingObservation): Promise<void> {
      if (!isRedisConfigured()) {
        log.warn('Redis not configured, observation will not be persisted')
        return
      }

      try {
        const client = getRedisClient()
        const fields = serializeObservation(obs)
        await client.xadd(streamKey, 'MAXLEN', '~', String(maxLen), '*', ...fields)
        log.info('Recorded observation', {
          id: obs.id,
          provider: obs.provider,
          workType: obs.workType,
        })
      } catch (err) {
        log.error('Failed to record observation', {
          id: obs.id,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    async getObservations(opts: {
      provider?: AgentProviderName
      workType?: AgentWorkType
      limit?: number
      since?: number
      from?: number
      to?: number
      cursor?: string
    }): Promise<ObservationQueryResult> {
      if (!isRedisConfigured()) {
        log.debug('Redis not configured, returning empty observations')
        return { observations: [] }
      }

      try {
        const client = getRedisClient()
        const limit = opts.limit ?? 50

        // XREVRANGE returns entries newest-first (descending).
        // Range is (end, start) in XREVRANGE: high bound first, low bound second.
        let highBound = '+'
        let lowBound = '-'

        // Time-range: from/to narrow the window
        if (opts.to) {
          highBound = `${opts.to}-18446744073709551615`
        }
        if (opts.from) {
          lowBound = `${opts.from}-0`
        }

        // Legacy since support (maps to lowBound)
        if (opts.since && !opts.from) {
          lowBound = `${opts.since}-0`
        }

        // Cursor: start just before the last-seen entry (exclusive)
        if (opts.cursor) {
          highBound = decrementStreamId(opts.cursor)
        }

        // Fetch more than limit to account for application-level filtering
        const fetchCount = Math.min(limit * 3 + 1, maxLen)

        const raw = await client.xrevrange(streamKey, highBound, lowBound, 'COUNT', fetchCount)
        let entries = parseStreamEntries(raw as [string, string[]][])

        // Apply application-level filters (Redis Streams don't support field filtering)
        if (opts.provider) {
          entries = entries.filter((e) => e.observation.provider === opts.provider)
        }
        if (opts.workType) {
          entries = entries.filter((e) => e.observation.workType === opts.workType)
        }

        // Take limit+1 to detect if there are more results
        const hasMore = entries.length > limit
        const page = entries.slice(0, limit)

        const result: ObservationQueryResult = {
          observations: page.map((e) => e.observation),
        }

        if (hasMore && page.length > 0) {
          result.nextCursor = page[page.length - 1]!.streamId
        }

        return result
      } catch (err) {
        log.error('Failed to get observations', {
          error: err instanceof Error ? err.message : String(err),
        })
        return { observations: [] }
      }
    },

    async getRecentObservations(
      provider: AgentProviderName,
      workType: AgentWorkType,
      windowSize: number,
    ): Promise<RoutingObservation[]> {
      if (!isRedisConfigured()) {
        log.debug('Redis not configured, returning empty recent observations')
        return []
      }

      try {
        const client = getRedisClient()

        // XREVRANGE returns entries newest-first
        // Fetch more than windowSize to account for filtering by provider/workType
        const fetchCount = Math.min(windowSize * 5, maxLen)

        const raw = await client.xrevrange(streamKey, '+', '-', 'COUNT', fetchCount)
        const entries = parseStreamEntries(raw as [string, string[]][])

        // Filter by provider + workType, then take windowSize entries
        const filtered = entries
          .filter((e) => e.observation.provider === provider && e.observation.workType === workType)
          .map((e) => e.observation)
          .slice(0, windowSize)

        return filtered
      } catch (err) {
        log.error('Failed to get recent observations', {
          provider,
          workType,
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    },
  }

  return store
}
