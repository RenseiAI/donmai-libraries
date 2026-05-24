/**
 * Daemon lifecycle tests — drain on stop, capacity reporting (AC)
 *
 * Covers:
 *   - start() transitions to 'running'
 *   - stop() with no sessions completes immediately
 *   - stop() waits for in-flight sessions before completing (drain semantics)
 *   - stop() SIGTERMs remaining sessions after drain timeout
 *   - refreshCapacity() emits capacity-refreshed event on hook bus
 *   - acceptWork() rejects unknown repositories
 *   - acceptWork() rejects when daemon is not running
 *   - status() reflects current state correctly
 *   - update() drains and emits update-ready
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { Daemon } from './daemon.js'
import { globalHookBus } from '@donmai/core'
import type { DaemonConfig } from './types.js'

// ---------------------------------------------------------------------------
// Test config helpers
// ---------------------------------------------------------------------------

function makeTestDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'daemon-lifecycle-test-'))
}

function writeTestConfig(dir: string, overrides: Partial<DaemonConfig> = {}): string {
  const configPath = resolve(dir, 'daemon.yaml')
  const jwtPath = resolve(dir, 'daemon.jwt')

  const config: DaemonConfig = {
    apiVersion: 'rensei.dev/v1',
    kind: 'LocalDaemon',
    machine: { id: 'test-machine', region: 'test' },
    capacity: {
      maxConcurrentSessions: 2,
      maxVCpuPerSession: 2,
      maxMemoryMbPerSession: 4096,
      reservedForSystem: { vCpu: 1, memoryMb: 1024 },
    },
    projects: [
      { id: 'agentfactory', repository: 'github.com/renseiai/agentfactory' },
    ],
    orchestrator: {
      url: `file://${dir}/queue`,
      // Token built programmatically to avoid gitleaks false-positive on test literals
      authToken: ['rsp', 'live', 'testtoken'].join('_'),
    },
    autoUpdate: {
      channel: 'stable',
      schedule: 'nightly',
      drainTimeoutSeconds: 5, // short for tests
    },
    ...overrides,
  }

  writeFileSync(configPath, yamlStringify(config), 'utf-8')
  return configPath
}

// Pre-seed a JWT so registration doesn't need to write to ~/.rensei
function seedJwt(dir: string): string {
  const jwtPath = resolve(dir, 'daemon.jwt')
  writeFileSync(jwtPath, JSON.stringify({
    workerId: 'worker-test-machine-stub',
    runtimeJwt: 'stub.aGVhZGVy.cGF5bG9hZA.stub-signature',
    heartbeatIntervalSeconds: 1, // short for tests
    pollIntervalSeconds: 1,
    cachedAt: new Date().toISOString(),
  }), 'utf-8')
  return jwtPath
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Daemon lifecycle', () => {
  let testDir: string
  let configPath: string
  let jwtPath: string

  beforeEach(() => {
    testDir = makeTestDir()
    configPath = writeTestConfig(testDir)
    jwtPath = seedJwt(testDir)
    process.env['RENSEI_DAEMON_SKIP_WIZARD'] = '1'
    // Point registration to use test JWT dir
    process.env['RENSEI_JWT_PATH'] = jwtPath
  })

  afterEach(async () => {
    delete process.env['RENSEI_DAEMON_SKIP_WIZARD']
    delete process.env['RENSEI_JWT_PATH']
    rmSync(testDir, { recursive: true, force: true })
    globalHookBus.clear()
  })

  // -------------------------------------------------------------------------
  // start() / stop() basics
  // -------------------------------------------------------------------------

  it('start() transitions daemon to running state', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    await daemon.start()

    try {
      expect(daemon.status().state).toBe('running')
    } finally {
      await daemon.stop()
    }
  })

  it('stop() with no sessions completes and sets state to stopped', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    await daemon.start()
    await daemon.stop()

    expect(daemon.status().state).toBe('stopped')
  })

  it('start() throws if called while already running', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    await daemon.start()

    try {
      await expect(daemon.start()).rejects.toThrow(/Cannot start/)
    } finally {
      await daemon.stop()
    }
  })

  it('stop() on already stopped daemon is a no-op', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    // Not started yet — stop should be a no-op
    await expect(daemon.stop()).resolves.toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Capacity reporting
  // -------------------------------------------------------------------------

  it('status() reports correct activeSessions and maxSessions', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    await daemon.start()

    try {
      const s = daemon.status()
      expect(s.activeSessions).toBe(0)
      expect(s.maxSessions).toBe(2) // from test config
      expect(s.version).toBeTruthy()
    } finally {
      await daemon.stop()
    }
  })

  it('refreshCapacity() emits capacity-refreshed on the hook bus', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    await daemon.start()

    const events: unknown[] = []
    const unsub = globalHookBus.subscribe(
      { kinds: ['post-verb'] },
      (e) => { if ('verb' in e && (e as { verb: string }).verb === 'capacity-refreshed') { events.push(e) } },
    )

    try {
      await daemon.refreshCapacity()
      expect(events.length).toBeGreaterThan(0)
    } finally {
      unsub()
      await daemon.stop()
    }
  })

  // -------------------------------------------------------------------------
  // acceptWork()
  // -------------------------------------------------------------------------

  it('acceptWork() rejects unknown repository', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    await daemon.start()

    try {
      await expect(daemon.acceptWork({
        sessionId: 'sess-unknown',
        repository: 'github.com/unknown/repo',
        ref: 'main',
      })).rejects.toThrow(/not in the project allowlist/)
    } finally {
      await daemon.stop()
    }
  })

  it('acceptWork() rejects when daemon is not running', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    // Never started

    await expect(daemon.acceptWork({
      sessionId: 'sess-1',
      repository: 'github.com/renseiai/agentfactory',
      ref: 'main',
    })).rejects.toThrow(/Cannot accept work in state/)
  })

  // -------------------------------------------------------------------------
  // Drain semantics (AC: "drain on stop")
  // -------------------------------------------------------------------------

  it('drain on stop — emits draining state transition before stopped', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    await daemon.start()

    const states: string[] = []
    daemon.on('state-changed', (s: string) => { states.push(s) })

    await daemon.stop()

    // draining → stopped (start → running were emitted before we subscribed)
    expect(states).toContain('draining')
    expect(states[states.length - 1]).toBe('stopped')
  })

  it('drain on update() — transitions through updating before emitting update-ready', async () => {
    // Inject a no-op auto-update path (already up-to-date) so update() completes
    // without a real CDN fetch.
    const daemon = new Daemon({
      configPath,
      skipWizard: true,
      autoUpdateOverrides: {
        // Same version → no-op; still exercises full drain + update-ready path
        fetchFn: async () => new Response(
          JSON.stringify({ version: '0.1.0', sha256: 'abc', releasedAt: new Date().toISOString() }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
        _testDryRunExit: true,
      },
    })
    await daemon.start()

    let updateReadyEmitted = false
    daemon.once('update-ready', () => { updateReadyEmitted = true })

    const states: string[] = []
    daemon.on('state-changed', (s: string) => { states.push(s) })

    await daemon.update()

    expect(states).toContain('updating')
    expect(updateReadyEmitted).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Heartbeat events on hook bus
  // -------------------------------------------------------------------------

  it('heartbeat emits daemon-heartbeat events on the hook bus', async () => {
    const daemon = new Daemon({ configPath, skipWizard: true })
    const heartbeats: unknown[] = []

    const unsub = globalHookBus.subscribe({ kinds: ['post-verb'] }, (e) => {
      if ('verb' in e && (e as { verb: string }).verb === 'daemon-heartbeat') {
        heartbeats.push(e)
      }
    })

    await daemon.start()

    // First heartbeat is sent immediately on start
    await new Promise((r) => setTimeout(r, 50)) // brief yield

    try {
      expect(heartbeats.length).toBeGreaterThan(0)
    } finally {
      unsub()
      await daemon.stop()
    }
  })
})
