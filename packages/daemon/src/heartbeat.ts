/**
 * Daemon heartbeat — periodic keepalive sent to the orchestrator.
 *
 * Architecture reference:
 *   rensei-architecture/004-sandbox-capability-matrix.md §Worker registration model
 *   rensei-architecture/011-local-daemon-fleet.md
 *
 * The heartbeat:
 *   1. Emits a 'daemon-heartbeat' event on the global hook bus so observability
 *      consumers (metrics, audit log) can track it without coupling to HTTP.
 *   2. If RENSEI_DAEMON_REAL_REGISTRATION is set, also calls the orchestrator's
 *      heartbeat endpoint (POST /v1/daemon/heartbeat) with the current status.
 *
 * The interval is set by RegisterResponse.heartbeatIntervalSeconds (default 30s).
 *
 * Note: The heartbeat uses the globalHookBus from REN-1313's hook bus (already
 * shipped in packages/core/src/observability/hooks.ts). The event is emitted
 * as a 'post-verb' event with provider id 'rensei-daemon' so existing subscribers
 * can filter on it.
 */

import { globalHookBus } from '@donmai/core'
import type { DaemonHeartbeatPayload, DaemonRegistrationStatus } from './types.js'

// ---------------------------------------------------------------------------
// HeartbeatService
// ---------------------------------------------------------------------------

export interface HeartbeatOptions {
  workerId: string
  hostname: string
  orchestratorUrl: string
  runtimeJwt: string
  /** Interval in seconds from RegisterResponse. Default: 30. */
  intervalSeconds?: number
  /** Callback to get the current active session count. */
  getActiveCount: () => number
  /** Callback to get the max session count. */
  getMaxCount: () => number
  /** Callback to get the current daemon status. */
  getStatus: () => DaemonRegistrationStatus
  region?: string
}

/**
 * Manages the periodic heartbeat loop for a running daemon.
 *
 * Usage:
 *   const hb = new HeartbeatService(opts)
 *   hb.start()
 *   // ... daemon running ...
 *   hb.stop()
 */
export class HeartbeatService {
  private _timer: ReturnType<typeof setInterval> | null = null
  private readonly _opts: Required<HeartbeatOptions>

  constructor(opts: HeartbeatOptions) {
    this._opts = {
      intervalSeconds: 30,
      region: '',
      ...opts,
    }
  }

  /**
   * Start the heartbeat loop. Sends an immediate heartbeat, then repeats
   * at intervalSeconds.
   */
  start(): void {
    if (this._timer !== null) return // already running

    // Immediate first heartbeat
    void this._sendHeartbeat()

    this._timer = setInterval(
      () => { void this._sendHeartbeat() },
      this._opts.intervalSeconds * 1000,
    )
  }

  /** Stop the heartbeat loop. Safe to call multiple times. */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  /** Send a single heartbeat (called by the interval loop and on-demand). */
  private async _sendHeartbeat(): Promise<void> {
    const payload: DaemonHeartbeatPayload = {
      workerId: this._opts.workerId,
      hostname: this._opts.hostname,
      status: this._opts.getStatus(),
      activeSessions: this._opts.getActiveCount(),
      maxSessions: this._opts.getMaxCount(),
      region: this._opts.region || undefined,
      sentAt: new Date().toISOString(),
    }

    // Emit on the global hook bus so observability subscribers see it
    await globalHookBus.emit({
      kind: 'post-verb',
      provider: { family: 'sandbox', id: 'rensei-daemon', version: '0.1.0' },
      verb: 'daemon-heartbeat',
      result: payload,
      durationMs: 0,
    })

    // Optional: call real orchestrator heartbeat endpoint
    if (process.env['RENSEI_DAEMON_REAL_REGISTRATION']) {
      void this._callHeartbeatEndpoint(payload).catch((err: unknown) => {
        console.warn(
          `[daemon] heartbeat HTTP call failed: ${(err as Error).message}. ` +
          `Continuing — orchestrator will detect stale via missed heartbeats.`,
        )
      })
    }
  }

  /**
   * Call the orchestrator's heartbeat endpoint.
   * Endpoint: POST /v1/daemon/heartbeat
   *
   * NOTE: This endpoint is not yet implemented on the orchestrator side.
   * The method is included so the HTTP wiring is ready to activate when the
   * endpoint ships (expected in a follow-up orchestrator-side issue).
   */
  private async _callHeartbeatEndpoint(payload: DaemonHeartbeatPayload): Promise<void> {
    const url = `${this._opts.orchestratorUrl.replace(/\/$/, '')}/v1/daemon/heartbeat`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._opts.runtimeJwt}`,
        'User-Agent': 'rensei-daemon/0.1.0',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)')
      throw new Error(`Heartbeat endpoint returned HTTP ${res.status}: ${body}`)
    }
  }

  /** Whether the heartbeat loop is currently running. */
  get isRunning(): boolean {
    return this._timer !== null
  }
}
