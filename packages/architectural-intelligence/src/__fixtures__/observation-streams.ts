/**
 * Golden fixture observation streams for eval and regression tests.
 *
 * REN-1325: These fixtures represent canonical input streams used to evaluate
 * synthesis prompt quality. Tests compare actual LLM output (mocked) against
 * curated golden examples below.
 *
 * Fixture naming convention:
 *   FIXTURE_<STREAM_NAME>_INPUT     — the raw observation stream
 *   FIXTURE_<STREAM_NAME>_GOLDEN_*  — curated expected outputs per prompt kind
 *
 * When adding new fixtures, also add a corresponding golden output for each
 * prompt kind. Use real examples from the codebase when possible.
 */

import type { ArchObservation, ArchScope } from '../types.js'
import type { BaselineEntry } from '../prompts/index.js'

// ---------------------------------------------------------------------------
// Shared scope
// ---------------------------------------------------------------------------

const PROJECT_SCOPE: ArchScope = {
  level: 'project',
  projectId: 'agentfactory',
}

// ---------------------------------------------------------------------------
// Fixture 1: Auth centralization stream
// Simulates observations from a PR that centralizes auth middleware.
// ---------------------------------------------------------------------------

export const FIXTURE_AUTH_STREAM_INPUT: ArchObservation[] = [
  {
    kind: 'pattern',
    payload: {
      title: 'Auth middleware usage',
      description: 'Route handler in src/routes/api/users.ts delegates to lib/auth/middleware.ts',
      tags: ['auth', 'middleware'],
      locations: [{ path: 'src/routes/api/users.ts' }],
    },
    source: { sessionId: 'session-001' },
    confidence: 0.70,
    scope: PROJECT_SCOPE,
  },
  {
    kind: 'pattern',
    payload: {
      title: 'Auth delegation pattern',
      description: 'Route handler in src/routes/api/posts.ts delegates to lib/auth/middleware.ts for all POST operations',
      tags: ['auth', 'middleware'],
      locations: [{ path: 'src/routes/api/posts.ts' }],
    },
    source: { sessionId: 'session-001' },
    confidence: 0.65,
    scope: PROJECT_SCOPE,
  },
  {
    kind: 'pattern',
    payload: {
      title: 'Central auth point',
      description: 'lib/auth/middleware.ts is the sole location where JWT verification occurs',
      tags: ['auth', 'jwt', 'security'],
      locations: [{ path: 'lib/auth/middleware.ts', role: 'central auth handler' }],
    },
    source: { sessionId: 'session-001' },
    confidence: 0.75,
    scope: PROJECT_SCOPE,
  },
]

/**
 * Golden output for pattern extraction on the auth centralization stream.
 * Curated: we expect the LLM to merge the three observations into ONE pattern.
 */
export const FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS: ArchObservation[] = [
  {
    kind: 'pattern',
    payload: {
      title: 'Auth is centralized in lib/auth/middleware.ts',
      description:
        'All API routes delegate authentication to lib/auth/middleware.ts. JWT verification is concentrated there; route handlers never implement auth inline.',
      locations: [
        { path: 'lib/auth/middleware.ts', role: 'central auth handler' },
        { path: 'src/routes/api/users.ts' },
        { path: 'src/routes/api/posts.ts' },
      ],
      tags: ['auth', 'middleware', 'jwt', 'security'],
    },
    source: { sessionId: 'session-001' },
    confidence: 0.75,
    scope: PROJECT_SCOPE,
  },
]

// ---------------------------------------------------------------------------
// Fixture 2: Result<T,E> convention stream
// Simulates observations from multiple PRs establishing an error-handling convention.
// ---------------------------------------------------------------------------

export const FIXTURE_RESULT_STREAM_INPUT: ArchObservation[] = [
  {
    kind: 'convention',
    payload: {
      title: 'Result type usage',
      description: 'packages/core/src/workarea/types.ts defines Result<T,E> used across routes',
      examples: [{ path: 'packages/core/src/workarea/types.ts', excerpt: 'type Result<T,E> = ...' }],
      authored: false,
    },
    source: { sessionId: 'session-002' },
    confidence: 0.60,
    scope: PROJECT_SCOPE,
  },
  {
    kind: 'convention',
    payload: {
      title: 'No throwing in API handlers',
      description: 'API handlers return Result<T,E> instead of throwing — seen in 3 recent PRs',
      examples: [
        { path: 'src/routes/api/users.ts' },
        { path: 'src/routes/api/posts.ts' },
      ],
      authored: false,
    },
    source: { sessionId: 'session-002' },
    confidence: 0.55,
    scope: PROJECT_SCOPE,
  },
]

/**
 * Golden output for convention identification on the Result stream.
 */
