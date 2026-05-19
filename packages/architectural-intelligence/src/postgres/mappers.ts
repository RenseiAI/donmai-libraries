/**
 * Row mappers — translate Postgres rows to SDK domain objects.
 *
 * The platform's `graph_nodes` table stores architectural assertions with
 * the shape:
 *   { id, name, type, description, properties, source_observation_id,
 *     source_session_id, importance_weight, created_at, updated_at,
 *     org_id, project_id }
 *
 * SDK domain types (ArchitecturalPattern, Convention, Decision, Deviation)
 * carry richer structure than the row directly — `locations`, `tags`,
 * `examples`, `alternatives`, etc. all live in `properties` jsonb.
 *
 * Citations:
 *   The platform stores citations in `properties.citations` and on the
 *   provenance back-links `source_observation_id` / `source_session_id`.
 *   The mappers synthesise SDK `Citation[]` from these signals — see
 *   `extractCitations()` below. The SDK never silently promotes an
 *   inferred citation to authored confidence (007 §"non-negotiable
 *   principles").
 */

import type {
  ArchScope,
  ArchitecturalPattern,
  Convention,
  Decision,
  Deviation,
  Citation,
  CitationConfidence,
} from '../types.js'

/**
 * Shape of a `graph_nodes` row as returned by our queries.
 * Columns are exposed as camelCase by the query layer.
 */
export interface GraphNodeRow {
  id: string
  name: string
  type: string
  description: string | null
  properties: Record<string, unknown> | null
  importanceWeight: number
  orgId: string
  projectId: string
  sourceObservationId: string | null
  sourceSessionId: string | null
  createdAt: string | Date
  updatedAt: string | Date
  /**
   * Index signature so this interface satisfies the adapter's generic
   * `DbRow extends Record<string, unknown>` constraint. Callers should
   * read via the named fields above; additional columns are ignored.
   */
  [key: string]: unknown
}

/**
 * Convert a confidence float (0..1) to a `CitationConfidence` level.
 * Mirrors `_observationConfidenceToLevel` in sqlite-impl.ts. The constraint
 * "authored only when source is an authored doc" is enforced at the
 * `_buildCitation` call-site by passing `authored=true` only when
 * appropriate.
 */
export function confidenceToLevel(
  confidence: number,
  authored: boolean,
): CitationConfidence {
  if (authored && confidence >= 0.9) return 'authored'
  if (confidence >= 0.7) return 'inferred-high'
  if (confidence >= 0.4) return 'inferred-medium'
  return 'inferred-low'
}

/**
 * Build a Citation[] from a graph_nodes row.
 *
 * Strategy:
 *   1. If `properties.citations` is an array, prefer its entries.
 *   2. Otherwise synthesise from provenance back-links.
 */
function extractCitations(row: GraphNodeRow): Citation[] {
  const props = row.properties ?? {}
  const recordedAt = toDate(row.updatedAt ?? row.createdAt)
  const confidenceFromImportance = clamp01(row.importanceWeight)

  // 1. Explicit citations in properties — trust them.
  if (Array.isArray(props['citations'])) {
    const result: Citation[] = []
    for (const raw of props['citations']) {
      if (!raw || typeof raw !== 'object') continue
      const c = raw as Record<string, unknown>
      const id = typeof c['id'] === 'string' ? c['id'] : `${row.id}-citation-${result.length}`
      const source = c['source']
      if (!source || typeof source !== 'object') continue
      const confidence =
        typeof c['confidence'] === 'string' &&
        ['authored', 'inferred-high', 'inferred-medium', 'inferred-low'].includes(
          c['confidence'] as string,
        )
          ? (c['confidence'] as CitationConfidence)
          : confidenceToLevel(confidenceFromImportance, false)
      result.push({
        id,
        source: source as Citation['source'],
        confidence,
        recordedAt:
          typeof c['recordedAt'] === 'string' ? new Date(c['recordedAt']) : recordedAt,
        excerpt: typeof c['excerpt'] === 'string' ? c['excerpt'] : undefined,
      })
    }
    if (result.length > 0) return result
  }

  // 2. Synthesise from provenance back-links.
  const citations: Citation[] = []
  if (row.sourceObservationId) {
    citations.push({
      id: row.sourceObservationId,
      source: { kind: 'session', sessionId: row.sourceObservationId },
      confidence: confidenceToLevel(confidenceFromImportance, false),
      recordedAt,
    })
  }
  if (row.sourceSessionId) {
    citations.push({
      id: row.sourceSessionId,
      source: { kind: 'session', sessionId: row.sourceSessionId },
      confidence: confidenceToLevel(confidenceFromImportance, false),
      recordedAt,
    })
  }
  return citations
}

