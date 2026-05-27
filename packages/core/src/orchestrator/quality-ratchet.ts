/**
 * Quality Ratchet — Monotonic Quality Thresholds
 *
 * A quality ratchet is a committed JSON file that stores the best-known quality
 * thresholds for the repository. Thresholds can only tighten (improve), never
 * loosen. This prevents cumulative quality drift across many agent sessions.
 *
 * File location: .donmai/quality-ratchet.json (committed to repo)
 *
 * The ratchet is enforced at two points:
 * 1. Merge queue — blocks merge if ratchet thresholds are violated
 * 2. CI — runs as a required status check on every PR
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { QualityBaseline } from './quality-baseline.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityRatchet {
  version: 1
  updatedAt: string
  updatedBy: string
  thresholds: {
    testCount: { min: number }
    testFailures: { max: number }
    typecheckErrors: { max: number }
    lintErrors: { max: number }
  }
}

export interface RatchetCheckResult {
  passed: boolean
  violations: Array<{
    metric: string
    threshold: number
    actual: number
    direction: 'above-max' | 'below-min'
  }>
}

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

const RATCHET_FILENAME = 'quality-ratchet.json'
const RATCHET_DIR = '.donmai'

function ratchetPath(repoRoot: string): string {
  return resolve(repoRoot, RATCHET_DIR, RATCHET_FILENAME)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the quality ratchet from disk.
 * Returns null if the ratchet file does not exist.
 * Throws if the file exists but is invalid.
 */
export function loadQualityRatchet(repoRoot: string): QualityRatchet | null {
  const filePath = ratchetPath(repoRoot)
  if (!existsSync(filePath)) return null

  const content = readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(content) as QualityRatchet

  // Basic validation
  if (parsed.version !== 1 || !parsed.thresholds) {
    throw new Error(`Invalid quality ratchet file: missing version or thresholds`)
  }

  return parsed
}

/**
 * Check current quality metrics against ratchet thresholds.
 * Returns a result with pass/fail and any violations.
 */
export function checkQualityRatchet(
  ratchet: QualityRatchet,
  current: QualityBaseline,
): RatchetCheckResult {
  const violations: RatchetCheckResult['violations'] = []

  const { thresholds } = ratchet

  // Skip the testCount threshold when the baseline couldn't parse a count.
  // A parseError means we don't actually know how many tests ran — treating
  // that as "0 tests" would fail the ratchet on every PR and block merges
  // for reasons orthogonal to code quality.  The merge worker logs the
  // parseError upstream so the underlying cause is still visible.
  if (!current.tests.parseError && current.tests.total < thresholds.testCount.min) {
    violations.push({
      metric: 'testCount',
      threshold: thresholds.testCount.min,
      actual: current.tests.total,
      direction: 'below-min',
    })
  }

  if (current.tests.failed > thresholds.testFailures.max) {
    violations.push({
      metric: 'testFailures',
      threshold: thresholds.testFailures.max,
      actual: current.tests.failed,
      direction: 'above-max',
    })
  }

  if (current.typecheck.errorCount > thresholds.typecheckErrors.max) {
    violations.push({
      metric: 'typecheckErrors',
      threshold: thresholds.typecheckErrors.max,
      actual: current.typecheck.errorCount,
      direction: 'above-max',
    })
  }

  if (current.lint.errorCount > thresholds.lintErrors.max) {
    violations.push({
      metric: 'lintErrors',
      threshold: thresholds.lintErrors.max,
      actual: current.lint.errorCount,
      direction: 'above-max',
    })
  }

  return {
    passed: violations.length === 0,
    violations,
  }
}

/**
 * Tighten the quality ratchet if current metrics are better than thresholds.
 * The ratchet only moves in the direction of improvement (monotonic).
 *
 * Returns true if the ratchet was updated, false if no improvement was found.
 */
export function updateQualityRatchet(
  repoRoot: string,
  current: QualityBaseline,
  identifier: string,
): boolean {
  const existing = loadQualityRatchet(repoRoot)
  if (!existing) return false

  const updated = { ...existing, thresholds: { ...existing.thresholds } }
  let changed = false

  // Test counts are only trustworthy when the output parsed cleanly. On a
  // parseError the `total`/`failed` numbers are whatever the defaults were
  // (0 / 1) and using them would either fail to tighten (harmless) or
  // falsely tighten testFailures.max to 0 (harmful — would block every
  // subsequent PR with any real test failure).
  if (!current.tests.parseError) {
    // Test count: min can only go up
    if (current.tests.total > existing.thresholds.testCount.min) {
      updated.thresholds.testCount = { min: current.tests.total }
      changed = true
    }

    // Test failures: max can only go down
    if (current.tests.failed < existing.thresholds.testFailures.max) {
      updated.thresholds.testFailures = { max: current.tests.failed }
      changed = true
    }
  }

  // Typecheck errors: max can only go down
  if (current.typecheck.errorCount < existing.thresholds.typecheckErrors.max) {
    updated.thresholds.typecheckErrors = { max: current.typecheck.errorCount }
    changed = true
  }

  // Lint errors: max can only go down
  if (current.lint.errorCount < existing.thresholds.lintErrors.max) {
    updated.thresholds.lintErrors = { max: current.lint.errorCount }
    changed = true
  }

  if (changed) {
    updated.updatedAt = new Date().toISOString()
    updated.updatedBy = identifier
    writeFileSync(ratchetPath(repoRoot), JSON.stringify(updated, null, 2) + '\n')
  }

  return changed
}

/**
 * Initialize a new quality ratchet file from a baseline snapshot.
 * Use this when setting up quality gates for the first time.
 */
export function initializeQualityRatchet(
  repoRoot: string,
  baseline: QualityBaseline,
): QualityRatchet {
  const ratchet: QualityRatchet = {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: 'manual',
    thresholds: {
      testCount: { min: baseline.tests.total },
      testFailures: { max: baseline.tests.failed },
      typecheckErrors: { max: baseline.typecheck.errorCount },
      lintErrors: { max: baseline.lint.errorCount },
    },
  }

  writeFileSync(ratchetPath(repoRoot), JSON.stringify(ratchet, null, 2) + '\n')
  return ratchet
}

/**
 * Format a ratchet check result into a human-readable string.
 */
export function formatRatchetResult(result: RatchetCheckResult): string {
  if (result.passed) return 'Quality ratchet check passed.'

  const lines = ['Quality ratchet check **FAILED**:', '']
  for (const v of result.violations) {
    if (v.direction === 'above-max') {
      lines.push(`- ${v.metric}: ${v.actual} exceeds maximum threshold of ${v.threshold}`)
    } else {
      lines.push(`- ${v.metric}: ${v.actual} is below minimum threshold of ${v.threshold}`)
    }
  }
  return lines.join('\n')
}
