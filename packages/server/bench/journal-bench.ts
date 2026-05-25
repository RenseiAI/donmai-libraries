#!/usr/bin/env tsx
/**
 * Journal write throughput + p99 latency bench (REN-1397).
 *
 * Acceptance target (from REN-1397 AC, ADR §Implementation notes):
 *   - 10× anticipated load = 10,000 journal writes/sec sustained
 *   - p99 < 2ms write latency
 *
 * Modes:
 *   1. REDIS_URL set → bench against a real Redis instance using the
 *      production code path (`writeJournalEntry`). This is the artifact
 *      attached to the PR.
 *   2. REDIS_URL unset → fall back to an in-memory simulator that exercises
 *      the journal serializer + event-bus path (NO network round-trip), to
 *      provide a deterministic CI-friendly number that bounds the
 *      non-Redis overhead. The Redis-backed run is the one that gates AC.
 *
 * Run locally:
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @donmai/server bench:journal
 *
 * Output: JSON to stdout — bench artifact for the PR.
 */

import { performance } from 'node:perf_hooks'
import { writeJournalEntry, computeIdempotencyHash } from '../src/journal.js'

const TOTAL_WRITES = Number(process.env.JOURNAL_BENCH_WRITES ?? 10_000)
const CONCURRENCY = Number(process.env.JOURNAL_BENCH_CONCURRENCY ?? 64)

interface BenchResult {
  mode: 'redis' | 'in-memory'
  totalWrites: number
  concurrency: number
  durationMs: number
  writesPerSec: number
  latency: {
    p50Ms: number
    p95Ms: number
    p99Ms: number
    p999Ms: number
    maxMs: number
  }
  meetsAcceptance: {
    throughput10kPerSec: boolean
    p99Under2ms: boolean
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

async function runBench(): Promise<BenchResult> {
  const mode: 'redis' | 'in-memory' = process.env.REDIS_URL ? 'redis' : 'in-memory'

  if (mode === 'in-memory') {
    // The acceptance bench artifact runs against a real Redis (REDIS_URL).
    // The non-Redis bound is exercised by `journal-bench.test.ts` in vitest.
    console.error(
      '[bench] REDIS_URL is not set. Set REDIS_URL=redis://... to run the ' +
        'real-Redis bench. The in-memory bound is exercised by journal-bench.test.ts.'
    )
    process.exit(1)
  }

  const latencies: number[] = new Array(TOTAL_WRITES)
  let nextIndex = 0

  const start = performance.now()

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++
      if (idx >= TOTAL_WRITES) return
      const sessionId = `bench-${idx % 100}`
      const stepId = `step-${idx}`
      const inputHash = computeIdempotencyHash(stepId, { idx }, 'v1')
      const t0 = performance.now()
      await writeJournalEntry({
        sessionId,
        stepId,
        status: 'completed',
        inputHash,
        startedAt: Math.floor(t0),
        completedAt: Math.floor(t0) + 1,
        outputCAS: `cas://bench/${idx}`,
        attempt: 0,
      })
      latencies[idx] = performance.now() - t0
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  const durationMs = performance.now() - start
  const sorted = latencies.slice().sort((a, b) => a - b)
  const writesPerSec = (TOTAL_WRITES / durationMs) * 1000

  const result: BenchResult = {
    mode,
    totalWrites: TOTAL_WRITES,
    concurrency: CONCURRENCY,
    durationMs: Math.round(durationMs * 1000) / 1000,
    writesPerSec: Math.round(writesPerSec),
    latency: {
      p50Ms: Math.round(quantile(sorted, 0.5) * 1000) / 1000,
      p95Ms: Math.round(quantile(sorted, 0.95) * 1000) / 1000,
      p99Ms: Math.round(quantile(sorted, 0.99) * 1000) / 1000,
      p999Ms: Math.round(quantile(sorted, 0.999) * 1000) / 1000,
      maxMs: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
    },
    meetsAcceptance: {
      throughput10kPerSec: writesPerSec >= 10_000,
      p99Under2ms: quantile(sorted, 0.99) < 2,
    },
  }

  return result
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
runBench().then((result) => {
  console.log(JSON.stringify(result, null, 2))
})