/**
 * Build the SDK ArchScope from a row's org/project columns.
 *
 * Platform rows always carry both — the SDK reads "project-level" as the
 * canonical interpretation, with org+project both populated for tenant
 * isolation.
 */
function rowScope(row: GraphNodeRow): ArchScope {
  return {
    level: 'project',
    orgId: row.orgId,
    projectId: row.projectId,
  }
}

export function rowToPattern(row: GraphNodeRow): ArchitecturalPattern {
  const props = row.properties ?? {}
  const locations = Array.isArray(props['locations'])
    ? (props['locations'] as Array<{ path: string; role?: string }>)
    : []
  const tags = Array.isArray(props['tags']) ? (props['tags'] as string[]) : []

  return {
    id: row.id,
    title: row.name,
    description: row.description ?? '',
    locations,
    tags,
    citations: extractCitations(row),
    scope: rowScope(row),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  }
}

export function rowToConvention(row: GraphNodeRow): Convention {
  const props = row.properties ?? {}
  const examples = Array.isArray(props['examples'])
    ? (props['examples'] as Array<{ path: string; excerpt?: string }>)
    : []
  const authored = props['authored'] === true

  return {
    id: row.id,
    title: row.name,
    description: row.description ?? '',
    examples,
    authored,
    citations: extractCitations(row),
    scope: rowScope(row),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  }
}

export function rowToDecision(row: GraphNodeRow): Decision {
  const props = row.properties ?? {}
  const chosen = typeof props['chosen'] === 'string' ? (props['chosen'] as string) : ''
  const alternatives = Array.isArray(props['alternatives'])
    ? (props['alternatives'] as Array<{ option: string; rejectionReason?: string }>)
    : []
  const rationale =
    typeof props['rationale'] === 'string' ? (props['rationale'] as string) : ''
  const status =
    typeof props['status'] === 'string' &&
    ['active', 'superseded', 'deprecated'].includes(props['status'] as string)
      ? (props['status'] as Decision['status'])
      : 'active'
  const supersedes =
    typeof props['supersedes'] === 'string' ? (props['supersedes'] as string) : undefined

  return {
    id: row.id,
    title: row.name,
    chosen,
    alternatives,
    rationale,
    status,
    supersedes,
    citations: extractCitations(row),
    scope: rowScope(row),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  }
}

export function rowToDeviation(row: GraphNodeRow): Deviation {
  const props = row.properties ?? {}
  const deviatesFrom =
    typeof props['deviatesFrom'] === 'object' && props['deviatesFrom']
      ? (props['deviatesFrom'] as Deviation['deviatesFrom'])
      : { kind: 'pattern' as const, patternId: 'unknown' }
  const introducedBy =
    typeof props['introducedBy'] === 'object' && props['introducedBy']
      ? (props['introducedBy'] as Deviation['introducedBy'])
      : undefined
  const status =
    typeof props['status'] === 'string' &&
    ['pending', 'intentional', 'unintentional', 'resolved'].includes(
      props['status'] as string,
    )
      ? (props['status'] as Deviation['status'])
      : 'pending'
  const severity =
    typeof props['severity'] === 'string' &&
    ['high', 'medium', 'low'].includes(props['severity'] as string)
      ? (props['severity'] as Deviation['severity'])
      : 'medium'

  return {
    id: row.id,
    title: row.name,
    description: row.description ?? '',
    deviatesFrom,
    introducedBy,
    status,
    severity,
    citations: extractCitations(row),
    scope: rowScope(row),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toDate(value: string | Date | null | undefined): Date {
  if (value instanceof Date) return value
  if (typeof value === 'string') return new Date(value)
  return new Date(0)
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
