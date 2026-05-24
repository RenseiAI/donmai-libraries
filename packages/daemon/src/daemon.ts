/**
 * Daemon — core lifecycle implementation.
 *
 * Architecture reference:
 *   rensei-architecture/004-sandbox-capability-matrix.md §Daemon lifecycle
 *   rensei-architecture/011-local-daemon-fleet.md
 *
 * Lifecycle methods:
 *   start()            — boot, load config, register, start heartbeat
 *   refreshCapacity()  — re-report capacity to orchestrator (called every 60s)
 *   acceptWork(spec)   — validate + spawn a worker for the given session spec
 *   update()           — drain in-flight work, then restart with new binary
 *   stop()             — graceful shutdown with drain semantics
 *
 * The daemon implements SandboxProvider-equivalent behavior for the local
 * machine: one per machine, multi-project, dial-out registration, JWTed calls.
 */

import { EventEmitter } from 'node:events'
import type { DaemonConfig, SessionSpec, SessionHandle, DaemonStatus, DaemonState, DaemonRegistrationStatus } from './types.js'
import { loadConfig, writeConfig, DEFAULT_CONFIG_PATH } from './config.js'
import { register } from './registration.js'
import { HeartbeatService } from './heartbeat.js'
import { WorkerSpawner, createStubSpawner } from './worker-spawner.js'
import { runSetupWizard, shouldSkipWizard, buildDefaultConfig } from './setup-wizard.js'
import { globalHookBus } from '@donmai/core'
import { AutoUpdater } from './auto-update.js'
import type { AutoUpdateOptions } from './auto-update.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to call refreshCapacity (ms). Default: 60s per spec. */
const CAPACITY_REFRESH_INTERVAL_MS = 60_000

/** Daemon package version — kept in sync with package.json. */
export const DAEMON_VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Daemon options
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  /** Path to daemon.yaml. Defaults to ~/.rensei/daemon.yaml. */
  configPath?: string
  /** Worker script to spawn per session. Defaults to stub. */
  workerScript?: string
  /** Skip setup wizard even in TTY environments. */
  skipWizard?: boolean
  /**
   * Options forwarded to AutoUpdater.
   * Used in tests to inject a mock fetch / verifier without a real CDN call.
   */
  autoUpdateOverrides?: Partial<AutoUpdateOptions>
}

// ---------------------------------------------------------------------------
// Daemon class
// ---------------------------------------------------------------------------

/**
 * Core daemon service. Manages the full lifecycle: registration, heartbeat,
 * capacity reporting, work acceptance, drain, and update.
 *
 * Extends EventEmitter to allow external listeners (e.g., the CLI) to react
 * to state transitions without polling.
 *
 * Events:
 *   'state-changed'  (state: DaemonState) — emitted on every state transition
 *   'session-started' (handle: SessionHandle) — a new session was accepted
 *   'session-ended'  (handle: SessionHandle) — a session completed/failed
 *   'error'          (err: Error) — non-fatal errors that callers may log
 */
export class Daemon extends EventEmitter {
  private _state: DaemonState = 'stopped'
  private _config: DaemonConfig | null = null
  private _workerId: string | null = null
  private _runtimeJwt: string | null = null
  private _heartbeat: HeartbeatService | null = null
  private _spawner: WorkerSpawner | null = null
  private _capacityTimer: ReturnType<typeof setInterval> | null = null
  private readonly _opts: DaemonOptions

  constructor(opts: DaemonOptions = {}) {
    super()
    this._opts = opts
  }

  // ---------------------------------------------------------------------------
  // start() — boot sequence
  // ---------------------------------------------------------------------------

