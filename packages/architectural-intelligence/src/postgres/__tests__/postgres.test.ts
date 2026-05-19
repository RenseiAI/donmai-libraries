/**
 * PostgresArchitecturalIntelligence — integration tests against an
 * in-memory adapter.
 *
 * Why no real Postgres?
 *   The SDK accepts an injected adapter (see `adapter.ts`). The tests
 *   construct an in-memory stub that mimics the platform's `graph_nodes`
 *   + `observations` shape and verifies the SDK's behavior — query
 *   filters, jsonb hygiene, round-trip materialization, multi-tenant
 *   isolation. A real Postgres test would only exercise the adapter
 *   shim, which is the consumer's responsibility to wire (the SDK's
 *   contract is "adapter conforms to PostgresDbAdapter").
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  PostgresArchitecturalIntelligence,
  type PostgresDbAdapter,
  type DbRow,
  type JsonbParam,
  isJsonbParam,
} from '../index.js'
import type { ArchObservation, ArchScope } from '../../types.js'

// ---------------------------------------------------------------------------
// In-memory adapter — minimum shape to drive the SDK
// ---------------------------------------------------------------------------

interface ObservationRow {
  id: string
  org_id: string
  project_id: string
  agent_id: string
  content: string
  content_hash: string
  kind: string
  payload: string
  source: string
  weight: number
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

interface GraphNodeRowDb {
  id: string
  name: string
  type: string
  description: string | null
  properties: Record<string, unknown> | null
  importance_weight: number
  feedback_weight: number
  org_id: string
  project_id: string
  source_observation_id: string | null
  source_session_id: string | null
  created_at: Date
  updated_at: Date
}

interface Store {
  observations: ObservationRow[]
  graphNodes: GraphNodeRowDb[]
}

function freshStore(): Store {
  return { observations: [], graphNodes: [] }
}

/**
 * Match `$1, $2, ...` placeholders against the params array. The store
 * does not parse SQL — it inspects the SQL string for the table name and
 * the WHERE clause shape we care about.
 */
function makeAdapter(store: Store): PostgresDbAdapter {
  function unbox(v: unknown): unknown {
    if (isJsonbParam(v)) return v.value
    return v
  }

  return {
    json(value: unknown): JsonbParam {
      return { __jsonbParam: true, value }
    },

    async query<TRow extends DbRow = DbRow>(
      text: string,
      params: ReadonlyArray<unknown>,
    ): Promise<TRow[]> {
      const sql = text.trim()
      const bound = params.map(unbox)

      // INSERT INTO observations
      if (/^INSERT\s+INTO\s+observations/i.test(sql)) {
        const [
          id,
          orgId,
          projectId,
          agentId,
          content,
          contentHash,
          kind,
          payload,
          source,
          weight,
          metadata,
        ] = bound as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          Record<string, unknown>,
        ]
        const existing = store.observations.find(
          (o) =>
            o.org_id === orgId &&
            o.project_id === projectId &&
            o.agent_id === agentId &&
            o.content_hash === contentHash,
        )
        if (existing) {
          existing.weight += 1
          existing.updated_at = new Date()
          return [] as unknown as TRow[]
        }
        store.observations.push({
          id,
          org_id: orgId,
          project_id: projectId,
          agent_id: agentId,
          content,
          content_hash: contentHash,
          kind,
          payload,
          source,
          weight: Number(weight),
          metadata,
          created_at: new Date(),
          updated_at: new Date(),
        })
        return [] as unknown as TRow[]
      }

      // INSERT INTO graph_nodes
      if (/^INSERT\s+INTO\s+graph_nodes/i.test(sql)) {
        const [
          id,
          name,
          type,
          description,
          properties,
          importanceWeight,
          feedbackWeight,
          orgId,
          projectId,
          sourceObservationId,
          sourceSessionId,
        ] = bound as [
          string,
          string,
          string,
          string,
          Record<string, unknown>,
          number,
          number,
          string,
          string,
          string | null,
          string | null,
        ]
        store.graphNodes.push({
          id,
          name,
          type,
          description,
          properties,
          importance_weight: Number(importanceWeight),
          feedback_weight: Number(feedbackWeight),
          org_id: orgId,
          project_id: projectId,
          source_observation_id: sourceObservationId,
          source_session_id: sourceSessionId,
          created_at: new Date(),
          updated_at: new Date(),
        })
        return [] as unknown as TRow[]
      }

      // SELECT ... FROM graph_nodes WHERE type = ANY ($1::text[]) AND org_id = $2 [AND project_id = $3]
      if (/^SELECT[\s\S]+FROM\s+graph_nodes/i.test(sql)) {
        const kinds = bound[0] as string[]
        const orgId = bound[1] as string
        const projectId = bound.length >= 3 ? (bound[2] as string) : undefined

        const matched = store.graphNodes.filter((row) => {
          if (!kinds.includes(row.type)) return false
          if (row.org_id !== orgId) return false
          if (projectId !== undefined && row.project_id !== projectId) return false
          return true
        })
        matched.sort((a, b) => {
          if (b.importance_weight !== a.importance_weight) {
            return b.importance_weight - a.importance_weight
          }
          return b.updated_at.getTime() - a.updated_at.getTime()
        })
        // Re-key to the camelCase aliases the SDK expects.
        return matched.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          description: r.description,
          properties: r.properties,
          importanceWeight: r.importance_weight,
          orgId: r.org_id,
          projectId: r.project_id,
          sourceObservationId: r.source_observation_id,
          sourceSessionId: r.source_session_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })) as unknown as TRow[]
      }

      throw new Error(`In-memory adapter does not handle SQL: ${sql.slice(0, 80)}...`)
    },
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = randomUUID()
const ORG_B = randomUUID()
const PROJECT_A = randomUUID()
const PROJECT_B = randomUUID()

