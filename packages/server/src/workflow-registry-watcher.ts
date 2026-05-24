/**
 * WorkflowRegistryWatcher — Hot-reload for WorkflowRegistry via Redis pub/sub
 *
 * Listens for workflow change events published by the WorkflowStore and
 * automatically reloads the WorkflowRegistry when a matching workflow is
 * saved or updated.
 *
 * Falls back to polling the store at a configurable interval when
 * the Redis pub/sub subscription cannot be established.
 */

import { validateWorkflowDefinition } from '@donmai/core'
import type { WorkflowDefinition } from '@donmai/core'
import {
  subscribeToWorkflowChanges,
  workflowStoreGet,
} from './workflow-store.js'
import type { WorkflowChangeEvent } from './workflow-store.js'
import { createLogger } from './logger.js'

const log = createLogger('workflow-registry-watcher')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowRegistryWatcherConfig {
  /** The registry to update on changes */
  registry: { setWorkflow: (workflow: WorkflowDefinition) => void }
  /** Polling interval in ms as fallback (default: 30000) */
  pollingInterval?: number
  /** Workflow ID to watch (default: 'default') */
  workflowId?: string
}

// ---------------------------------------------------------------------------
// Watcher Factory
// ---------------------------------------------------------------------------

/**
 * Watch for workflow changes via Redis pub/sub and reload the registry.
 * Falls back to polling when pub/sub is unavailable.
 *
 * @returns An object with a `stop()` method to tear down the watcher
 */
export async function createWorkflowRegistryWatcher(
  config: WorkflowRegistryWatcherConfig,
): Promise<{ stop: () => Promise<void> }> {
  const {
    registry,
    pollingInterval = 30_000,
    workflowId = 'default',
  } = config

  let unsubscribe: (() => Promise<void>) | null = null
  let pollingTimer: ReturnType<typeof setInterval> | null = null
  let lastKnownVersion: number | null = null
  let usePubSub = false

  // -----------------------------------------------------------------------
  // Reload helper
  // -----------------------------------------------------------------------

  async function reloadWorkflow(): Promise<void> {
    try {
      const stored = await workflowStoreGet(workflowId)
      if (!stored) {
        log.warn('Workflow not found in store during reload', { workflowId })
        return
      }

      // Skip if version hasn't changed
      if (lastKnownVersion !== null && stored.version === lastKnownVersion) {
        return
      }

      const validated = validateWorkflowDefinition(stored.definition)
      registry.setWorkflow(validated)
      lastKnownVersion = stored.version
      log.info('Workflow reloaded', { workflowId, version: stored.version })
    } catch (err) {
      log.warn('Failed to reload workflow', { workflowId, error: err })
    }
  }

  // -----------------------------------------------------------------------
  // Pub/Sub handler
  // -----------------------------------------------------------------------

  function handleChangeEvent(event: WorkflowChangeEvent): void {
    if (event.id !== workflowId) return

    if (event.action === 'save') {
      // Fire-and-forget reload; errors are logged inside reloadWorkflow
      void reloadWorkflow()
    } else if (event.action === 'delete') {
      log.warn('Watched workflow was deleted — keeping current definition for in-flight executions', {
        workflowId,
      })
    }
  }

  // -----------------------------------------------------------------------
  // Try pub/sub, fall back to polling
  // -----------------------------------------------------------------------

  try {
    unsubscribe = await subscribeToWorkflowChanges(handleChangeEvent)
    usePubSub = true
    log.info('Subscribed to workflow changes via pub/sub', { workflowId })
  } catch (err) {
    log.warn('Pub/sub subscription failed, falling back to polling', {
      workflowId,
      pollingInterval,
      error: err,
    })
  }

  if (!usePubSub) {
    // Load the initial version to seed lastKnownVersion
    try {
      const initial = await workflowStoreGet(workflowId)
      if (initial) {
        lastKnownVersion = initial.version
      }
    } catch {
      // Non-fatal: first poll will catch up
    }

    pollingTimer = setInterval(() => {
      void reloadWorkflow()
    }, pollingInterval)
  }

  // -----------------------------------------------------------------------
  // Stop / cleanup
  // -----------------------------------------------------------------------

  async function stop(): Promise<void> {
    if (pollingTimer !== null) {
      clearInterval(pollingTimer)
      pollingTimer = null
    }
    if (unsubscribe) {
      await unsubscribe()
      unsubscribe = null
    }
    log.info('Workflow registry watcher stopped', { workflowId })
  }

  return { stop }
}