  /**
   * Start the daemon:
   *   1. Load (or create) config from ~/.rensei/daemon.yaml.
   *   2. Run first-run setup wizard if needed.
   *   3. Register with the orchestrator; exchange rsp_live_* token for JWT.
   *   4. Start the heartbeat loop.
   *   5. Start the capacity-refresh polling loop.
   */
  async start(): Promise<void> {
    if (this._state !== 'stopped') {
      throw new Error(`[daemon] Cannot start — current state is '${this._state}'`)
    }

    this._setState('starting')

    // -----------------------------------------------------------------------
    // 1. Load config (or run wizard on first run)
    // -----------------------------------------------------------------------
    const configPath = this._opts.configPath ?? DEFAULT_CONFIG_PATH
    let config = loadConfig(configPath)

    if (!config) {
      // First run — run setup wizard or build default config
      if (!this._opts.skipWizard && !shouldSkipWizard()) {
        config = await runSetupWizard(undefined, configPath)
      } else {
        config = buildDefaultConfig(undefined, configPath)
      }
    }

    this._config = config

    // -----------------------------------------------------------------------
    // 2. Register with the orchestrator
    // -----------------------------------------------------------------------
    // Fallback sentinel for no-config/local-queue mode — recognized by registration.ts as stub path
    const authToken = config.orchestrator.authToken ?? process.env['RENSEI_DAEMON_TOKEN'] ?? 'local-stub-no-token'

    const registerResponse = await register({
      orchestratorUrl: config.orchestrator.url,
      registrationToken: authToken,
      hostname: config.machine.id,
      version: DAEMON_VERSION,
      maxAgents: config.capacity.maxConcurrentSessions,
      capabilities: ['local', 'sandbox', 'workarea'],
      region: config.machine.region,
    })

    this._workerId = registerResponse.workerId
    this._runtimeJwt = registerResponse.runtimeJwt

    // -----------------------------------------------------------------------
    // 3. Initialise worker spawner
    // -----------------------------------------------------------------------
    this._spawner = createStubSpawner({
      projects: config.projects,
      maxConcurrentSessions: config.capacity.maxConcurrentSessions,
      baseEnv: {
        RENSEI_WORKER_ID: this._workerId,
        RENSEI_ORCHESTRATOR_URL: config.orchestrator.url,
      },
    })

    this._spawner.on('session-started', (handle: SessionHandle) => {
      this.emit('session-started', handle)
      void globalHookBus.emit({
        kind: 'post-verb',
        provider: { family: 'sandbox', id: 'rensei-daemon', version: DAEMON_VERSION },
        verb: 'session-accepted',
        result: { session_id: handle.sessionId, pid: handle.pid },
        durationMs: 0,
      })
    })

    this._spawner.on('session-ended', (handle: SessionHandle) => {
      this.emit('session-ended', handle)
    })

    // -----------------------------------------------------------------------
    // 4. Start heartbeat loop
    // -----------------------------------------------------------------------
    this._heartbeat = new HeartbeatService({
      workerId: this._workerId,
      hostname: config.machine.id,
      orchestratorUrl: config.orchestrator.url,
      runtimeJwt: this._runtimeJwt,
      intervalSeconds: registerResponse.heartbeatIntervalSeconds,
      getActiveCount: () => this._spawner?.activeCount ?? 0,
      getMaxCount: () => config!.capacity.maxConcurrentSessions,
      getStatus: () => this._registrationStatus(),
      region: config.machine.region,
    })
    this._heartbeat.start()

    // -----------------------------------------------------------------------
    // 5. Start capacity-refresh loop
    // -----------------------------------------------------------------------
    this._capacityTimer = setInterval(() => {
      void this.refreshCapacity()
    }, CAPACITY_REFRESH_INTERVAL_MS)

    this._setState('running')

    void globalHookBus.emit({
      kind: 'post-activate',
      provider: { family: 'sandbox', id: 'rensei-daemon', version: DAEMON_VERSION },
      durationMs: 0,
    })
  }

  // ---------------------------------------------------------------------------
  // refreshCapacity() — periodic capacity report
  // ---------------------------------------------------------------------------