const SCOPE_A: ArchScope = { level: 'project', orgId: ORG_A, projectId: PROJECT_A }
const SCOPE_B: ArchScope = { level: 'project', orgId: ORG_B, projectId: PROJECT_B }

let store: Store
let impl: PostgresArchitecturalIntelligence

beforeEach(() => {
  store = freshStore()
  impl = new PostgresArchitecturalIntelligence({
    db: makeAdapter(store),
    orgId: ORG_A,
    projectId: PROJECT_A,
  })
})

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('throws when db is missing', () => {
    expect(
      () =>
        new PostgresArchitecturalIntelligence({
          db: undefined as unknown as PostgresDbAdapter,
          orgId: ORG_A,
        }),
    ).toThrow(/db.+required/i)
  })

  it('throws when orgId is missing', () => {
    expect(
      () =>
        new PostgresArchitecturalIntelligence({
          db: makeAdapter(freshStore()),
          orgId: '',
        }),
    ).toThrow(/orgId.+required/i)
  })
})

// ---------------------------------------------------------------------------
// query() — empty result
// ---------------------------------------------------------------------------

describe('query() — empty result', () => {
  it('returns an empty ArchView when no nodes exist for the org', async () => {
    const view = await impl.query({ workType: 'development', scope: SCOPE_A })
    expect(view.patterns).toHaveLength(0)
    expect(view.conventions).toHaveLength(0)
    expect(view.decisions).toHaveLength(0)
    expect(view.citations).toHaveLength(0)
    expect(view.scope).toEqual(SCOPE_A)
  })
})

// ---------------------------------------------------------------------------
// contribute() → query() round-trip
// ---------------------------------------------------------------------------

describe('contribute() → query() round-trip', () => {
  it('contribute a pattern and retrieve it', async () => {
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
      scope: SCOPE_A,
    }

    await impl.contribute(obs)

    expect(store.observations).toHaveLength(1)
    expect(store.observations[0]?.kind).toBe('pattern')
    expect(store.graphNodes).toHaveLength(1)

    const view = await impl.query({ workType: 'development', scope: SCOPE_A })
    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('Auth centralized in middleware')
    expect(view.patterns[0]?.locations).toHaveLength(1)
    expect(view.patterns[0]?.locations[0]?.path).toBe('lib/auth/middleware.ts')
    expect(view.patterns[0]?.tags).toContain('auth')
  })

  it('contribute a convention with authored source preserves authored flag', async () => {
    const obs: ArchObservation = {
      kind: 'convention',
      payload: {
        title: 'Result<T, E> error handling',
        description: 'All APIs return Result<T, E>; never throw raw errors.',
        examples: [{ path: 'packages/core/src/workarea/types.ts' }],
      },
      source: { authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' } },
      confidence: 0.95,
      scope: SCOPE_A,
    }

    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: SCOPE_A })
    expect(view.conventions).toHaveLength(1)
    expect(view.conventions[0]?.authored).toBe(true)
  })

  it('contribute a decision and retrieve it (active status)', async () => {
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
        },
      },
      confidence: 0.85,
      scope: SCOPE_A,
    }

    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: SCOPE_A })
    expect(view.decisions).toHaveLength(1)
    expect(view.decisions[0]?.chosen).toBe('Drizzle ORM')
    expect(view.decisions[0]?.status).toBe('active')
  })

  it('superseded decisions are filtered from query() results', async () => {
    const obs: ArchObservation = {
      kind: 'decision',
      payload: {
        title: 'Old decision',
        chosen: 'Option A',
        rationale: 'Initial pick',
        status: 'superseded',
      },
      source: { sessionId: 'sess-old' },
      confidence: 0.7,
      scope: SCOPE_A,
    }
    await impl.contribute(obs)

    const view = await impl.query({ workType: 'development', scope: SCOPE_A })
    expect(view.decisions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// jsonb hygiene — payloads are NOT scalar strings on disk
// ---------------------------------------------------------------------------

describe('jsonb hygiene', () => {
  it('contribute writes metadata as a jsonb object (not a scalar string)', async () => {
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'Test', description: 'test' },
      source: { sessionId: 'sess-jsonb-1' },
      confidence: 0.7,
      scope: SCOPE_A,
    }
    await impl.contribute(obs)

    const row = store.observations[0]!
    // The adapter unboxes JsonbParam and stores the underlying object —
    // exactly what `sql.json(...)` does in the real driver.
    expect(typeof row.metadata).toBe('object')
    expect(row.metadata['kind']).toBe('pattern')
    expect(row.metadata['confidence']).toBe(0.7)
  })

  it('contribute writes graph_nodes.properties as a jsonb object', async () => {
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'Test2', description: 'test2', tags: ['a', 'b'] },
      source: { sessionId: 'sess-jsonb-2' },
      confidence: 0.6,
      scope: SCOPE_A,
    }
    await impl.contribute(obs)

    const node = store.graphNodes[0]!
    expect(typeof node.properties).toBe('object')
    expect(Array.isArray(node.properties?.['tags'])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Multi-tenant isolation
// ---------------------------------------------------------------------------

describe('multi-tenant isolation', () => {
  it('orgA observation is invisible to orgB', async () => {
    const obsA: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'OrgA-only pattern', description: 'private to org A' },
      source: { sessionId: 'sess-a' },
      confidence: 0.8,
      scope: SCOPE_A,
    }
    await impl.contribute(obsA)

    // Construct a separate SDK instance scoped to ORG_B — same adapter
    // (same in-memory store), different scope.
    const implB = new PostgresArchitecturalIntelligence({
      db: makeAdapter(store),
      orgId: ORG_B,
      projectId: PROJECT_B,
    })

    const viewB = await implB.query({ workType: 'development', scope: SCOPE_B })
    expect(viewB.patterns).toHaveLength(0)
    expect(viewB.conventions).toHaveLength(0)
    expect(viewB.decisions).toHaveLength(0)

    // ORG_A still sees its own row.
    const viewA = await impl.query({ workType: 'development', scope: SCOPE_A })
    expect(viewA.patterns).toHaveLength(1)
  })

  it('contribute writes the configured orgId (not the observation scope override) when scope.orgId is absent', async () => {
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'Pattern with partial scope', description: '' },
      source: { sessionId: 'sess-partial' },
      confidence: 0.5,
      // scope here intentionally omits orgId — SDK should fall back to ctx
      scope: { level: 'project', projectId: PROJECT_A },
    }
    await impl.contribute(obs)
    expect(store.observations[0]?.org_id).toBe(ORG_A)
  })
})

