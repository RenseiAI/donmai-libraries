/**
 * Daemon auto-update — channel resolver, binary fetcher, signature verification,
 * swap-and-restart logic.
 *
 * Architecture reference:
 *   rensei-architecture/011-local-daemon-fleet.md §Drain semantics
 *   rensei-architecture/011-local-daemon-fleet.md §Recovery from crash
 *
 * Flow:
 *   1. Resolve the latest available version for the configured channel.
 *   2. If a newer version is available, download the binary + detached signature.
 *   3. Verify the binary signature via the sigstore verifier (REN-1314).
 *      Reject and abort the swap if verification fails; emit an audit event.
 *   4. Atomically swap the binary at the install path.
 *   5. Exit with EXIT_CODE_RESTART (3) so the launchd / systemd supervisor
 *      interprets the exit as "restart-requested" and re-exec the new binary.
 *
 * Restart contract:
 *   The daemon exits with code EXIT_CODE_RESTART = 3.
 *   The launchd plist (REN-1292) and systemd unit (REN-1293) are configured to
 *   restart on any non-zero exit; both services treat exit code 3 as a clean
 *   "please restart" signal without incrementing the crash counter. Manual
 *   callers (tests, CLI) may also listen for the 'swap-complete' event emitted
 *   just before process.exit().
 *
 *   For environments where process replacement is not possible (e.g., the test
 *   harness), pass `_testDryRunExit: true` to skip the actual exit.
 *
 * CDN URL convention:
 *   https://updates.rensei.dev/<channel>/<version>/rensei-daemon-<arch>-<os>
 *   Signature: <binary-url>.sig  (detached, base64-encoded sigstore bundle)
 *
 * Tests mock `fetch` and the sigstore verifier to exercise all paths without
 * network access.
 */

