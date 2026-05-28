/**
 * Shared version utilities for AgentFactory CLI commands.
 *
 * Provides current version detection and npm update checking with
 * file-based caching to avoid excessive network requests.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import os from 'os'

// ---------------------------------------------------------------------------
// Current version
// ---------------------------------------------------------------------------

const PACKAGE_NAME = '@donmai/cli'

/**
 * Read the current package version from the CLI's package.json.
 */
export function getVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    // Walk up from the current file until we find the CLI package.json
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'package.json')
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'))
        if (pkg.name === PACKAGE_NAME) {
          return pkg.version ?? 'unknown'
        }
      }
      dir = path.dirname(dir)
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Update check result
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(os.tmpdir(), 'agentfactory')
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json')
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

interface CacheEntry {
  latestVersion: string
  checkedAt: number
}

function readCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_FILE)) return null
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
    if (typeof data.latestVersion !== 'string' || typeof data.checkedAt !== 'number') return null
    return data as CacheEntry
  } catch {
    return null
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true })
    }
    writeFileSync(CACHE_FILE, JSON.stringify(entry), 'utf-8')
  } catch {
    // Non-critical — silently ignore cache write failures
  }
}

// ---------------------------------------------------------------------------
// npm registry fetch
// ---------------------------------------------------------------------------

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { signal: controller.signal },
    )
    clearTimeout(timeout)

    if (!response.ok) return null
    const data = (await response.json()) as { version?: string }
    return data.version ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Semver comparison (major.minor.patch only)
// ---------------------------------------------------------------------------

function parseVersion(v: string): [number, number, number] | null {
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest)
  const c = parseVersion(current)
  if (!l || !c) return false

  if (l[0] !== c[0]) return l[0] > c[0]
  if (l[1] !== c[1]) return l[1] > c[1]
  return l[2] > c[2]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a newer version is available on npm.
 *
 * Uses a file-based cache (4-hour TTL) to avoid hitting the registry
 * on every CLI invocation. Returns null if the check is skipped or fails.
 *
 * Disabled when:
 *   - `AF_NO_UPDATE_CHECK=1` env var is set
 *   - `--no-update-check` was passed
 *   - Current version is 'unknown'
 */
export async function checkForUpdate(opts?: {
  noUpdateCheck?: boolean
}): Promise<UpdateCheckResult | null> {
  if (opts?.noUpdateCheck) return null
  if (process.env.AF_NO_UPDATE_CHECK === '1' || process.env.AF_NO_UPDATE_CHECK === 'true') return null

  const currentVersion = getVersion()
  if (currentVersion === 'unknown') return null

  // Check cache first
  const cached = readCache()
  if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
    return {
      currentVersion,
      latestVersion: cached.latestVersion,
      updateAvailable: isNewer(cached.latestVersion, currentVersion),
    }
  }

  // Fetch from npm (non-blocking — don't slow down startup)
  const latestVersion = await fetchLatestVersion()
  if (!latestVersion) return null

  writeCache({ latestVersion, checkedAt: Date.now() })

  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewer(latestVersion, currentVersion),
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
} as const

/**
 * Print an update notification to stderr if a newer version is available.
 * Designed to be non-intrusive — just a single line after the startup banner.
 */
export function printUpdateNotification(result: UpdateCheckResult | null): void {
  if (!result?.updateAvailable) return

  console.log(
    `\n${c.yellow}${c.bold}Update available:${c.reset} ${c.dim}v${result.currentVersion}${c.reset} → ${c.green}v${result.latestVersion}${c.reset}` +
    `  ${c.dim}Run${c.reset} ${c.cyan}npm i -g @donmai/cli@latest${c.reset} ${c.dim}to update${c.reset}\n`,
  )
}
