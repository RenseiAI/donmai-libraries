import { describe, it, expect } from 'vitest'

/**
 * Subpath export resolution tests.
 *
 * Verifies that every subpath export defined in package.json resolves
 * to a module that exports the expected function. These tests catch:
 * - Missing `default` condition in exports map (breaks tsx/CJS loaders)
 * - Mismatched file paths between exports map and built output
 * - Missing or renamed function exports
 */

describe('@donmai/cli subpath exports', () => {
  it('exports runOrchestrator from ./orchestrator', { timeout: 15_000 }, async () => {
    const mod = await import('../lib/orchestrator-runner.js')
    expect(mod.runOrchestrator).toBeDefined()
    expect(typeof mod.runOrchestrator).toBe('function')
  })

  it('exports runWorker from ./worker', { timeout: 15_000 }, async () => {
    const mod = await import('../lib/worker-runner.js')
    expect(mod.runWorker).toBeDefined()
    expect(typeof mod.runWorker).toBe('function')
  })

  it('exports runWorkerFleet from ./worker-fleet', async () => {
    const mod = await import('../lib/worker-fleet-runner.js')
    expect(mod.runWorkerFleet).toBeDefined()
    expect(typeof mod.runWorkerFleet).toBe('function')
  })

  it('exports runCleanup from ./cleanup', async () => {
    const mod = await import('../lib/cleanup-runner.js')
    expect(mod.runCleanup).toBeDefined()
    expect(typeof mod.runCleanup).toBe('function')
  })

  it('exports runQueueAdmin from ./queue-admin', async () => {
    const mod = await import('../lib/queue-admin-runner.js')
    expect(mod.runQueueAdmin).toBeDefined()
    expect(typeof mod.runQueueAdmin).toBe('function')
  })

  it('exports runLogAnalyzer from ./analyze-logs', async () => {
    const mod = await import('../lib/analyze-logs-runner.js')
    expect(mod.runLogAnalyzer).toBeDefined()
    expect(typeof mod.runLogAnalyzer).toBe('function')
  })

  it('exports runLinear from ./linear', async () => {
    const mod = await import('../lib/linear-runner.js')
    expect(mod.runLinear).toBeDefined()
    expect(typeof mod.runLinear).toBe('function')
  })

  it('exports parseLinearArgs from ./linear', async () => {
    const mod = await import('../lib/linear-runner.js')
    expect(mod.parseLinearArgs).toBeDefined()
    expect(typeof mod.parseLinearArgs).toBe('function')
  })
})