  /**
   * Refresh the daemon's capacity report. Called every 60s automatically,
   * and on-demand when capacity changes significantly.
   *
   * Emits a capacity-snapshot event on the hook bus for observability.
   * When the real orchestrator endpoint exists, also sends a PATCH
   * /v1/daemon/capacity request.
   */
  async refreshCapacity(): Promise<void> {
    if (!this._config || !this._workerId) return

    const snapshot = this._buildCapacitySnapshot()

    await globalHookBus.emit({
      kind: 'post-verb',
      provider: { family: 'sandbox', id: 'rensei-daemon', version: DAEMON_VERSION },
      verb: 'capacity-refreshed',
      result: snapshot,
      durationMs: 0,
    })
  }

  // ---------------------------------------------------------------------------
  // acceptWork() — dispatch a session to a worker
  // ---------------------------------------------------------------------------

  /**
   * Accept a work specification from the orchestrator and spawn a worker.
   *
   * @param spec - Session specification dispatched by the orchestrator.
   * @returns A SessionHandle for the spawned worker process.
   * @throws If the daemon is not running, at capacity, or the project is not allowed.
   */
  async acceptWork(spec: SessionSpec): Promise<SessionHandle> {
    if (this._state !== 'running') {
      throw new Error(`[daemon] Cannot accept work in state '${this._state}'`)
    }
    if (!this._spawner) {
      throw new Error('[daemon] Spawner not initialized')
    }
    return this._spawner.acceptWork(spec)
  }

  // ---------------------------------------------------------------------------
  // update() — drain + restart
  // ---------------------------------------------------------------------------

  /**
   * Trigger a daemon self-update:
   *   1. Set state to 'updating'.
   *   2. Stop accepting new work (status → 'draining' in orchestrator).
   *   3. Wait for in-flight sessions to drain (up to drainTimeoutSeconds).
   *      Straggler sessions receive SIGTERM after the timeout; their workareas
   *      are released with mode: archive for post-mortem inspection.
   *   4. Stop heartbeat and capacity loops.
   *   5. Run the auto-update flow (AutoUpdater):
   *      a. Check CDN for a newer version on the configured channel.
   *      b. Download the binary + detached signature.
   *      c. Verify the signature via sigstore (REN-1314). Reject if invalid.
   *      d. Atomically swap the binary at the install path.
   *      e. Exit with EXIT_CODE_RESTART (3) — the launchd / systemd supervisor
   *         re-execs the new binary. (Skipped in dry-run / test mode.)
   *   6. Emit 'update-ready' for callers that don't wait for process restart.
   *
   * Restart contract:
   *   The daemon exits with exit code 3 (EXIT_CODE_RESTART). The launchd plist
   *   (REN-1292) and systemd unit (REN-1293) treat code 3 as a clean
   *   "restart-requested" — they re-exec the new binary without incrementing
   *   the crash counter. Code 0 = clean stop, non-0/non-3 = error crash.
   */
  async update(): Promise<void> {
    if (this._state === 'stopped') {
      throw new Error('[daemon] Cannot update — daemon is not running')
    }

    this._setState('updating')

    const autoUpdateConfig = this._config?.autoUpdate ?? {
      channel: 'stable' as const,
      schedule: 'nightly' as const,
      drainTimeoutSeconds: 600,
    }
    const drainTimeout = autoUpdateConfig.drainTimeoutSeconds * 1000
    await this._drain(drainTimeout)

    this._teardownLoops()

    void globalHookBus.emit({
      kind: 'post-verb',
      provider: { family: 'sandbox', id: 'rensei-daemon', version: DAEMON_VERSION },
      verb: 'update-drain-complete',
      result: { version: DAEMON_VERSION },
      durationMs: 0,
    })

    // Run the full binary-swap auto-update flow
    const updater = new AutoUpdater({
      currentVersion: DAEMON_VERSION,
      config: autoUpdateConfig,
      ...this._opts.autoUpdateOverrides,
    })

    // Forward updater events so callers can observe progress
    updater.on('check-start', () => this.emit('update-check-start'))
    updater.on('up-to-date', (e: unknown) => this.emit('update-up-to-date', e))
    updater.on('download-start', (e: unknown) => this.emit('update-download-start', e))
    updater.on('download-complete', (e: unknown) => this.emit('update-download-complete', e))
    updater.on('verify-start', (e: unknown) => this.emit('update-verify-start', e))
    updater.on('verify-failed', (e: unknown) => this.emit('update-verify-failed', e))
    updater.on('verify-ok', (e: unknown) => this.emit('update-verify-ok', e))
    updater.on('swap-start', (e: unknown) => this.emit('update-swap-start', e))
    updater.on('swap-complete', (e: unknown) => this.emit('update-swap-complete', e))
    updater.on('error', (err: Error) => this.emit('error', err))

    const result = await updater.runUpdate()

    this.emit('update-ready', result)
  }

