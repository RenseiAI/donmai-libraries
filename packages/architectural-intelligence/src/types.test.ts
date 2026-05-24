/**
 * Type vocabulary tests for @donmai/architectural-intelligence
 *
 * Verifies:
 *   - CitationConfidence rank ordering (authored > inferred-high > inferred-medium > inferred-low)
 *   - Core type shapes are structurally correct (compile-time + runtime)
 *   - The "authored intent > inferences" constraint is expressed correctly
 */

import { describe, it, expect } from 'vitest'
import {
  CITATION_CONFIDENCE_RANK,
} from './types.js'
import type {
  Citation,
  ArchitecturalPattern,
  Convention,
  Decision,
  Deviation,
  DriftReport,
  ArchView,
  ArchObservation,
  ArchQuerySpec,
  ArchScope,
  ChangeRef,
  CitationConfidence,
} from './types.js'

// ---------------------------------------------------------------------------
// CitationConfidence rank ordering
// ---------------------------------------------------------------------------

describe('CitationConfidence rank ordering', () => {
  it('authored ranks highest', () => {
    expect(CITATION_CONFIDENCE_RANK['authored']).toBeGreaterThan(
      CITATION_CONFIDENCE_RANK['inferred-high'],
    )
  })

  it('inferred-high ranks above inferred-medium', () => {
    expect(CITATION_CONFIDENCE_RANK['inferred-high']).toBeGreaterThan(
      CITATION_CONFIDENCE_RANK['inferred-medium'],
    )
  })

  it('inferred-medium ranks above inferred-low', () => {
    expect(CITATION_CONFIDENCE_RANK['inferred-medium']).toBeGreaterThan(
      CITATION_CONFIDENCE_RANK['inferred-low'],
    )
  })

  it('authored rank is the maximum across all levels', () => {
    const allRanks = Object.values(CITATION_CONFIDENCE_RANK)
    const max = Math.max(...allRanks)
    expect(CITATION_CONFIDENCE_RANK['authored']).toBe(max)
  })

  it('inferred-low rank is the minimum across all levels', () => {
    const allRanks = Object.values(CITATION_CONFIDENCE_RANK)
    const min = Math.min(...allRanks)
    expect(CITATION_CONFIDENCE_RANK['inferred-low']).toBe(min)
  })
})

// ---------------------------------------------------------------------------
// Type shape validation (structural — compile-time enforcement + runtime sanity)
// ---------------------------------------------------------------------------

describe('Citation type shape', () => {
  it('can construct a file-source authored citation', () => {
    const scope: ArchScope = { level: 'project', projectId: 'proj-1' }
    const citation: Citation = {
      id: 'cit-1',
      source: { kind: 'file', path: 'CLAUDE.md', lineStart: 1, lineEnd: 10 },
      confidence: 'authored',
      recordedAt: new Date(),
    }
    expect(citation.confidence).toBe('authored')
    expect(citation.source.kind).toBe('file')
    void scope
  })

  it('can construct a change-source inferred citation', () => {
    const changeRef: ChangeRef = {
      repository: 'github.com/example/repo',
      kind: 'pr',
      prNumber: 42,
      description: 'Add auth middleware',
    }
    const citation: Citation = {
      id: 'cit-2',
      source: { kind: 'change', changeRef },
      confidence: 'inferred-high',
      recordedAt: new Date(),
      excerpt: 'Auth centralized in lib/auth',
    }
    expect(citation.confidence).toBe('inferred-high')
    expect(citation.excerpt).toBe('Auth centralized in lib/auth')
  })
})

