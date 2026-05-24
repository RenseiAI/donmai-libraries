import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn<
  (listener: (event: { action: string; id: string; version?: number }) => void) => Promise<() => Promise<void>>
>()

const mockWorkflowStoreGet = vi.fn()

vi.mock('./workflow-store.js', () => ({
  subscribeToWorkflowChanges: (...args: unknown[]) => mockSubscribe(...args as [any]),
  workflowStoreGet: (...args: unknown[]) => mockWorkflowStoreGet(...args as [any]),
}))

const mockValidate = vi.fn((data: unknown) => data)

vi.mock('@donmai/core', () => ({
  validateWorkflowDefinition: (...args: unknown[]) => mockValidate(...args as [any]),
}))

import { createWorkflowRegistryWatcher } from './workflow-registry-watcher.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoredWorkflow(version = 1) {
  return {
    definition: {
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'default' },
      phases: [{ name: 'dev', template: 'development' }],
      transitions: [{ from: 'Backlog', to: 'dev' }],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version,
  }
}

function createMockRegistry() {
  return { setWorkflow: vi.fn() }
}

/** Flush pending microtasks (resolved promises) */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => queueMicrotask(resolve))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow-registry-watcher', () => {
  let capturedListener: ((event: { action: string; id: string; version?: number }) => void) | null = null
  let mockUnsubscribe: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    capturedListener = null
    mockUnsubscribe = vi.fn().mockResolvedValue(undefined)

    // Default: subscription succeeds and captures the listener
    mockSubscribe.mockImplementation(async (listener) => {
      capturedListener = listener
      return mockUnsubscribe
    })

    // Default: store returns a workflow
    mockWorkflowStoreGet.mockResolvedValue(makeStoredWorkflow(1))

    // Default: validation passes through
    mockValidate.mockImplementation((data: unknown) => data)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -----------------------------------------------------------------------
  // Pub/Sub subscription
  // -----------------------------------------------------------------------

  it('creates watcher that subscribes to changes', async () => {
    const registry = createMockRegistry()
    const watcher = await createWorkflowRegistryWatcher({ registry })

    expect(mockSubscribe).toHaveBeenCalledOnce()
    expect(mockSubscribe).toHaveBeenCalledWith(expect.any(Function))

    await watcher.stop()
  })

  it('reloads registry on save event for watched workflow', async () => {
    const registry = createMockRegistry()
    const stored = makeStoredWorkflow(2)
    mockWorkflowStoreGet.mockResolvedValue(stored)

    const watcher = await createWorkflowRegistryWatcher({
      registry,
      workflowId: 'default',
    })

    // Simulate a save event
    capturedListener!({ action: 'save', id: 'default', version: 2 })

    // Flush the fire-and-forget promise chain
    await flushMicrotasks()
    await flushMicrotasks()

    expect(mockWorkflowStoreGet).toHaveBeenCalledWith('default')
    expect(mockValidate).toHaveBeenCalledWith(stored.definition)
    expect(registry.setWorkflow).toHaveBeenCalledWith(stored.definition)

    await watcher.stop()
  })

  it('ignores events for different workflow IDs', async () => {
    const registry = createMockRegistry()
    const watcher = await createWorkflowRegistryWatcher({
      registry,
      workflowId: 'default',
    })

    // Simulate a save event for a different workflow
    capturedListener!({ action: 'save', id: 'other-workflow', version: 1 })

    await flushMicrotasks()
    await flushMicrotasks()

    expect(mockWorkflowStoreGet).not.toHaveBeenCalled()
    expect(registry.setWorkflow).not.toHaveBeenCalled()

    await watcher.stop()
  })

  it('logs warning on delete but does not clear registry', async () => {
    const registry = createMockRegistry()
    const watcher = await createWorkflowRegistryWatcher({
      registry,
      workflowId: 'default',
    })

    // Simulate a delete event
    capturedListener!({ action: 'delete', id: 'default' })

    await flushMicrotasks()
    await flushMicrotasks()

    // Should NOT call setWorkflow (keeping current definition for in-flight)
    expect(registry.setWorkflow).not.toHaveBeenCalled()

    await watcher.stop()
  })

  // -----------------------------------------------------------------------
  // Polling fallback
  // -----------------------------------------------------------------------

  it('falls back to polling when subscription fails', async () => {
    vi.useFakeTimers()
    mockSubscribe.mockRejectedValue(new Error('REDIS_URL not set'))

    const registry = createMockRegistry()
    const stored = makeStoredWorkflow(1)
    mockWorkflowStoreGet.mockResolvedValue(stored)

    const watcher = await createWorkflowRegistryWatcher({
      registry,
      pollingInterval: 5000,
      workflowId: 'default',
    })

    // Initial version is seeded from the store
    expect(mockWorkflowStoreGet).toHaveBeenCalledWith('default')

    // Now simulate a version change
    const updatedStored = makeStoredWorkflow(2)
    mockWorkflowStoreGet.mockResolvedValue(updatedStored)

    // Advance past polling interval
    await vi.advanceTimersByTimeAsync(5001)

    expect(mockWorkflowStoreGet).toHaveBeenCalledTimes(2) // initial + 1 poll
    expect(registry.setWorkflow).toHaveBeenCalledWith(updatedStored.definition)

    await watcher.stop()
    vi.useRealTimers()
  })

  it('does not reload on poll when version has not changed', async () => {
    vi.useFakeTimers()
    mockSubscribe.mockRejectedValue(new Error('REDIS_URL not set'))

    const registry = createMockRegistry()
    const stored = makeStoredWorkflow(1)
    mockWorkflowStoreGet.mockResolvedValue(stored)

    const watcher = await createWorkflowRegistryWatcher({
      registry,
      pollingInterval: 5000,
      workflowId: 'default',
    })

    // Advance past polling interval — same version
    await vi.advanceTimersByTimeAsync(5001)

    // Should have called storeGet but NOT setWorkflow (version unchanged)
    expect(mockWorkflowStoreGet).toHaveBeenCalledTimes(2)
    expect(registry.setWorkflow).not.toHaveBeenCalled()

    await watcher.stop()
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  it('stop function cleans up pub/sub subscription', async () => {
    const registry = createMockRegistry()
    const watcher = await createWorkflowRegistryWatcher({ registry })

    await watcher.stop()

    expect(mockUnsubscribe).toHaveBeenCalledOnce()
  })

  it('stop function cleans up polling interval', async () => {
    vi.useFakeTimers()
    mockSubscribe.mockRejectedValue(new Error('REDIS_URL not set'))

    const registry = createMockRegistry()
    const watcher = await createWorkflowRegistryWatcher({
      registry,
      pollingInterval: 5000,
    })

    await watcher.stop()

    // After stop, advancing timers should not trigger any more polls
    const callCountAfterStop = mockWorkflowStoreGet.mock.calls.length
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mockWorkflowStoreGet.mock.calls.length).toBe(callCountAfterStop)

    vi.useRealTimers()
  })

  it('uses default workflowId of "default"', async () => {
    const registry = createMockRegistry()
    const stored = makeStoredWorkflow(2)
    mockWorkflowStoreGet.mockResolvedValue(stored)

    const watcher = await createWorkflowRegistryWatcher({ registry })

    capturedListener!({ action: 'save', id: 'default', version: 2 })

    await flushMicrotasks()
    await flushMicrotasks()

    expect(mockWorkflowStoreGet).toHaveBeenCalledWith('default')

    await watcher.stop()
  })

  it('handles store returning null gracefully on reload', async () => {
    const registry = createMockRegistry()
    mockWorkflowStoreGet.mockResolvedValue(null)

    const watcher = await createWorkflowRegistryWatcher({ registry })

    capturedListener!({ action: 'save', id: 'default', version: 1 })

    await flushMicrotasks()
    await flushMicrotasks()

    // Should not crash, should not call setWorkflow
    expect(registry.setWorkflow).not.toHaveBeenCalled()

    await watcher.stop()
  })

  it('handles validation errors gracefully on reload', async () => {
    const registry = createMockRegistry()
    mockWorkflowStoreGet.mockResolvedValue(makeStoredWorkflow(2))
    mockValidate.mockImplementation(() => {
      throw new Error('validation failed')
    })

    const watcher = await createWorkflowRegistryWatcher({ registry })

    capturedListener!({ action: 'save', id: 'default', version: 2 })

    await flushMicrotasks()
    await flushMicrotasks()

    // Should not crash, should not call setWorkflow
    expect(registry.setWorkflow).not.toHaveBeenCalled()

    await watcher.stop()
  })
})
