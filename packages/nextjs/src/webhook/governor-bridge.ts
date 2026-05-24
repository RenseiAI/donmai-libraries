/**
 * Governor Bridge
 *
 * Connects webhook handlers to the GovernorEventBus. When configured,
 * webhook handlers publish events to the bus in addition to (or instead of)
 * their normal direct-dispatch behavior.
 */

import type { GovernorEventBus, GovernorEvent } from '@donmai/core'

let _eventBus: GovernorEventBus | null = null

/**
 * Configure the governor event bus for webhook bridging.
 * Call this during server initialization when governorMode != 'direct'.
 */
export function setGovernorEventBus(bus: GovernorEventBus): void {
  _eventBus = bus
}

/**
 * Get the configured event bus, or null if not configured.
 */
export function getGovernorEventBus(): GovernorEventBus | null {
  return _eventBus
}

/**
 * Publish a GovernorEvent if a bus is configured.
 * Returns the event ID if published, null if no bus is configured.
 */
export async function publishGovernorEvent(event: GovernorEvent): Promise<string | null> {
  if (!_eventBus) return null
  try {
    return await _eventBus.publish(event)
  } catch (err) {
    console.error('[governor-bridge] Failed to publish event:', err)
    return null
  }
}