export const FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS: ArchObservation[] = [
  {
    kind: 'convention',
    payload: {
      title: 'All API routes use Result<T,E> — never throw raw errors',
      description:
        'API handlers return Result<T,E> (defined in packages/core/src/workarea/types.ts) instead of throwing exceptions. This keeps error handling explicit and prevents unhandled rejections.',
      examples: [
        { path: 'packages/core/src/workarea/types.ts', excerpt: 'type Result<T,E> = ...' },
        { path: 'src/routes/api/users.ts' },
        { path: 'src/routes/api/posts.ts' },
      ],
      authored: false,
    },
    source: { sessionId: 'session-002' },
    confidence: 0.60,
    scope: PROJECT_SCOPE,
  },
]

// ---------------------------------------------------------------------------
// Fixture 3: Drizzle decision stream
// Simulates observations from a PR choosing Drizzle over Prisma.
// ---------------------------------------------------------------------------

export const FIXTURE_DECISION_STREAM_INPUT: ArchObservation[] = [
  {
    kind: 'decision',
    payload: {
      title: 'Drizzle chosen over Prisma',
      description: 'PR #142 title: "feat: migrate from Prisma to Drizzle for edge runtime support"',
      chosen: 'Drizzle ORM',
      alternatives: [{ option: 'Prisma', rejectionReason: 'no edge runtime support' }],
      rationale: 'Drizzle supports edge runtimes natively. Prisma has a known limitation with the edge runtime. See PR #142.',
      status: 'active',
    },
    source: { changeRef: { repository: 'github.com/RenseiAI/donmai-libraries', kind: 'pr', prNumber: 142 } },
    confidence: 0.60,
    scope: PROJECT_SCOPE,
  },
]

/**
 * Golden output for decision recording on the Drizzle stream.
 */
export const FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS: ArchObservation[] = [
  {
    kind: 'decision',
    payload: {
      title: 'Drizzle chosen over Prisma for edge runtime support',
      chosen: 'Drizzle ORM',
      alternatives: [{ option: 'Prisma', rejectionReason: 'no edge runtime support' }],
      rationale: 'Drizzle supports edge runtimes natively. Prisma has a known limitation with the edge runtime. This decision is stable; re-litigating without edge-runtime constraints changing is drift. See PR #142.',
      status: 'active',
    },
    source: { changeRef: { repository: 'github.com/RenseiAI/donmai-libraries', kind: 'pr', prNumber: 142 } },
    confidence: 0.60,
    scope: PROJECT_SCOPE,
  },
]

// ---------------------------------------------------------------------------
// Fixture 4: Deviation detection stream
// Simulates a new change that bypasses auth middleware.
// ---------------------------------------------------------------------------

export const FIXTURE_DEVIATION_BASELINE: BaselineEntry[] = [
  {
    kind: 'pattern',
    id: 'pattern-auth-centralization',
    title: 'Auth is centralized in lib/auth/middleware.ts',
    description: 'All API routes delegate auth to lib/auth/middleware.ts.',
  },
  {
    kind: 'convention',
    id: 'convention-result-type',
    title: 'All API routes use Result<T,E>',
    description: 'API handlers return Result<T,E> instead of throwing.',
  },
]

export const FIXTURE_DEVIATION_STREAM_INPUT: ArchObservation[] = [
  {
    kind: 'pattern',
    payload: {
      title: 'Inline JWT verification',
      description: 'New route src/routes/api/admin.ts implements JWT verification inline rather than delegating to lib/auth/middleware.ts',
      tags: ['auth', 'jwt'],
      locations: [{ path: 'src/routes/api/admin.ts' }],
    },
    source: { changeRef: { repository: 'github.com/RenseiAI/donmai-libraries', kind: 'pr', prNumber: 200 } },
    confidence: 0.70,
    scope: PROJECT_SCOPE,
  },
]

/**
 * Golden output for deviation detection.
 * Expected: one high-severity deviation flagging the auth bypass.
 */
export const FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS: ArchObservation[] = [
  {
    kind: 'deviation',
    payload: {
      title: 'New admin route bypasses central auth middleware',
      description:
        'src/routes/api/admin.ts implements JWT verification inline, contradicting the established pattern of delegating auth to lib/auth/middleware.ts.',
      deviatesFrom: { kind: 'pattern', id: 'pattern-auth-centralization' },
      severity: 'high',
    },
    source: { changeRef: { repository: 'github.com/RenseiAI/donmai-libraries', kind: 'pr', prNumber: 200 } },
    confidence: 0.80,
    scope: PROJECT_SCOPE,
  },
]

// ---------------------------------------------------------------------------
// Fixture 5: Empty stream (no patterns to extract)
// ---------------------------------------------------------------------------

export const FIXTURE_EMPTY_STREAM_INPUT: ArchObservation[] = []

export const FIXTURE_EMPTY_STREAM_GOLDEN_PATTERNS: ArchObservation[] = []
export const FIXTURE_EMPTY_STREAM_GOLDEN_CONVENTIONS: ArchObservation[] = []
export const FIXTURE_EMPTY_STREAM_GOLDEN_DECISIONS: ArchObservation[] = []
export const FIXTURE_EMPTY_STREAM_GOLDEN_DEVIATIONS: ArchObservation[] = []
