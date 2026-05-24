/**
 * Governor Logger — Colorized, structured display for the governor CLI.
 *
 * Uses ANSI escape codes directly (matching the core Logger pattern)
 * to avoid external dependencies like chalk.
 */

import type { ScanResult } from '@donmai/core'
import type { LinearApiQuota } from '@donmai/plugin-linear'

// ---------------------------------------------------------------------------
// ANSI colors (matching packages/core/src/logger.ts)
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  brightBlack: '\x1b[90m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightRed: '\x1b[91m',
  brightCyan: '\x1b[96m',
} as const

function color(text: string, ...codes: string[]): string {
  return `${codes.join('')}${text}${c.reset}`
}

// ---------------------------------------------------------------------------
// Startup Banner
// ---------------------------------------------------------------------------

export interface StartupBannerConfig {
  version: string
  projects: string[]
  scanIntervalMs: number
  maxConcurrentDispatches: number
  mode: string
  once: boolean
  features: {
    autoResearch: boolean
    autoBacklogCreation: boolean
    autoDevelopment: boolean
    autoQA: boolean
    autoAcceptance: boolean
  }
  redisConnected: boolean
  oauthResolved: boolean
}

export function printStartupBanner(config: StartupBannerConfig): void {
  const w = 56 // inner width

  const top    = `${c.cyan}┌${'─'.repeat(w)}┐${c.reset}`
  const bottom = `${c.cyan}└${'─'.repeat(w)}┘${c.reset}`
  const sep    = `${c.cyan}├${'─'.repeat(w)}┤${c.reset}`

  const pad = (text: string, rawLen: number) => {
    const padding = w - 2 - rawLen
    return `${c.cyan}│${c.reset} ${text}${' '.repeat(Math.max(0, padding))} ${c.cyan}│${c.reset}`
  }

  const title = 'AgentFactory Governor'
  const titleLen = title.length + config.version.length + 3
  const titleLine = `${c.bold}${c.white}${title}${c.reset} ${c.dim}v${config.version}${c.reset}`

  const lines: string[] = [
    top,
    pad(titleLine, titleLen),
    sep,
  ]

  // Projects
  const projList = config.projects.join(', ')
  lines.push(pad(`${color('Projects:', c.bold)} ${projList}`, 10 + projList.length))

  // Scan interval
  const intervalSec = `${config.scanIntervalMs / 1000}s`
  lines.push(pad(`${color('Interval:', c.bold)} ${intervalSec}`, 10 + intervalSec.length))

  // Max dispatches
  const maxStr = String(config.maxConcurrentDispatches)
  lines.push(pad(`${color('Max dispatch:', c.bold)} ${maxStr}/scan`, 14 + maxStr.length + 5))

  // Mode
  const modeStr = config.once ? 'single scan' : config.mode
  lines.push(pad(`${color('Mode:', c.bold)} ${modeStr}`, 6 + modeStr.length))

  lines.push(sep)

  // Feature flags
  const features = config.features
  const featureEntries: Array<[string, boolean]> = [
    ['Research', features.autoResearch],
    ['Backlog Creation', features.autoBacklogCreation],
    ['Development', features.autoDevelopment],
    ['QA', features.autoQA],
    ['Acceptance', features.autoAcceptance],
  ]

  const enabledList = featureEntries
    .filter(([, v]) => v)
    .map(([k]) => k)
  const disabledList = featureEntries
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (enabledList.length > 0) {
    const text = enabledList.join(', ')
    lines.push(pad(`${color('Enabled:', c.green, c.bold)} ${text}`, 9 + text.length))
  }
  if (disabledList.length > 0) {
    const text = disabledList.join(', ')
    lines.push(pad(`${color('Disabled:', c.dim)} ${text}`, 10 + text.length))
  }

  lines.push(sep)

  // Integration status
  const redisStatus = config.redisConnected
    ? color('connected', c.green)
    : color('not configured', c.yellow)
  const redisRawLen = config.redisConnected ? 16 : 22
  lines.push(pad(`${color('Redis:', c.bold)} ${redisStatus}`, 7 + (redisRawLen - 7)))

  const oauthStatus = config.oauthResolved
    ? color('resolved', c.green)
    : color('personal API key', c.yellow)
  const oauthRawLen = config.oauthResolved ? 15 : 24
  lines.push(pad(`${color('OAuth:', c.bold)} ${oauthStatus}`, 7 + (oauthRawLen - 7)))

  lines.push(bottom)

  console.log(lines.join('\n'))
  console.log()
}