  // ---------------------------------------------------------------------------
  // stop() — graceful shutdown
  // ---------------------------------------------------------------------------

  /**
   * Stop the daemon:
   *   1. Set state to 'draining'.
   *   2. Stop accepting new work.
   *   3. Wait for in-flight sessions (up to drainTimeoutSeconds).
   *   4. Stop heartbeat + capacity loops.
   *   5. Set state to 'stopped'.
   */
  async stop(): Promise<void> {
    if (this._state === 'stopped') return

    this._setState('draining')

    const drainTimeout = (this._config?.autoUpdate.drainTimeoutSeconds ?? 600) * 1000
    await this._drain(drainTimeout)

    this._teardownLoops()
    this._setState('stopped')

    void globalHookBus.emit({
      kind: 'post-deactivate',
      provider: { family: 'sandbox', id: 'rensei-daemon', version: DAEMON_VERSION },
    })
  }

  // ---------------------------------------------------------------------------
  // status() — read current state
  // ---------------------------------------------------------------------------

  status(): DaemonStatus {
    return {
      state: this._state,
      workerId: this._workerId ?? undefined,
      activeSessions: this._spawner?.activeCount ?? 0,
      maxSessions: this._config?.capacity.maxConcurrentSessions ?? 0,
      version: DAEMON_VERSION,
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _setState(state: DaemonState): void {
    this._state = state
    this.emit('state-changed', state)
  }

  private _registrationStatus(): DaemonRegistrationStatus {
    switch (this._state) {
      case 'draining':
      case 'updating':
        return 'draining'
      case 'running': {
        const active = this._spawner?.activeCount ?? 0
        const max = this._config?.capacity.maxConcurrentSessions ?? 1
        return active >= max ? 'busy' : 'idle'
      }
      default:
        return 'idle'
    }
  }

  private _buildCapacitySnapshot() {
    const active = this._spawner?.activeCount ?? 0
    const max = this._config?.capacity.maxConcurrentSessions ?? 0
    return {
      provisionedActive: active,
      provisionedPaused: 0,
      maxConcurrent: max,
      estimatedAvailable: Math.max(0, max - active),
      warmPoolReady: 0,
      capturedAt: new Date().toISOString(),
    }
  }

  private async _drain(timeoutMs: number): Promise<void> {
    if (!this._spawner) return
    this._spawner.resume() // ensure accepting flag is updated by caller before this
    // Stop accepting new work
    try {
      await this._spawner.drain(timeoutMs)
    } catch (err) {
      // Log but don't re-throw — SIGTERM was already sent to remaining children
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  private _teardownLoops(): void {
    this._heartbeat?.stop()
    this._heartbeat = null

    if (this._capacityTimer !== null) {
      clearInterval(this._capacityTimer)
      this._capacityTimer = null
    }
  }

  /** Expose config for testing / diagnostics. */
  get config(): DaemonConfig | null {
    return this._config
  }
}
