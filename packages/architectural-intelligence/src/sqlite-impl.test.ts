/**
 * SqliteArchitecturalIntelligence — integration tests
 *
 * Verifies:
 *   - Round-trip: contribute → query for each observation kind
 *   - Citation chain integrity: every materialized node has a citation
 *   - Authored-intent constraint: authored citations rank above inferred
 *   - assess() and synthesize() return without throwing (skeleton stubs)
 *   - PostgresArchitecturalIntelligence throws on construction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { SqliteArchitecturalIntelligence } from './sqlite-impl.js'
import { PostgresArchitecturalIntelligence } from './postgres-impl.js'
import type { ArchObservation, ArchScope, ChangeRef } from './types.js'
import { CITATION_CONFIDENCE_RANK } from './types.js'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `arch-intel-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeImpl(dir: string): SqliteArchitecturalIntelligence {
  return new SqliteArchitecturalIntelligence({
    dbPath: join(dir, 'db.sqlite'),
  })
}

const PROJECT_SCOPE: ArchScope = { level: 'project', projectId: 'test-project' }

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string
let impl: SqliteArchitecturalIntelligence
let implClosed = false

beforeEach(() => {
  tmpDir = makeTmpDir()
  impl = makeImpl(tmpDir)
  implClosed = false
})

afterEach(() => {
  if (!implClosed) {
    impl.close()
  }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Round-trip: pattern
// ---------------------------------------------------------------------------

describe('round-trip: pattern observation → query', () => {
  it('contribute a pattern and retrieve it via query', async () => {
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: {
        title: 'Auth centralized in middleware',
        description: 'All API routes delegate to lib/auth/middleware.ts for auth.',
        locations: [{ path: 'lib/auth/middleware.ts', role: 'central auth' }],
        tags: ['auth', 'middleware'],
      },
      source: { sessionId: 'sess-001' },
      confidence: 0.8,
      scope: PROJECT_SCOPE,
    }

    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('Auth centralized in middleware')
    expect(view.patterns[0]?.locations).toHaveLength(1)
    expect(view.patterns[0]?.locations[0]?.path).toBe('lib/auth/middleware.ts')
  })

  it('citation chain is present after contribute', async () => {
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'DI container pattern', description: 'Modules register via DI.' },
      source: { sessionId: 'sess-002' },
      confidence: 0.75,
      scope: PROJECT_SCOPE,
    }

    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })
    const pattern = view.patterns[0]
    expect(pattern).toBeDefined()
    expect(pattern!.citations).toHaveLength(1)
    expect(pattern!.citations[0]?.confidence).toBe('inferred-high') // 0.75 → inferred-high
  })
})

// ---------------------------------------------------------------------------
// Round-trip: convention
// ---------------------------------------------------------------------------

describe('round-trip: convention observation → query', () => {
  it('contribute a convention and retrieve it', async () => {
    const obs: ArchObservation = {
      kind: 'convention',
      payload: {
        title: 'Result<T, E> error handling',
        description: 'All APIs return Result<T, E>; never throw raw errors.',
        examples: [{ path: 'packages/core/src/workarea/types.ts', excerpt: 'export type Result<T, E>' }],
      },
      source: { sessionId: 'sess-003' },
      confidence: 0.9,
      scope: PROJECT_SCOPE,
    }

    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    expect(view.conventions).toHaveLength(1)
    expect(view.conventions[0]?.title).toBe('Result<T, E> error handling')
  })

  it('authored convention is marked authored=true', async () => {
    const obs: ArchObservation = {
      kind: 'convention',
      payload: {
        title: 'Typed errors only',
        description: 'Documented in CLAUDE.md: never throw untyped errors.',
      },
      source: { authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' } },
      confidence: 0.95,
      scope: PROJECT_SCOPE,
    }

    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    expect(view.conventions[0]?.authored).toBe(true)
    expect(view.conventions[0]?.citations[0]?.confidence).toBe('authored')
  })
})

// ---------------------------------------------------------------------------
// Round-trip: decision
// ---------------------------------------------------------------------------

describe('round-trip: decision observation → query', () => {
  it('contribute a decision and retrieve it', async () => {
    const obs: ArchObservation = {
      kind: 'decision',
      payload: {
        title: 'Drizzle over Prisma',
        chosen: 'Drizzle ORM',
        alternatives: [{ option: 'Prisma', rejectionReason: 'No edge-runtime support' }],
        rationale: 'Edge-runtime support required for deployment target.',
        status: 'active',
      },
      source: {
        changeRef: {
          repository: 'github.com/example/repo',
          kind: 'pr',
          prNumber: 142,
          description: 'Switch ORM to Drizzle',
        },
      },
      confidence: 0.85,
      scope: PROJECT_SCOPE,
    }

    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    expect(view.decisions).toHaveLength(1)
    expect(view.decisions[0]?.chosen).toBe('Drizzle ORM')
    expect(view.decisions[0]?.status).toBe('active')
    expect(view.decisions[0]?.citations[0]?.source.kind).toBe('change')
  })
})

// ---------------------------------------------------------------------------
// Round-trip: deviation
// ---------------------------------------------------------------------------

describe('round-trip: deviation observation → contribute (storage only)', () => {
  it('stores a deviation and can retrieve it via _getAllDeviations', async () => {
    const obs: ArchObservation = {
      kind: 'deviation',
      payload: {
        title: 'Auth bypass in /api/public/health',
        description: 'Route bypasses auth middleware without documented reason.',
        deviatesFrom: { kind: 'pattern', patternId: 'pat-auth-central' },
        status: 'pending',
        severity: 'high',
      },
      source: {
        changeRef: {
          repository: 'github.com/example/repo',
          kind: 'commit',
          sha: 'deadbeef',
        },
      },
      confidence: 0.7,
      scope: PROJECT_SCOPE,
    }

    await impl.contribute(obs)

    const deviations = impl._getAllDeviations()
    expect(deviations).toHaveLength(1)
    expect(deviations[0]?.title).toBe('Auth bypass in /api/public/health')
    expect(deviations[0]?.severity).toBe('high')
    expect(deviations[0]?.status).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// Citation chain: authored vs inferred ranking
// ---------------------------------------------------------------------------

describe('citation chain: authored intent > inferences constraint', () => {
  it('authored citation has higher rank than inferred citations', async () => {
    // Contribute authored observation
    await impl.contribute({
      kind: 'pattern',
      payload: { title: 'Layered architecture', description: 'Hexagonal layout in domain/ and adapters/' },
      source: { authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' } },
      confidence: 0.95,
      scope: PROJECT_SCOPE,
    })

    // Contribute inferred observation for same concept
    await impl.contribute({
      kind: 'pattern',
      payload: { title: 'Inferred layered architecture', description: 'Same pattern, inferred' },
      source: { sessionId: 'sess-infer' },
      confidence: 0.5,
      scope: PROJECT_SCOPE,
    })

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    // Find the authored pattern's citations
    const authoredPattern = view.patterns.find(
      (p) => p.citations.some((c) => c.confidence === 'authored'),
    )
    expect(authoredPattern).toBeDefined()

    // Find the inferred pattern's citations
    const inferredPattern = view.patterns.find(
      (p) => p.citations.some((c) => c.confidence === 'inferred-medium'),
    )
    expect(inferredPattern).toBeDefined()

    // Verify authored ranks higher
    const authoredCitation = authoredPattern!.citations[0]!
    const inferredCitation = inferredPattern!.citations[0]!
    expect(CITATION_CONFIDENCE_RANK[authoredCitation.confidence]).toBeGreaterThan(
      CITATION_CONFIDENCE_RANK[inferredCitation.confidence],
    )
  })

  it('view citations are sorted authored-first', async () => {
    // Contribute in reverse confidence order
    await impl.contribute({
      kind: 'pattern',
      payload: { title: 'Pattern A (inferred-low)', description: 'Weak signal' },
      source: { sessionId: 'sess-low' },
      confidence: 0.2,
      scope: PROJECT_SCOPE,
    })

    await impl.contribute({
      kind: 'pattern',
      payload: { title: 'Pattern B (authored)', description: 'From CLAUDE.md' },
      source: { authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' } },
      confidence: 0.95,
      scope: PROJECT_SCOPE,
    })

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    // All citations in view should be sorted by confidence rank desc
    for (let i = 0; i < view.citations.length - 1; i++) {
      const curr = view.citations[i]!
      const next = view.citations[i + 1]!
      expect(CITATION_CONFIDENCE_RANK[curr.confidence]).toBeGreaterThanOrEqual(
        CITATION_CONFIDENCE_RANK[next.confidence],
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Multiple contributes accumulate
// ---------------------------------------------------------------------------

describe('multiple observations accumulate', () => {
  it('three patterns contribute three rows', async () => {
    for (let i = 0; i < 3; i++) {
      await impl.contribute({
        kind: 'pattern',
        payload: { title: `Pattern ${i}`, description: `Description ${i}` },
        source: { sessionId: `sess-${i}` },
        confidence: 0.6,
        scope: PROJECT_SCOPE,
      })
    }

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })
    expect(view.patterns).toHaveLength(3)
  })

  it('observations are persisted in the observations table', async () => {
    await impl.contribute({
      kind: 'convention',
      payload: { title: 'Test' },
      source: { sessionId: 'sess-obs' },
      confidence: 0.6,
      scope: PROJECT_SCOPE,
    })

    const obs = impl._getAllObservations()
    expect(obs).toHaveLength(1)
    expect(obs[0]?.kind).toBe('convention')
  })
})

// ---------------------------------------------------------------------------
// synthesize() — skeleton stub
// ---------------------------------------------------------------------------

describe('synthesize() — skeleton stub', () => {
  it('returns a string for markdown format', async () => {
    await impl.contribute({
      kind: 'pattern',
      payload: { title: 'Some pattern', description: 'Description' },
      source: { sessionId: 'sess-synth' },
      confidence: 0.7,
      scope: PROJECT_SCOPE,
    })

    const result = await impl.synthesize(PROJECT_SCOPE, 'markdown')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('Some pattern')
  })

  it('returns valid JSON for json format', async () => {
    const result = await impl.synthesize(PROJECT_SCOPE, 'json')
    expect(() => JSON.parse(result)).not.toThrow()
  })

  it('returns a mermaid string for mermaid format', async () => {
    const result = await impl.synthesize(PROJECT_SCOPE, 'mermaid')
    expect(typeof result).toBe('string')
    expect(result).toContain('graph TD')
  })
})

// ---------------------------------------------------------------------------
// assess() — skeleton stub
// ---------------------------------------------------------------------------

describe('assess() — skeleton stub', () => {
  it('returns a DriftReport with no deviations', async () => {
    const change: ChangeRef = {
      repository: 'github.com/example/repo',
      kind: 'pr',
      prNumber: 999,
    }

    const report = await impl.assess(change)

    expect(report.change.prNumber).toBe(999)
    expect(report.deviations).toHaveLength(0)
    expect(report.hasCriticalDrift).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Path filtering in query
// ---------------------------------------------------------------------------

describe('query path filtering', () => {
  it('filters patterns by location path', async () => {
    await impl.contribute({
      kind: 'pattern',
      payload: {
        title: 'Auth pattern',
        description: 'Auth in lib/auth',
        locations: [{ path: 'lib/auth/middleware.ts' }],
        tags: ['auth'],
      },
      source: { sessionId: 'sess-auth' },
      confidence: 0.8,
      scope: PROJECT_SCOPE,
    })

    await impl.contribute({
      kind: 'pattern',
      payload: {
        title: 'DB pattern',
        description: 'DB in lib/db',
        locations: [{ path: 'lib/db/connection.ts' }],
        tags: ['db'],
      },
      source: { sessionId: 'sess-db' },
      confidence: 0.8,
      scope: PROJECT_SCOPE,
    })

    // Query with path filter for auth only
    const view = await impl.query({
      workType: 'development',
      scope: PROJECT_SCOPE,
      paths: ['lib/auth'],
    })

    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('Auth pattern')
  })
})

// ---------------------------------------------------------------------------
// PostgresArchitecturalIntelligence — requires an injected db adapter
// (full coverage lives in src/postgres/__tests__/postgres.test.ts)
// ---------------------------------------------------------------------------

describe('PostgresArchitecturalIntelligence', () => {
  it('throws when constructed without a db adapter', () => {
    expect(
      () =>
        new PostgresArchitecturalIntelligence({
          db: undefined as unknown as never,
          orgId: 'org-test',
        }),
    ).toThrow(/db.+required/i)
  })

  it('throws when constructed without an orgId', () => {
    expect(
      () =>
        new PostgresArchitecturalIntelligence({
          db: { query: async () => [], json: (v) => ({ __jsonbParam: true, value: v }) },
          orgId: '',
        }),
    ).toThrow(/orgId.+required/i)
  })
})

// ---------------------------------------------------------------------------
// Persistence: data survives close/reopen
// ---------------------------------------------------------------------------

describe('persistence: data survives close and reopen', () => {
  it('pattern written before close is readable after reopen', async () => {
    await impl.contribute({
      kind: 'pattern',
      payload: { title: 'Persisted pattern', description: 'Should survive reopen' },
      source: { sessionId: 'sess-persist' },
      confidence: 0.7,
      scope: PROJECT_SCOPE,
    })

    impl.close()
    implClosed = true

    // Reopen same db file
    const impl2 = makeImpl(tmpDir)
    const view = await impl2.query({ workType: 'development', scope: PROJECT_SCOPE })

    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('Persisted pattern')

    impl2.close()
  })
})
