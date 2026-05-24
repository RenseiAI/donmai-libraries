import { describe, it, expect, vi } from 'vitest'
import { createArchitecturalIntelligencePlugin } from '../architectural-intelligence-plugin.js'
import type {
  ArchitecturalIntelligence,
  ArchView,
  ArchitecturalPattern,
  Convention,
  Decision,
  Deviation,
  Citation,
  DriftReport,
} from '@donmai/architectural-intelligence'

// ── Test fixtures ────────────────────────────────────────────────────

function citation(id = 'c1'): Citation {
  return {
    id,
    source: { kind: 'file', path: 'src/x.ts' },
    confidence: 'inferred-high',
    recordedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

function pattern(overrides: Partial<ArchitecturalPattern> = {}): ArchitecturalPattern {
  return {
    id: 'p1',
    title: 'Centralized Auth Middleware',
    description: 'All routes delegate to a single auth middleware',
    locations: [{ path: 'src/auth/middleware.ts' }],
    tags: ['auth'],
    citations: [citation()],
    scope: { level: 'project', projectId: 'proj-1' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function convention(overrides: Partial<Convention> = {}): Convention {
  return {
    id: 'cv1',
    title: 'Result<T, E> return type',
    description: 'API routes return Result rather than throwing',
    examples: [{ path: 'src/workarea/types.ts' }],
    authored: false,
    citations: [citation('c2')],
    scope: { level: 'project', projectId: 'proj-1' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    title: 'Drizzle over Prisma',
    chosen: 'drizzle-orm',
    alternatives: [{ option: 'prisma', rejectionReason: 'no edge runtime' }],
    rationale: 'Edge runtime support is required',
    status: 'active',
    citations: [citation('c3')],
    scope: { level: 'project', projectId: 'proj-1' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function deviation(overrides: Partial<Deviation> = {}): Deviation {
  return {
    id: 'dv1',
    title: 'Inline auth in /api/foo',
    description: 'Skips the central middleware',
    deviatesFrom: { kind: 'pattern', patternId: 'p1' },
    status: 'pending',
    severity: 'high',
    citations: [citation('c4')],
    scope: { level: 'project', projectId: 'proj-1' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function driftReport(deviations: Deviation[]): DriftReport {
  return {
    change: { repository: 'github.com/r/x', kind: 'branch', branch: 'feat/x' },
    deviations,
    reinforced: [],
    hasCriticalDrift: deviations.some(d => d.severity === 'high'),
    summary: `${deviations.length} deviations`,
    assessedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

function archView(over: Partial<ArchView> = {}): ArchView {
  return {
    patterns: [pattern()],
    conventions: [convention()],
    decisions: [decision()],
    citations: [citation(), citation('c2'), citation('c3')],
    drift: driftReport([deviation()]),
    scope: { level: 'project', projectId: 'proj-1' },
    retrievedAt: new Date('2026-05-19T00:00:00Z'),
    ...over,
  }
}

function makeAi(view: ArchView = archView()): {
  ai: ArchitecturalIntelligence
  queryMock: ReturnType<typeof vi.fn>
} {
  const queryMock = vi.fn().mockResolvedValue(view)
  const ai: ArchitecturalIntelligence = {
    query: queryMock as ArchitecturalIntelligence['query'],
    contribute: vi.fn().mockResolvedValue(undefined),
    synthesize: vi.fn().mockResolvedValue(''),
    assess: vi.fn().mockResolvedValue(driftReport([])),
  }
  return { ai, queryMock }
}

const ctx = { env: {}, cwd: '/tmp' }

// ── Plugin shape ─────────────────────────────────────────────────────

describe('createArchitecturalIntelligencePlugin', () => {
  it('has correct name and description', () => {
    const { ai } = makeAi()
    const plugin = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai })
    expect(plugin.name).toBe('af-architectural-intelligence')
    expect(plugin.description).toBeTruthy()
  })

  it('exposes exactly two tools by default', () => {
    const { ai } = makeAi()
    const tools = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai }).createTools(ctx)
    expect(tools).toHaveLength(2)
    const names = tools.map(t => t.name)
    expect(names).toContain('af_arch_query')
    expect(names).toContain('af_arch_drift')
  })

  it('exposes no tools when disabled', () => {
    const { ai } = makeAi()
    const tools = createArchitecturalIntelligencePlugin({
      architecturalIntelligence: ai,
      enabled: false,
    }).createTools(ctx)
    expect(tools).toEqual([])
  })

  it('all tools have descriptions + input schemas', () => {
    const { ai } = makeAi()
    const tools = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai }).createTools(ctx)
    for (const t of tools) {
      expect(t.description).toBeTruthy()
      expect(t.inputSchema).toBeDefined()
    }
  })
})

// ── af_arch_query ────────────────────────────────────────────────────

describe('af_arch_query', () => {
  function getQueryTool(ai: ArchitecturalIntelligence) {
    const tools = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai }).createTools(ctx)
    return tools.find(t => t.name === 'af_arch_query')!
  }

  it('forwards project_id into scope and returns full view', async () => {
    const { ai, queryMock } = makeAi()
    const result = await getQueryTool(ai).handler({ project_id: 'proj-42' }, {})

    expect(queryMock).toHaveBeenCalledOnce()
    const spec = queryMock.mock.calls[0][0]
    expect(spec.scope).toEqual({ level: 'project', projectId: 'proj-42' })
    expect(spec.workType).toBe('development')
    expect(spec.includeActiveDrift).toBe(true)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.patterns).toHaveLength(1)
    expect(parsed.conventions).toHaveLength(1)
    expect(parsed.decisions).toHaveLength(1)
    expect(parsed.driftDeviations).toHaveLength(1)
    expect(parsed.scope).toEqual({ level: 'project', projectId: 'proj-1' })
  })

  it('filters by query substring on patterns/conventions/decisions/deviations', async () => {
    const view = archView({
      patterns: [
        pattern({ id: 'p1', title: 'Auth Middleware', description: 'central auth' }),
        pattern({ id: 'p2', title: 'Cache layer', description: 'redis cache' }),
      ],
      conventions: [
        convention({ id: 'cv1', title: 'Result<T, E>', description: 'no throw' }),
        convention({ id: 'cv2', title: 'Auth headers', description: 'forward auth' }),
      ],
      decisions: [
        decision({ id: 'd1', title: 'Drizzle over Prisma', rationale: 'edge runtime' }),
        decision({ id: 'd2', title: 'Use Redis', rationale: 'cache' }),
      ],
      drift: driftReport([
        deviation({ id: 'dv1', title: 'Inline auth bypass', description: 'skips middleware' }),
        deviation({ id: 'dv2', title: 'Cache miss handler', description: 'fallback' }),
      ]),
    })
    const { ai } = makeAi(view)
    const result = await getQueryTool(ai).handler({ project_id: 'proj-1', query: 'auth' }, {})
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.patterns.map((p: { id: string }) => p.id)).toEqual(['p1'])
    expect(parsed.conventions.map((c: { id: string }) => c.id)).toEqual(['cv2'])
    expect(parsed.decisions).toHaveLength(0)
    expect(parsed.driftDeviations.map((d: { id: string }) => d.id)).toEqual(['dv1'])
  })

  it('applies a per-category limit and sets truncated when over', async () => {
    const view = archView({
      patterns: [
        pattern({ id: 'p1' }),
        pattern({ id: 'p2' }),
        pattern({ id: 'p3' }),
      ],
    })
    const { ai } = makeAi(view)
    const result = await getQueryTool(ai).handler({ project_id: 'proj-1', limit: 2 }, {})
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.patterns).toHaveLength(2)
    expect(parsed.truncated).toBe(true)
  })

  it('forwards optional paths, issue_id, work_type, max_tokens, include_drift', async () => {
    const { ai, queryMock } = makeAi()
    await getQueryTool(ai).handler(
      {
        project_id: 'proj-1',
        paths: ['src/foo'],
        issue_id: 'REN-1',
        work_type: 'qa',
        max_tokens: 4096,
        include_drift: false,
      },
      {},
    )
    const spec = queryMock.mock.calls[0][0]
    expect(spec.paths).toEqual(['src/foo'])
    expect(spec.issueId).toBe('REN-1')
    expect(spec.workType).toBe('qa')
    expect(spec.maxTokens).toBe(4096)
    expect(spec.includeActiveDrift).toBe(false)
  })

  it('rejects empty project_id', async () => {
    const { ai } = makeAi()
    const result = await getQueryTool(ai).handler({ project_id: '   ' }, {})
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('project_id is required')
  })

  it('returns structured error when SDK throws', async () => {
    const ai: ArchitecturalIntelligence = {
      query: vi.fn().mockRejectedValue(new Error('upstream gateway 503')),
      contribute: vi.fn(),
      synthesize: vi.fn(),
      assess: vi.fn(),
    }
    const tools = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai }).createTools(ctx)
    const result = await tools.find(t => t.name === 'af_arch_query')!.handler({ project_id: 'proj-1' }, {})
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('upstream gateway 503')
  })

  it('honors plugin-level defaultWorkType and defaultMaxTokens', async () => {
    const { ai, queryMock } = makeAi()
    const plugin = createArchitecturalIntelligencePlugin({
      architecturalIntelligence: ai,
      defaultWorkType: 'refinement',
      defaultMaxTokens: 8192,
    })
    const tools = plugin.createTools(ctx)
    await tools.find(t => t.name === 'af_arch_query')!.handler({ project_id: 'proj-1' }, {})
    const spec = queryMock.mock.calls[0][0]
    expect(spec.workType).toBe('refinement')
    expect(spec.maxTokens).toBe(8192)
  })
})

// ── af_arch_drift ────────────────────────────────────────────────────

describe('af_arch_drift', () => {
  function getDriftTool(ai: ArchitecturalIntelligence) {
    const tools = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai }).createTools(ctx)
    return tools.find(t => t.name === 'af_arch_drift')!
  }

  it("queries with workType 'qa' by default and surfaces drift only", async () => {
    const { ai, queryMock } = makeAi()
    const result = await getDriftTool(ai).handler({ project_id: 'proj-1' }, {})

    const spec = queryMock.mock.calls[0][0]
    expect(spec.workType).toBe('qa')
    expect(spec.scope).toEqual({ level: 'project', projectId: 'proj-1' })
    expect(spec.includeActiveDrift).toBe(true)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.projectId).toBe('proj-1')
    expect(parsed.hasCriticalDrift).toBe(true)
    expect(parsed.deviations).toHaveLength(1)
    expect(parsed.deviationCounts).toEqual({ high: 1, medium: 0, low: 0, total: 1 })
  })

  it('sorts deviations by severity high → medium → low', async () => {
    const view = archView({
      drift: driftReport([
        deviation({ id: 'dv-low', severity: 'low', title: 'low item' }),
        deviation({ id: 'dv-high', severity: 'high', title: 'high item' }),
        deviation({ id: 'dv-medium', severity: 'medium', title: 'medium item' }),
      ]),
    })
    const { ai } = makeAi(view)
    const result = await getDriftTool(ai).handler({ project_id: 'proj-1' }, {})
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.deviations.map((d: { id: string }) => d.id)).toEqual(['dv-high', 'dv-medium', 'dv-low'])
    expect(parsed.deviationCounts).toEqual({ high: 1, medium: 1, low: 1, total: 3 })
  })

  it('caps deviations by limit', async () => {
    const view = archView({
      drift: driftReport([
        deviation({ id: 'a', severity: 'high' }),
        deviation({ id: 'b', severity: 'high' }),
        deviation({ id: 'c', severity: 'medium' }),
      ]),
    })
    const { ai } = makeAi(view)
    const result = await getDriftTool(ai).handler({ project_id: 'proj-1', limit: 2 }, {})
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.deviations).toHaveLength(2)
  })

  it('returns empty deviation list when drift section is absent', async () => {
    const view = archView({ drift: undefined })
    const { ai } = makeAi(view)
    const result = await getDriftTool(ai).handler({ project_id: 'proj-1' }, {})
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.deviations).toEqual([])
    expect(parsed.hasCriticalDrift).toBe(false)
    expect(parsed.summary).toBe('')
  })

  it('rejects empty project_id', async () => {
    const { ai } = makeAi()
    const result = await getDriftTool(ai).handler({ project_id: '' }, {})
    expect(result.isError).toBe(true)
  })

  it('propagates SDK errors as tool errors', async () => {
    const ai: ArchitecturalIntelligence = {
      query: vi.fn().mockRejectedValue(new Error('db connection refused')),
      contribute: vi.fn(),
      synthesize: vi.fn(),
      assess: vi.fn(),
    }
    const tools = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai }).createTools(ctx)
    const result = await tools.find(t => t.name === 'af_arch_drift')!.handler({ project_id: 'proj-1' }, {})
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('db connection refused')
  })
})