describe('ArchitecturalPattern type shape', () => {
  it('can construct a valid pattern', () => {
    const scope: ArchScope = { level: 'project' }
    const citation: Citation = {
      id: 'cit-3',
      source: { kind: 'file', path: 'CLAUDE.md' },
      confidence: 'authored',
      recordedAt: new Date(),
    }
    const pattern: ArchitecturalPattern = {
      id: 'pat-1',
      title: 'Auth centralized in middleware',
      description: 'All auth checks go through lib/auth/middleware.ts',
      locations: [{ path: 'lib/auth/middleware.ts', role: 'central auth' }],
      tags: ['auth', 'middleware'],
      citations: [citation],
      scope,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(pattern.title).toBe('Auth centralized in middleware')
    expect(pattern.citations[0]?.confidence).toBe('authored')
  })
})

describe('Convention type shape', () => {
  it('distinguishes authored vs inferred conventions', () => {
    const scope: ArchScope = { level: 'project' }
    const authored: Convention = {
      id: 'conv-1',
      title: 'Result<T, E> error handling',
      description: 'All APIs use Result<T, E>; never throw raw errors.',
      examples: [{ path: 'packages/core/src/workarea/types.ts', excerpt: 'export type Result<T, E>' }],
      authored: true,
      citations: [],
      scope,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const inferred: Convention = {
      ...authored,
      id: 'conv-2',
      authored: false,
    }
    expect(authored.authored).toBe(true)
    expect(inferred.authored).toBe(false)
  })
})

describe('Decision type shape', () => {
  it('can construct a valid decision with alternatives', () => {
    const scope: ArchScope = { level: 'project' }
    const decision: Decision = {
      id: 'dec-1',
      title: 'Drizzle over Prisma',
      chosen: 'Drizzle ORM',
      alternatives: [{ option: 'Prisma', rejectionReason: 'No edge-runtime support' }],
      rationale: 'Edge-runtime support was required for the deployment target.',
      status: 'active',
      citations: [],
      scope,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(decision.chosen).toBe('Drizzle ORM')
    expect(decision.alternatives).toHaveLength(1)
    expect(decision.status).toBe('active')
  })
})

describe('Deviation type shape', () => {
  it('can construct a deviation referencing a pattern', () => {
    const scope: ArchScope = { level: 'project' }
    const deviation: Deviation = {
      id: 'dev-1',
      title: 'Auth check missing in /api/public route',
      description: 'Route /api/public/health bypasses auth middleware without documented reason.',
      deviatesFrom: { kind: 'pattern', patternId: 'pat-1' },
      status: 'pending',
      severity: 'high',
      citations: [],
      scope,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(deviation.severity).toBe('high')
    expect(deviation.deviatesFrom.kind).toBe('pattern')
  })
})

describe('DriftReport type shape', () => {
  it('can construct an empty DriftReport', () => {
    const change: ChangeRef = { repository: 'github.com/example/repo', kind: 'commit', sha: 'abc123' }
    const report: DriftReport = {
      change,
      deviations: [],
      reinforced: [],
      hasCriticalDrift: false,
      summary: 'No drift detected.',
      assessedAt: new Date(),
    }
    expect(report.hasCriticalDrift).toBe(false)
    expect(report.deviations).toHaveLength(0)
  })
})

describe('ArchView type shape', () => {
  it('can construct a minimal ArchView', () => {
    const scope: ArchScope = { level: 'project' }
    const view: ArchView = {
      patterns: [],
      conventions: [],
      decisions: [],
      citations: [],
      scope,
      retrievedAt: new Date(),
    }
    expect(view.patterns).toHaveLength(0)
    expect(view.drift).toBeUndefined()
  })
})

describe('ArchObservation type shape', () => {
  it('authored-doc source maps correctly', () => {
    const scope: ArchScope = { level: 'project' }
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'Test', description: 'Test pattern' },
      source: {
        authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' },
      },
      confidence: 0.95,
      scope,
    }
    expect(obs.confidence).toBe(0.95)
    expect(obs.source.authoredDoc?.kind).toBe('claude-md')
  })

  it('inferred source with session id maps correctly', () => {
    const scope: ArchScope = { level: 'project' }
    const obs: ArchObservation = {
      kind: 'convention',
      payload: { title: 'Test convention' },
      source: { sessionId: 'sess-abc123' },
      confidence: 0.65,
      scope,
    }
    expect(obs.confidence).toBe(0.65)
    expect(obs.source.sessionId).toBe('sess-abc123')
  })
})

describe('ArchQuerySpec type shape', () => {
  it('allows workType and scope only (minimal)', () => {
    const spec: ArchQuerySpec = {
      workType: 'development',
      scope: { level: 'project' },
    }
    expect(spec.workType).toBe('development')
    expect(spec.paths).toBeUndefined()
  })

  it('allows full spec', () => {
    const spec: ArchQuerySpec = {
      workType: 'qa',
      paths: ['packages/core/src/', 'packages/server/'],
      issueId: 'REN-999',
      scope: { level: 'project', projectId: 'proj-1' },
      maxTokens: 4096,
      includeActiveDrift: true,
    }
    expect(spec.includeActiveDrift).toBe(true)
    expect(spec.paths).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Authored > inferred constraint: sorting demonstration
// ---------------------------------------------------------------------------

describe('authored intent > inferences constraint', () => {
  it('sorting by confidence rank places authored citations first', () => {
    const citations: Array<{ id: string; confidence: CitationConfidence }> = [
      { id: '1', confidence: 'inferred-low' },
      { id: '2', confidence: 'authored' },
      { id: '3', confidence: 'inferred-medium' },
      { id: '4', confidence: 'inferred-high' },
    ]

    const sorted = [...citations].sort(
      (a, b) =>
        CITATION_CONFIDENCE_RANK[b.confidence] - CITATION_CONFIDENCE_RANK[a.confidence],
    )

    expect(sorted[0]?.confidence).toBe('authored')
    expect(sorted[1]?.confidence).toBe('inferred-high')
    expect(sorted[2]?.confidence).toBe('inferred-medium')
    expect(sorted[3]?.confidence).toBe('inferred-low')
  })
})