// ---------------------------------------------------------------------------
// query() — path filtering
// ---------------------------------------------------------------------------

describe('query() — path filtering', () => {
  it('paths filter narrows patterns to matching locations', async () => {
    await impl.contribute({
      kind: 'pattern',
      payload: {
        title: 'Auth pattern',
        description: '',
        locations: [{ path: 'lib/auth/middleware.ts' }],
      },
      source: { sessionId: 's1' },
      confidence: 0.8,
      scope: SCOPE_A,
    })
    await impl.contribute({
      kind: 'pattern',
      payload: {
        title: 'Routing pattern',
        description: '',
        locations: [{ path: 'lib/routing/router.ts' }],
      },
      source: { sessionId: 's2' },
      confidence: 0.7,
      scope: SCOPE_A,
    })

    const view = await impl.query({
      workType: 'development',
      scope: SCOPE_A,
      paths: ['lib/auth'],
    })
    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('Auth pattern')
  })
})

// ---------------------------------------------------------------------------
// synthesize() — formats
// ---------------------------------------------------------------------------

describe('synthesize()', () => {
  beforeEach(async () => {
    await impl.contribute({
      kind: 'pattern',
      payload: { title: 'P1', description: 'desc1' },
      source: { sessionId: 's1' },
      confidence: 0.8,
      scope: SCOPE_A,
    })
    await impl.contribute({
      kind: 'convention',
      payload: { title: 'C1', description: 'cdesc' },
      source: { sessionId: 's2' },
      confidence: 0.9,
      scope: SCOPE_A,
    })
  })

  it('markdown output includes pattern and convention sections', async () => {
    const md = await impl.synthesize(SCOPE_A, 'markdown')
    expect(md).toContain('# Architectural Overview')
    expect(md).toContain('## Patterns')
    expect(md).toContain('### P1')
    expect(md).toContain('## Conventions')
    expect(md).toContain('### C1')
  })

  it('mermaid output is a valid graph TD prologue', async () => {
    const mm = await impl.synthesize(SCOPE_A, 'mermaid')
    expect(mm.startsWith('graph TD')).toBe(true)
    expect(mm).toContain('Pattern: P1')
    expect(mm).toContain('Convention: C1')
  })

  it('json output parses to the underlying view', async () => {
    const json = await impl.synthesize(SCOPE_A, 'json')
    const view = JSON.parse(json)
    expect(view.patterns).toHaveLength(1)
    expect(view.conventions).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// assess() — placeholder behaviour
// ---------------------------------------------------------------------------

describe('assess()', () => {
  it('returns a placeholder report (no model adapter wired)', async () => {
    const report = await impl.assess({
      repository: 'github.com/example/r',
      kind: 'pr',
      prNumber: 1,
    })
    expect(report.hasCriticalDrift).toBe(false)
    expect(report.deviations).toHaveLength(0)
    expect(report.summary).toMatch(/placeholder/i)
  })
})