// ---------------------------------------------------------------------------
// Scan Summary
// ---------------------------------------------------------------------------

export function printScanSummary(
  results: ScanResult[],
  durationMs: number,
  quota?: LinearApiQuota,
  apiCalls?: number,
): void {
  const ts = formatTime()

  for (const result of results) {
    const { project, scannedIssues, actionsDispatched, skippedReasons, errors } = result
    const projectTag = color(`[${project}]`, c.cyan, c.bold)

    // Main summary line
    const dispatched = actionsDispatched > 0
      ? color(String(actionsDispatched), c.green, c.bold)
      : color('0', c.dim)

    const scanned = color(String(scannedIssues), c.white)
    const skipped = skippedReasons.size > 0
      ? color(String(skippedReasons.size), c.dim)
      : '0'

    console.log(
      `${color(ts, c.dim)} ${projectTag} ${scanned} scanned, ${dispatched} dispatched, ${skipped} skipped`
    )

    // Errors
    if (errors.length > 0) {
      for (const err of errors) {
        console.log(
          `${color(ts, c.dim)} ${projectTag} ${color('ERR', c.red)} ${err.issueId}: ${err.error}`
        )
      }
    }
  }

  // Duration
  const durStr = durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(1)}s`
  console.log(
    `${color(ts, c.dim)} ${color('Scan completed', c.dim)} in ${color(durStr, c.white)}`
  )

  // Quota bar
  if (quota) {
    printQuotaBar(quota, apiCalls)
  }

  console.log()
}

// ---------------------------------------------------------------------------
// Quota Bar
// ---------------------------------------------------------------------------

export function printQuotaBar(quota: LinearApiQuota, apiCalls?: number): void {
  const barWidth = 20

  // Request quota bar
  if (quota.requestsRemaining != null && quota.requestsLimit != null) {
    const used = quota.requestsLimit - quota.requestsRemaining
    const pct = quota.requestsLimit > 0 ? used / quota.requestsLimit : 0
    const barColor = getQuotaColor(1 - pct)
    const bar = renderBar(pct, barWidth, barColor)

    const usedStr = used.toLocaleString()
    const limitStr = quota.requestsLimit.toLocaleString()
    const pctStr = `(${Math.round(pct * 100)}%)`

    let line = `  Linear API  ${bar} ${usedStr}/${limitStr} req ${color(pctStr, c.dim)}`
    if (apiCalls != null) {
      line += `  ${color('│', c.dim)} ${apiCalls} calls this scan`
    }
    console.log(line)
  }

  // Complexity quota bar
  if (quota.complexityRemaining != null && quota.complexityLimit != null) {
    const used = quota.complexityLimit - quota.complexityRemaining
    const pct = quota.complexityLimit > 0 ? used / quota.complexityLimit : 0
    const barColor = getQuotaColor(1 - pct)
    const bar = renderBar(pct, barWidth, barColor)

    const usedStr = formatCompact(used)
    const limitStr = formatCompact(quota.complexityLimit)
    const pctStr = `(${Math.round(pct * 100)}%)`

    let line = `              ${bar} ${usedStr}/${limitStr} cmplx ${color(pctStr, c.dim)}`
    if (quota.resetSeconds != null) {
      const resetMin = Math.ceil(quota.resetSeconds / 60)
      line += `  ${color('│', c.dim)} resets in ${resetMin}m`
    }
    console.log(line)
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker Warning
// ---------------------------------------------------------------------------

export function printCircuitBreakerWarning(status: string): void {
  if (status === 'closed') return

  const ts = formatTime()
  if (status === 'open') {
    console.log(
      `${color(ts, c.dim)} ${color('CIRCUIT BREAKER OPEN', c.brightRed, c.bold)} — API calls blocked, waiting for reset`
    )
  } else if (status === 'half-open') {
    console.log(
      `${color(ts, c.dim)} ${color('CIRCUIT BREAKER HALF-OPEN', c.brightYellow, c.bold)} — probing with single request`
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(): string {
  const now = new Date()
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
}

function getQuotaColor(remainingPct: number): string {
  if (remainingPct < 0.10) return c.brightRed
  if (remainingPct < 0.20) return c.brightYellow
  return c.brightGreen
}

function renderBar(pct: number, width: number, barColor: string): string {
  const filled = Math.round(pct * width)
  const empty = width - filled
  return `[${barColor}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}]`
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}
