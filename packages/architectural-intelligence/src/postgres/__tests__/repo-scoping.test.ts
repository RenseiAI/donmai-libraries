/**
 * Postgres backend — repo-scoping tests (full repo-scoped synthesis).
 *
 * Uses a focused in-memory adapter that understands the new `repo` column on
 * `graph_nodes` / `observations` and the `repo = ANY($n::text[])` read
 * filter. Verifies:
 *   - contribute persists scope.repo into the repo column
 *   - query({ repos }) narrows to the named repo corpus
 *   - query without repos returns the whole project corpus (backward-compat)
 */

import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  PostgresArchitecturalIntelligence,
  type PostgresDbAdapter,
  type DbRow,
  type JsonbParam,
  isJsonbParam,
} from '../index.js'
import type { ArchObservation, ArchScope } from '../../types.js'

interface NodeRow {
  id: string
  name: string
  type: string
  description: string | null
  properties: Record<string, unknown> | null
  importance_weight: number
  org_id: string
  project_id: string
  repo: string | null
  source_observation_id: string | null
  source_session_id: string | null
  created_at: Date
  updated_at: Date
}

interface ObsRow {
  id: string
  org_id: string
  project_id: string
  repo: string | null
}

interface Store {
  nodes: NodeRow[]
  observations: ObsRow[]
}

function makeAdapter(store: Store): PostgresDbAdapter {
  const unbox = (v: unknown): unknown => (isJsonbParam(v) ? v.value : v)

  const adapter: PostgresDbAdapter = {
    json(value: unknown): JsonbParam {
      return { __jsonbParam: true, value }
    },
    transaction: async <T>(fn: (tx: PostgresDbAdapter) => Promise<T>): Promise<T> =>
      fn(adapter),
    async query<TRow extends DbRow = DbRow>(
      text: string,
      params: ReadonlyArray<unknown>,
    ): Promise<TRow[]> {
      const sql = text.trim()
      const bound = params.map(unbox)

      if (/^SELECT\s+set_config\s*\(/i.test(sql)) {
        return [] as unknown as TRow[]
      }

      if (/^INSERT\s+INTO\s+observations/i.test(sql)) {
        // columns: id, org_id, project_id, agent_id, content, content_hash,
        //          kind, payload, source, weight, metadata, repo
        store.observations.push({
          id: bound[0] as string,
          org_id: bound[1] as string,
          project_id: bound[2] as string,
          repo: (bound[11] as string | null) ?? null,
        })
        return [] as unknown as TRow[]
      }

      if (/^INSERT\s+INTO\s+graph_nodes/i.test(sql)) {
        // columns: id, name, type, description, properties,
        //          importance_weight, feedback_weight, org_id, project_id,
        //          source_observation_id, source_session_id, repo
        store.nodes.push({
          id: bound[0] as string,
          name: bound[1] as string,
          type: bound[2] as string,
          description: bound[3] as string | null,
          properties: bound[4] as Record<string, unknown> | null,
          importance_weight: Number(bound[5]),
          org_id: bound[7] as string,
          project_id: bound[8] as string,
          source_observation_id: bound[9] as string | null,
          source_session_id: bound[10] as string | null,
          repo: (bound[11] as string | null) ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        return [] as unknown as TRow[]
      }

      if (/^SELECT[\s\S]+FROM\s+graph_nodes/i.test(sql)) {
        const kinds = bound[0] as string[]
        const orgId = bound[1] as string
        // Remaining positional params depend on which optional clauses the
        // SDK appended. We detect the repo filter by the SQL text.
        let projectId: string | undefined
        let repos: string[] | undefined
        let idx = 2
        if (/project_id\s*=\s*\$/i.test(sql)) {
          projectId = bound[idx] as string
          idx++
        }
        if (/repo\s*=\s*ANY/i.test(sql)) {
          repos = bound[idx] as string[]
        }

        const matched = store.nodes.filter((row) => {
          if (!kinds.includes(row.type)) return false
          if (row.org_id !== orgId) return false
          if (projectId !== undefined && row.project_id !== projectId) return false
          if (repos && repos.length > 0 && !(row.repo !== null && repos.includes(row.repo)))
            return false
          return true
        })
        return matched.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          description: r.description,
          properties: r.properties,
          importanceWeight: r.importance_weight,
          orgId: r.org_id,
          projectId: r.project_id,
          repo: r.repo,
          sourceObservationId: r.source_observation_id,
          sourceSessionId: r.source_session_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })) as unknown as TRow[]
      }

      throw new Error(`repo-scoping adapter does not handle SQL: ${sql.slice(0, 80)}`)
    },
  }
  return adapter
}

const ORG = randomUUID()
const PROJECT = randomUUID()
const SCOPE = (repo?: string): ArchScope => ({
  level: 'project',
  orgId: ORG,
  projectId: PROJECT,
  ...(repo ? { repo } : {}),
})

function patternObs(title: string, repo?: string): ArchObservation {
  return {
    kind: 'pattern',
    payload: { title, description: `${title} desc` },
    source: { sessionId: `s-${title}` },
    confidence: 0.8,
    scope: SCOPE(repo),
  }
}

describe('PostgresArchitecturalIntelligence — repo scoping', () => {
  it('contribute persists scope.repo into the repo column', async () => {
    const store: Store = { nodes: [], observations: [] }
    const impl = new PostgresArchitecturalIntelligence({
      db: makeAdapter(store),
      orgId: ORG,
      projectId: PROJECT,
    })
    await impl.contribute(patternObs('Tagged', 'github.com/acme/a'))
    expect(store.observations[0]?.repo).toBe('github.com/acme/a')
    expect(store.nodes[0]?.repo).toBe('github.com/acme/a')
  })

  it('contribute leaves repo null when scope.repo is unset', async () => {
    const store: Store = { nodes: [], observations: [] }
    const impl = new PostgresArchitecturalIntelligence({
      db: makeAdapter(store),
      orgId: ORG,
      projectId: PROJECT,
    })
    await impl.contribute(patternObs('Untagged'))
    expect(store.observations[0]?.repo).toBeNull()
    expect(store.nodes[0]?.repo).toBeNull()
  })

  it('query({ repos }) narrows to the named repo corpus', async () => {
    const store: Store = { nodes: [], observations: [] }
    const impl = new PostgresArchitecturalIntelligence({
      db: makeAdapter(store),
      orgId: ORG,
      projectId: PROJECT,
    })
    await impl.contribute(patternObs('RepoA', 'github.com/acme/a'))
    await impl.contribute(patternObs('RepoB', 'github.com/acme/b'))

    const view = await impl.query({
      workType: 'development',
      scope: SCOPE(),
      repos: ['github.com/acme/a'],
    })
    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('RepoA')
    expect(view.patterns[0]?.scope.repo).toBe('github.com/acme/a')
  })

  it('query without repos returns the whole project corpus (backward-compatible)', async () => {
    const store: Store = { nodes: [], observations: [] }
    const impl = new PostgresArchitecturalIntelligence({
      db: makeAdapter(store),
      orgId: ORG,
      projectId: PROJECT,
    })
    await impl.contribute(patternObs('RepoA', 'github.com/acme/a'))
    await impl.contribute(patternObs('Untagged'))

    const view = await impl.query({ workType: 'development', scope: SCOPE() })
    expect(view.patterns).toHaveLength(2)
  })
})