import { createWriteStream, existsSync, renameSync, unlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { EventEmitter } from 'node:events'
import { arch, platform } from 'node:process'
import type { AutoUpdateChannel, DaemonAutoUpdateConfig } from './types.js'
import { globalHookBus } from '@donmai/core'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CDN base URL for update manifests and binaries. */
export const UPDATE_CDN_BASE = 'https://updates.rensei.dev'

/**
 * Exit code the daemon uses to signal the supervisor "restart requested".
 * The launchd / systemd service file is configured to treat this as a clean
 * restart, not a crash.
 */
export const EXIT_CODE_RESTART = 3

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VersionManifest {
  /** Latest version available on the channel (semver). */
  version: string
  /** SHA-256 hex digest of the binary. */
  sha256: string
  /** ISO 8601 release timestamp. */
  releasedAt: string
}

export interface AutoUpdateOptions {
  /** Resolved path of the currently-running daemon binary (process.execPath by default). */
  currentBinaryPath?: string
  /** Current daemon version. */
  currentVersion: string
  /** Auto-update configuration from daemon.yaml. */
  config: DaemonAutoUpdateConfig
  /**
   * Inject a custom fetch implementation (for testing).
   * Defaults to global fetch.
   */
  fetchFn?: typeof fetch
  /**
   * When true, skip process.exit() at the end of swap-and-restart.
   * Used in tests to avoid killing the test runner.
   */
  _testDryRunExit?: boolean
  /**
   * Inject a custom sigstore verifier for testing.
   * When omitted the production SigstoreVerifier is used.
   */
  _testVerifier?: BinaryVerifier
}

export interface AutoUpdateResult {
  /** Whether an update was applied (false = already up-to-date or skipped). */
  updated: boolean
  /** Version that was installed, or the current version if no update was needed. */
  version: string
  /** Human-readable description of what happened. */
  reason: string
}

// ---------------------------------------------------------------------------
// Verifier abstraction (narrow interface, matches SigstoreVerifier but mockable)
// ---------------------------------------------------------------------------

export interface BinaryVerifier {
  verify(input: {
    /** Hex content hash of the binary (used as the "manifest hash" for sigstore). */
    contentHash: string
    /** Base64-encoded detached sigstore bundle. */
    signatureValue: string
  }): Promise<{ valid: boolean; reason?: string }>
}

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

/**
 * Derive the OS/arch suffix expected in the CDN binary filename.
 * Examples: 'arm64-darwin', 'x64-linux', 'x64-win32'
 */
export function resolvePlatformSuffix(): string {
  const os = platform  // 'darwin' | 'linux' | 'win32' | …
  const cpu = arch     // 'arm64' | 'x64' | 'ia32' | …
  return `${cpu}-${os}`
}

// ---------------------------------------------------------------------------
// CDN URL helpers
// ---------------------------------------------------------------------------

/**
 * Build the URL for the version manifest for a given channel.
 * Format: https://updates.rensei.dev/<channel>/latest.json
 */
export function buildManifestUrl(channel: AutoUpdateChannel): string {
  return `${UPDATE_CDN_BASE}/${channel}/latest.json`
}

/**
 * Build the URL for the binary for a given channel/version.
 * Format: https://updates.rensei.dev/<channel>/<version>/rensei-daemon-<arch>-<os>
 */
export function buildBinaryUrl(channel: AutoUpdateChannel, version: string): string {
  const suffix = resolvePlatformSuffix()
  return `${UPDATE_CDN_BASE}/${channel}/${version}/rensei-daemon-${suffix}`
}

/**
 * Build the URL for the detached signature bundle (.sig) alongside the binary.
 */
export function buildSignatureUrl(binaryUrl: string): string {
  return `${binaryUrl}.sig`
}

// ---------------------------------------------------------------------------
// AutoUpdater
// ---------------------------------------------------------------------------

/**
 * Manages the full auto-update flow: check → fetch → verify → swap → restart.
 *
 * Extends EventEmitter to allow callers (daemon, CLI) to observe progress:
 *
 *   'check-start'       () — beginning version check
 *   'up-to-date'        ({ version }) — no newer version found
 *   'download-start'    ({ version, url }) — binary download beginning
 *   'download-complete' ({ version, tmpPath }) — binary downloaded
 *   'verify-start'      ({ version }) — signature verification beginning
 *   'verify-failed'     ({ version, reason }) — signature invalid; swap aborted
 *   'verify-ok'         ({ version }) — signature valid
 *   'swap-start'        ({ from, to, binPath }) — atomic binary swap beginning
 *   'swap-complete'     ({ from, to }) — binary swapped, about to restart
 *   'error'             (err: Error) — non-fatal error
 */
export class AutoUpdater extends EventEmitter {
  private readonly _opts: Required<AutoUpdateOptions>

  constructor(opts: AutoUpdateOptions) {
    super()
    this._opts = {
      currentBinaryPath: process.execPath,
      fetchFn: globalThis.fetch,
      _testDryRunExit: false,
      _testVerifier: undefined as unknown as BinaryVerifier,
      ...opts,
    }
  }

  // ---------------------------------------------------------------------------
  // checkForUpdate() — fetch version manifest and compare
  // ---------------------------------------------------------------------------

  /**
   * Check the CDN for a newer version on the configured channel.
   *
   * @returns The manifest if a newer version is available, or null if up-to-date.
   * @throws {Error} On network failures or malformed manifests.
   */
  async checkForUpdate(): Promise<VersionManifest | null> {
    this.emit('check-start')
    const { config, currentVersion } = this._opts
    const url = buildManifestUrl(config.channel)

    let manifest: VersionManifest
    try {
      const res = await this._opts.fetchFn(url)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching manifest from ${url}`)
      }
      manifest = (await res.json()) as VersionManifest
    } catch (err) {
      throw new Error(
        `Failed to fetch version manifest for channel '${config.channel}': ` +
        (err instanceof Error ? err.message : String(err)),
      )
    }

    if (!manifest.version || typeof manifest.version !== 'string') {
      throw new Error(`Malformed version manifest from ${url}: missing 'version' field`)
    }

    if (!isNewerVersion(manifest.version, currentVersion)) {
      this.emit('up-to-date', { version: currentVersion })
      return null
    }

    return manifest
  }

  // ---------------------------------------------------------------------------
  // runUpdate() — check + fetch + verify + swap + restart
  // ---------------------------------------------------------------------------

  /**
   * Full update flow. Returns when swap is complete (or no update needed).
   * When not in dry-run mode, exits the process via EXIT_CODE_RESTART after swap.
   */
  async runUpdate(): Promise<AutoUpdateResult> {
    const { config, currentVersion } = this._opts

    // 1. Check for newer version
    let manifest: VersionManifest | null
    try {
      manifest = await this.checkForUpdate()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('error', new Error(`[auto-update] Version check failed: ${msg}`))
      return { updated: false, version: currentVersion, reason: `version-check-failed: ${msg}` }
    }

    if (!manifest) {
      return { updated: false, version: currentVersion, reason: 'already-up-to-date' }
    }

    const newVersion = manifest.version
    const binaryUrl = buildBinaryUrl(config.channel, newVersion)
    const sigUrl = buildSignatureUrl(binaryUrl)

    // 2. Download binary
    let tmpBinaryPath: string
    try {
      tmpBinaryPath = await this._downloadToTmp(binaryUrl, newVersion)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('error', new Error(`[auto-update] Binary download failed: ${msg}`))
      return { updated: false, version: currentVersion, reason: `download-failed: ${msg}` }
    }

    // 3. Download signature
    let signatureValue: string
    try {
      signatureValue = await this._downloadSignature(sigUrl)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Clean up temp binary
      this._safeUnlink(tmpBinaryPath)
      this.emit('error', new Error(`[auto-update] Signature download failed: ${msg}`))
      return { updated: false, version: currentVersion, reason: `sig-download-failed: ${msg}` }
    }

    // 4. Verify signature
    this.emit('verify-start', { version: newVersion })
    const contentHash = await _hashFile(tmpBinaryPath)
    const verifyResult = await this._verifySignature(contentHash, signatureValue)

    if (!verifyResult.valid) {
      const reason = verifyResult.reason ?? 'signature invalid'
      this.emit('verify-failed', { version: newVersion, reason })
      this._safeUnlink(tmpBinaryPath)

      // Emit audit event — rejected binary swap
      await globalHookBus.emit({
        kind: 'post-verb',
        provider: { family: 'sandbox', id: 'rensei-daemon', version: currentVersion },
        verb: 'auto-update-sig-rejected',
        result: {
          newVersion,
          channel: config.channel,
          reason,
        },
        durationMs: 0,
      })

      return { updated: false, version: currentVersion, reason: `sig-rejected: ${reason}` }
    }

    this.emit('verify-ok', { version: newVersion })

    // 5. Atomic swap
    const binPath = this._opts.currentBinaryPath
    this.emit('swap-start', { from: currentVersion, to: newVersion, binPath })
    try {
      chmodSync(tmpBinaryPath, 0o755)
      renameSync(tmpBinaryPath, binPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._safeUnlink(tmpBinaryPath)
      this.emit('error', new Error(`[auto-update] Binary swap failed: ${msg}`))
      return { updated: false, version: currentVersion, reason: `swap-failed: ${msg}` }
    }

    this.emit('swap-complete', { from: currentVersion, to: newVersion })

    // 6. Audit event — successful update
    await globalHookBus.emit({
      kind: 'post-verb',
      provider: { family: 'sandbox', id: 'rensei-daemon', version: currentVersion },
      verb: 'auto-update-applied',
      result: {
        fromVersion: currentVersion,
        toVersion: newVersion,
        channel: config.channel,
      },
      durationMs: 0,
    })

    // 7. Restart (exit with special code for the service supervisor to re-exec)
    if (!this._opts._testDryRunExit) {
      process.exit(EXIT_CODE_RESTART)
    }

    return { updated: true, version: newVersion, reason: 'update-applied' }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _downloadToTmp(url: string, version: string): Promise<string> {
    const suffix = resolvePlatformSuffix()
    const tmpPath = resolvePath(tmpdir(), `rensei-daemon-${suffix}-${version}-${Date.now()}.tmp`)
    this.emit('download-start', { version, url })

    const res = await this._opts.fetchFn(url)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching binary from ${url}`)
    }
    if (!res.body) {
      throw new Error(`Empty response body from ${url}`)
    }

    // Stream response body to a temp file
    await _streamToFile(res.body, tmpPath)
    this.emit('download-complete', { version, tmpPath })
    return tmpPath
  }

  private async _downloadSignature(url: string): Promise<string> {
    const res = await this._opts.fetchFn(url)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching signature from ${url}`)
    }
    const text = await res.text()
    return text.trim()
  }

  private async _verifySignature(
    contentHash: string,
    signatureValue: string,
  ): Promise<{ valid: boolean; reason?: string }> {
    const verifier = this._opts._testVerifier ?? (await _defaultVerifier())
    return verifier.verify({ contentHash, signatureValue })
  }

  private _safeUnlink(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Default sigstore verifier adapter
// ---------------------------------------------------------------------------

/**
 * Lazily load the SigstoreVerifier from @renseiai/agentfactory (REN-1314).
 * Adapts VerifierInput → BinaryVerifier interface.
 */
async function _defaultVerifier(): Promise<BinaryVerifier> {
  const { SigstoreVerifier } = await import('@donmai/core')
  const v = new SigstoreVerifier()
  return {
    async verify(input: { contentHash: string; signatureValue: string }) {
      const result = await v.verify({
        manifestHash: input.contentHash,
        signatureValue: input.signatureValue,
        publicKey: '',
        signer: 'rensei-update-signer',
        attestedAt: new Date().toISOString(),
      })
      return { valid: result.valid, reason: result.reason }
    },
  }
}

// ---------------------------------------------------------------------------
// Version comparison helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `candidate` is strictly newer than `current` (semver comparison).
 * Falls back to a simple lexicographic compare if semver parsing fails.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (candidate === current) return false

  const parseSemver = (v: string): [number, number, number] | null => {
    const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!m) return null
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
  }

  const cv = parseSemver(candidate)
  const cr = parseSemver(current)
  if (!cv || !cr) return candidate > current // lexicographic fallback

  for (let i = 0; i < 3; i++) {
    if (cv[i] > cr[i]) return true
    if (cv[i] < cr[i]) return false
  }
  return false
}

// ---------------------------------------------------------------------------
// Node.js stream/file helpers (testable, isolated)
// ---------------------------------------------------------------------------

/**
 * Stream a ReadableStream to a local file path.
 * Uses Node.js streams via WriteStream for efficient large-file handling.
 */
async function _streamToFile(
  body: ReadableStream<Uint8Array>,
  destPath: string,
): Promise<void> {
  const ws = createWriteStream(destPath)
  const reader = body.getReader()

  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject)
    ws.on('finish', resolve)

    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) {
          ws.end()
          return
        }
        ws.write(value, (err) => {
          if (err) { reject(err); return }
          pump()
        })
      }).catch(reject)
    }
    pump()
  })
}

/**
 * Compute the SHA-256 hex digest of a file using Node.js built-in crypto.
 * Used as the "content hash" for signature verification.
 */
async function _hashFile(filePath: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const { createReadStream } = await import('node:fs')

  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(filePath)
    rs.on('data', (chunk: Buffer | string) => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}
