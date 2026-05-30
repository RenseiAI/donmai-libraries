import { wrapEventsWithRecorder, type OrchestratorEvents } from '@donmai/core'
import {
  RedisPosteriorStore,
  createRedisObservationStore,
  isRedisConfigured,
} from '@donmai/server'

/**
 * Router-learning A2 — WRITE side of the donmai provider×workType bandit.
 *
 * Wrap orchestrator events so terminal agent states (`onAgentComplete` /
 * `onAgentStopped` / `onAgentError` / `onAgentIncomplete`) record a routing
 * observation and update the provider×workType posterior in the Redis routing
 * store. Previously `wrapEventsWithRecorder` had no caller, so the store stayed
 * dark and `/api/public/routing-metrics` reported posteriors that never moved.
 *
 * Default ON when Redis is configured; opt out with `ROUTING_RECORDER_ENABLED=false`
 * (so it can ship dark-safe and be toggled per environment without a re-release).
 * Best-effort: if the stores can't be constructed, orchestration proceeds
 * unrecorded rather than failing. The recorder itself swallows per-observation
 * errors, so a transient Redis blip never blocks agent completion.
 *
 * Each agent fires exactly one terminal callback, so there is no cross-callback
 * double-count (unlike the platform A1 path, which spans two HTTP hooks).
 */
export function withRoutingRecorder(events: OrchestratorEvents): OrchestratorEvents {
  if (process.env.ROUTING_RECORDER_ENABLED === 'false') return events
  if (!isRedisConfigured()) return events
  try {
    return wrapEventsWithRecorder(events, {
      observationStore: createRedisObservationStore(),
      posteriorStore: new RedisPosteriorStore(),
    })
  } catch (err) {
    console.error('[routing] observation recorder disabled (init failed):', err)
    return events
  }
}
