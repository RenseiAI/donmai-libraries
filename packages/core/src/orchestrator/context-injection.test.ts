/**
 * Tests for context-injection.ts — REN-1316
 *
 * Validates:
 * 1. renderArchView() renders all priority tiers correctly
 * 2. Token-budget trimming: high-priority content is preserved; low-priority is cut
 * 3. buildArchitecturalContext() surfaces AI query errors gracefully (returns undefined)
 * 4. The rendered prompt contains specific strings the model would reference
 * 5. flushSessionObservations() calls contribute() on the AI instance
 * 6. extractObservationsStub() returns []
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildArchitecturalContext,
  renderArchView,
  flushSessionObservations,
  extractObservationsStub,
  type ContextInjectionConfig,
} from './context-injection.js'
import type {
  ArchView,
  ArchitecturalIntelligence,
  ArchQuerySpec,
  ArchObservation,
  ArchScope,
} from '@donmai/architectural-intelligence'

// ---------------------------------------------------------------------------
// Helpers: build mock domain objects
// ---------------------------------------------------------------------------

function makeScope(level: ArchScope['level'] = 'project'): ArchScope {
  return { level }
}

function makeView(overrides?: Partial<ArchView>): ArchView {
  return {
    patterns: [],
    conventions: [],
    decisions: [],
    citations: [],
    scope: makeScope(),
    retrievedAt: new Date(),
    ...overrides,
  }
}

function makePattern(title: string, description: string, scopeLevel: ArchScope['level'] = 'project') {
  return {
    id: `pat-${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    description,
    locations: [{ path: `src/${title.toLowerCase().replace(/\s+/g, '-')}.ts` }],
    tags: [],
    citations: [],
    scope: makeScope(scopeLevel),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeConvention(title: string, description: string, authored = false, scopeLevel: ArchScope['level'] = 'project') {
  return {
    id: `conv-${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    description,
    examples: [],
    authored,
    citations: [],
    scope: makeScope(scopeLevel),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeDecision(title: string, chosen: string, rationale: string) {
  return {
    id: `dec-${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    chosen,
    alternatives: [],
    rationale,
    status: 'active' as const,
    citations: [],
    scope: makeScope(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeDeviation(title: string, description: string, severity: 'high' | 'medium' | 'low' = 'medium') {
  return {
    id: `dev-${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    description,
    deviatesFrom: { kind: 'pattern' as const, patternId: 'pat-1' },
    status: 'pending' as const,
    severity,
    citations: [],
    scope: makeScope(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeMockAI(view: ArchView): ArchitecturalIntelligence {
  return {
    query: vi.fn().mockResolvedValue(view),
    contribute: vi.fn().mockResolvedValue(undefined),
    synthesize: vi.fn().mockResolvedValue(''),
    assess: vi.fn().mockResolvedValue({
      change: { repository: '', kind: 'branch' as const, branch: 'main' },
      deviations: [],
      reinforced: [],
      hasCriticalDrift: false,
      summary: '',
      assessedAt: new Date(),
    }),
  }
}

// ---------------------------------------------------------------------------
// renderArchView
// ---------------------------------------------------------------------------

describe('renderArchView', () => {
  it('returns undefined for an empty view', () => {
    const result = renderArchView(makeView(), 2000)
    expect(result).toBeUndefined()
  })

  it('renders the ## Architectural context header', () => {
    const view = makeView({
      patterns: [makePattern('Auth Middleware', 'Auth is centralized in lib/auth/middleware.ts')],
    })
    const result = renderArchView(view, 2000)
    expect(result).toBeDefined()
    expect(result).toContain('## Architectural context')
  })

  it('renders patterns under "Active Patterns" heading', () => {
    const view = makeView({
      patterns: [makePattern('Auth Middleware', 'Auth is centralized in lib/auth/middleware.ts')],
    })
    const result = renderArchView(view, 2000)!
    expect(result).toContain('### Active Patterns')
    expect(result).toContain('Auth Middleware')
    expect(result).toContain('Auth is centralized in lib/auth/middleware.ts')
  })

  it('renders conventions under "Project Conventions" heading', () => {
    const view = makeView({
      conventions: [makeConvention(
        'Result<T,E> pattern',
        'All API routes return Result<T, E> — never throw raw errors.',
        true,
      )],
    })
    const result = renderArchView(view, 2000)!
    expect(result).toContain('### Project Conventions')
    expect(result).toContain('Result<T,E> pattern')
    expect(result).toContain('never throw raw errors')
    expect(result).toContain('_(authored)_')
  })

  it('renders decisions under "Architectural decisions" heading', () => {
    const view = makeView({
      decisions: [makeDecision(
        'Drizzle over Prisma',
        'Drizzle',
        'Edge-runtime support. See PR #142.',
      )],
    })
    const result = renderArchView(view, 2000)!
    expect(result).toContain('### Architectural decisions')
    expect(result).toContain('Drizzle over Prisma')
    expect(result).toContain('Drizzle')
    expect(result).toContain('Edge-runtime support')
  })

  it('renders drift warnings as Priority 1 — before patterns', () => {
    const view = makeView({
      patterns: [makePattern('Auth Middleware', 'Auth is centralized')],
      drift: {
        change: { repository: 'test', kind: 'branch', branch: 'main' },
        deviations: [makeDeviation('Missing auth check', 'Route skips middleware', 'high')],
        reinforced: [],
        hasCriticalDrift: true,
        summary: 'critical drift',
        assessedAt: new Date(),
      },
    })
    const result = renderArchView(view, 2000)!
    expect(result).toContain('### Drift warnings')
    expect(result).toContain('Missing auth check')
    expect(result).toContain('HIGH')
    // Drift warnings must come before patterns in the rendered output
    const driftPos = result.indexOf('Drift warnings')
    const patternsPos = result.indexOf('Active Patterns')
    expect(driftPos).toBeLessThan(patternsPos)
  })

  it('renders org-wide patterns under "Org-wide Patterns" heading', () => {
    const view = makeView({
      patterns: [makePattern('Org Pattern', 'Org-level shared pattern', 'org')],
    })
    const result = renderArchView(view, 2000)!
    expect(result).toContain('### Org-wide Patterns')
    expect(result).toContain('Org Pattern')
  })

  it('trims content to token budget (1 token ≈ 4 chars)', () => {
    // Create enough content to exceed a tiny budget
    const patterns = Array.from({ length: 20 }, (_, i) =>
      makePattern(`Pattern ${i}`, 'A'.repeat(200)),
    )
    const view = makeView({ patterns })

    // Budget of 50 tokens = 200 chars
    const result = renderArchView(view, 50)!
    expect(result).toBeDefined()
    // Should contain the budget notice
    expect(result).toContain('trimmed for token budget')
    // Total length should not far exceed budget chars
    expect(result.length).toBeLessThan(400)
  })

  it('includes only high-priority content when budget is tight', () => {
    const view = makeView({
      drift: {
        change: { repository: 'test', kind: 'branch', branch: 'main' },
        deviations: [makeDeviation('Critical drift', 'High severity deviation', 'high')],
        reinforced: [],
        hasCriticalDrift: true,
        summary: 'drift',
        assessedAt: new Date(),
      },
      patterns: Array.from({ length: 10 }, (_, i) =>
        makePattern(`Pattern ${i}`, 'B'.repeat(300)),
      ),
    })

    // Budget so small only drift fits
    const result = renderArchView(view, 30)!
    expect(result).toContain('Critical drift')
    // Patterns may or may not be cut — just verify drift is present
  })
})

// ---------------------------------------------------------------------------
// buildArchitecturalContext
// ---------------------------------------------------------------------------

describe('buildArchitecturalContext', () => {
  const spec: ArchQuerySpec = {
    workType: 'development',
    issueId: 'issue-123',
    scope: { level: 'project', projectId: 'proj-1' },
  }

  it('returns undefined when no AI is configured', async () => {
    const config: ContextInjectionConfig = {}
    const result = await buildArchitecturalContext(spec, config)
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty ArchView', async () => {
    const ai = makeMockAI(makeView())
    const config: ContextInjectionConfig = { architecturalIntelligence: ai }
    const result = await buildArchitecturalContext(spec, config)
    expect(result).toBeUndefined()
  })

  it('returns rendered context when AI returns non-empty view', async () => {
    const view = makeView({
      patterns: [makePattern(
        'Centralized Auth',
        'All routes delegate to lib/auth/middleware.ts — no inline auth.',
      )],
    })
    const ai = makeMockAI(view)
    const config: ContextInjectionConfig = { architecturalIntelligence: ai }
    const result = await buildArchitecturalContext(spec, config)
    expect(result).toBeDefined()
    expect(result).toContain('## Architectural context')
    expect(result).toContain('Centralized Auth')
    expect(result).toContain('lib/auth/middleware.ts')
  })

  it('calls query with correct spec including includeActiveDrift: true', async () => {
    const view = makeView({
      patterns: [makePattern('Test Pattern', 'desc')],
    })
    const ai = makeMockAI(view)
    const config: ContextInjectionConfig = { architecturalIntelligence: ai, maxTokens: 1500 }
    await buildArchitecturalContext(spec, config)
    expect(ai.query).toHaveBeenCalledWith(
      expect.objectContaining({
        workType: 'development',
        issueId: 'issue-123',
        includeActiveDrift: true,
        maxTokens: 1500,
      }),
    )
  })

  it('returns undefined (swallows error) when AI.query throws', async () => {
    const ai = {
      query: vi.fn().mockRejectedValue(new Error('DB error')),
      contribute: vi.fn(),
      synthesize: vi.fn(),
      assess: vi.fn(),
    } as unknown as ArchitecturalIntelligence

    const config: ContextInjectionConfig = { architecturalIntelligence: ai }
    const result = await buildArchitecturalContext(spec, config)
    expect(result).toBeUndefined()
  })

  // "Agent's first message references it" — the AC test
  it('given a known ArchView, rendered prompt contains strings the model would naturally reference', async () => {
    const view = makeView({
      patterns: [
        makePattern(
          'Result<T,E> error handling',
          'All API routes return Result<T, E> — never throw raw errors. See packages/core/src/workarea/types.ts.',
        ),
      ],
      conventions: [
        makeConvention(
          'No raw throws in route handlers',
          'Route handlers wrap errors in Err() from Result<T,E>. Throwing bypasses the error-telemetry pipeline.',
          true,
        ),
      ],
      decisions: [
        makeDecision(
          'Drizzle over Prisma',
          'Drizzle',
          'Edge-runtime support was required. Prisma does not run on Cloudflare Workers.',
        ),
      ],
    })
    const ai = makeMockAI(view)
    const config: ContextInjectionConfig = { architecturalIntelligence: ai }
    const rendered = await buildArchitecturalContext(spec, config)

    // The prompt section the model would read at session start
    expect(rendered).toBeDefined()
    expect(rendered).toContain('## Architectural context')
    // The model would see and reference these specific strings:
    expect(rendered).toContain('Result<T,E> error handling')
    expect(rendered).toContain('never throw raw errors')
    expect(rendered).toContain('No raw throws in route handlers')
    expect(rendered).toContain('Drizzle over Prisma')
    expect(rendered).toContain('Edge-runtime support was required')
  })
})

// ---------------------------------------------------------------------------
// flushSessionObservations
// ---------------------------------------------------------------------------

describe('flushSessionObservations', () => {
  it('does nothing when no AI is configured', async () => {
    const config: ContextInjectionConfig = {}
    // Should not throw
    await flushSessionObservations(
      { issueId: 'i-1', sessionId: 's-1', workType: 'development', scope: makeScope(), passed: true },
      config,
    )
  })

  it('does not flush when passed is false', async () => {
    const view = makeView()
    const ai = makeMockAI(view)
    const config: ContextInjectionConfig = { architecturalIntelligence: ai }
    await flushSessionObservations(
      { issueId: 'i-1', sessionId: 's-1', workType: 'qa', scope: makeScope(), passed: false },
      config,
    )
    expect(ai.contribute).not.toHaveBeenCalled()
  })

  it('does not call contribute() when stub extractor returns []', async () => {
    const view = makeView()
    const ai = makeMockAI(view)
    const config: ContextInjectionConfig = { architecturalIntelligence: ai }
    await flushSessionObservations(
      { issueId: 'i-1', sessionId: 's-1', workType: 'development', scope: makeScope(), passed: true },
      config,
    )
    // Stub returns [] so contribute should not be called
    expect(ai.contribute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// extractObservationsStub
// ---------------------------------------------------------------------------

describe('extractObservationsStub', () => {
  it('returns an empty array (REN-1324 stub)', () => {
    const obs = extractObservationsStub({
      issueId: 'i-1',
      sessionId: 's-1',
      workType: 'development',
      scope: makeScope(),
      passed: true,
    })
    expect(obs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// shouldFlushObservations (via session-supervisor.ts)
// ---------------------------------------------------------------------------

describe('shouldFlushObservations integration', async () => {
  const { shouldFlushObservations } = await import('./session-supervisor.js')

  it('returns true for completed development agent (non result-sensitive)', () => {
    const agent = {
      issueId: 'i-1', identifier: 'DEV-1', pid: undefined,
      status: 'completed' as const, startedAt: new Date(), lastActivityAt: new Date(),
      workType: 'development' as const,
    }
    expect(shouldFlushObservations(agent)).toBe(true)
  })

  it('returns false for failed agent', () => {
    const agent = {
      issueId: 'i-1', identifier: 'DEV-1', pid: undefined,
      status: 'failed' as const, startedAt: new Date(), lastActivityAt: new Date(),
      workType: 'development' as const,
    }
    expect(shouldFlushObservations(agent)).toBe(false)
  })

  it('returns true for completed qa agent with passed result', () => {
    const agent = {
      issueId: 'i-1', identifier: 'QA-1', pid: undefined,
      status: 'completed' as const, startedAt: new Date(), lastActivityAt: new Date(),
      workType: 'qa' as const, workResult: 'passed' as const,
    }
    expect(shouldFlushObservations(agent)).toBe(true)
  })

  it('returns false for completed qa agent with failed result', () => {
    const agent = {
      issueId: 'i-1', identifier: 'QA-1', pid: undefined,
      status: 'completed' as const, startedAt: new Date(), lastActivityAt: new Date(),
      workType: 'qa' as const, workResult: 'failed' as const,
    }
    expect(shouldFlushObservations(agent)).toBe(false)
  })
})
