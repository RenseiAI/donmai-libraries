/**
 * Architectural Intelligence MCP Tool Plugin
 *
 * Exposes `af_arch_query` and `af_arch_drift` in-process MCP tools so in-flight
 * agents can re-query the architectural-intelligence corpus on demand —
 * mid-session, not just at session start.
 *
 * Today, agents receive an architectural context snapshot once via
 * `buildArchitecturalContext()` in core's orchestrator at session start.
 * Long-running sessions can go stale when peer agents ingest new observations
 * mid-flight; these tools let an agent refresh that view on demand.
 *
 * Both tools call into the `@donmai/architectural-intelligence` SDK
 * (`ArchitecturalIntelligence.query`). They do not re-implement query logic.
 *
 * Wiring (consumer side):
 * ```ts
 * import { createArchitecturalIntelligencePlugin } from '@donmai/code-intelligence'
 * const plugin = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai })
 * // pass `plugin` in OrchestratorConfig.toolPlugins
 * ```
 */

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type {
  ArchitecturalIntelligence,
  ArchQuerySpec,
  ArchView,
  WorkType,
  ArchScope,
  ArchitecturalPattern,
  Convention,
  Decision,
  Deviation,
} from '@donmai/architectural-intelligence'

// ── Plugin Types ─────────────────────────────────────────────────────

/**
 * Structurally identical to ToolPlugin in core — defined locally to avoid
 * compile-time dependency on @donmai/core. Mirrors the contract
 * used by codeIntelligencePlugin and the memory plugin.
 */
export interface ArchToolPlugin {
  name: string
  description: string
  createTools(context: ArchToolPluginContext): SdkMcpToolDefinition<any>[]
}

export interface ArchToolPluginContext {
  env: Record<string, string>
  cwd: string
}

// ── Plugin Configuration ─────────────────────────────────────────────

export interface ArchitecturalIntelligencePluginConfig {
  /**
   * The pre-configured ArchitecturalIntelligence instance the plugin will
   * query against. Required — the plugin does not construct its own SDK.
   */
  architecturalIntelligence: ArchitecturalIntelligence

  /**
   * Default work-type for `af_arch_query` requests when the caller doesn't
   * supply one. The work-type narrows context relevance (e.g., 'qa'
   * surfaces deviations more prominently). Defaults to 'development'.
   */
  defaultWorkType?: WorkType

  /**
   * Default `maxTokens` for refetch queries. The SDK uses this to bound
   * the returned context size. Defaults to 2000.
   */
  defaultMaxTokens?: number

  /** Whether arch tools are enabled (default: true). */
  enabled?: boolean
}

// ── Filtering Helpers ────────────────────────────────────────────────

/**
 * Lowercase, naive substring filter applied to an item's title and
 * description. The arch-intel SDK's `query()` does not accept a free-form
 * keyword filter — its retrieval is paths/scope/workType-driven. To honor
 * the brief's `query?: string` knob we post-filter on title/description.
 */
function matchesQuery(item: { title: string; description?: string }, q?: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    item.title.toLowerCase().includes(needle) ||
    (item.description ?? '').toLowerCase().includes(needle)
  )
}

function applyLimit<T>(items: T[], limit?: number): T[] {
  if (limit == null || limit <= 0) return items
  return items.slice(0, limit)
}

interface FilteredArchView {
  patterns: ArchitecturalPattern[]
  conventions: Convention[]
  decisions: Decision[]
  driftDeviations: Deviation[]
  citations: ArchView['citations']
  scope: ArchScope
  retrievedAt: Date
  truncated: boolean
}

function filterView(view: ArchView, query?: string, limit?: number): FilteredArchView {
  const filteredPatterns = view.patterns.filter(p => matchesQuery(p, query))
  const filteredConventions = view.conventions.filter(c => matchesQuery(c, query))
  const filteredDecisions = view.decisions.filter(d =>
    matchesQuery({ title: d.title, description: d.rationale }, query),
  )
  const filteredDeviations = (view.drift?.deviations ?? []).filter(d => matchesQuery(d, query))

  const truncated =
    (limit != null && limit > 0 && (
      filteredPatterns.length > limit ||
      filteredConventions.length > limit ||
      filteredDecisions.length > limit ||
      filteredDeviations.length > limit
    )) === true

  return {
    patterns: applyLimit(filteredPatterns, limit),
    conventions: applyLimit(filteredConventions, limit),
    decisions: applyLimit(filteredDecisions, limit),
    driftDeviations: applyLimit(filteredDeviations, limit),
    citations: view.citations,
    scope: view.scope,
    retrievedAt: view.retrievedAt,
    truncated,
  }
}

function buildScope(projectId: string): ArchScope {
  return { level: 'project', projectId }
}

function errorPayload(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  }
}

// ── Plugin Factory ───────────────────────────────────────────────────

/**
 * Create the architectural-intelligence MCP tool plugin.
 *
 * @example
 * ```ts
 * import { PostgresArchitecturalIntelligence } from '@donmai/architectural-intelligence'
 * const ai = new PostgresArchitecturalIntelligence({ ... })
 * const plugin = createArchitecturalIntelligencePlugin({ architecturalIntelligence: ai })
 * // → register `plugin` alongside codeIntelligencePlugin in OrchestratorConfig.toolPlugins
 * ```
 */
export function createArchitecturalIntelligencePlugin(
  config: ArchitecturalIntelligencePluginConfig,
): ArchToolPlugin {
  const { enabled = true, defaultWorkType = 'development', defaultMaxTokens = 2000 } = config
  const ai = config.architecturalIntelligence

  return {
    name: 'af-architectural-intelligence',
    description:
      'Architectural Intelligence — in-session refetch of patterns, conventions, decisions, and drift',

    createTools(_context: ArchToolPluginContext): SdkMcpToolDefinition<any>[] {
      if (!enabled) return []

      return [
        tool(
          'af_arch_query',
          'Refetch architectural context (patterns, conventions, decisions) for the current project. ' +
            'Use this when you have been working for a while and want to ensure your view is fresh — ' +
            'peer agents may have contributed new observations mid-flight. The optional `query` does ' +
            'a substring filter on titles/descriptions; the optional `limit` caps each result list.',
          {
            project_id: z.string().describe('Project ID (scopes the retrieval; required)'),
            query: z.string().optional().describe('Optional substring filter applied to titles/descriptions'),
            limit: z.number().int().positive().optional().describe('Optional per-category result cap'),
            work_type: z
              .string()
              .optional()
              .describe(
                "Optional work type ('development', 'qa', etc). Narrows context relevance. " +
                  'Defaults to the plugin-configured default (development).',
              ),
            paths: z.array(z.string()).optional().describe('Optional path filter for narrower retrieval'),
            issue_id: z.string().optional().describe('Optional issue ID for issue-scoped retrieval'),
            include_drift: z
              .boolean()
              .optional()
              .describe('Whether to include active drift deviations (default true)'),
            max_tokens: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Override the SDK max-tokens bound (default: plugin default 2000)'),
          },
          async (args) => {
            try {
              if (!args.project_id || args.project_id.trim().length === 0) {
                return errorPayload(new Error('project_id is required'))
              }
              const spec: ArchQuerySpec = {
                workType: (args.work_type as WorkType | undefined) ?? defaultWorkType,
                scope: buildScope(args.project_id),
                paths: args.paths,
                issueId: args.issue_id,
                includeActiveDrift: args.include_drift ?? true,
                maxTokens: args.max_tokens ?? defaultMaxTokens,
              }

              const view = await ai.query(spec)
              const filtered = filterView(view, args.query, args.limit)

              return {
                content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
              }
            } catch (err) {
              return errorPayload(err)
            }
          },
        ),

        tool(
          'af_arch_drift',
          'Return the current drift summary for the project — active deviations from established ' +
            'patterns/conventions/decisions, ordered by severity (high → low). Use this before ' +
            'submitting a PR or wrapping up a session to surface architectural risk that may have ' +
            'emerged mid-flight.',
          {
            project_id: z.string().describe('Project ID (scopes the retrieval; required)'),
            limit: z.number().int().positive().optional().describe('Optional deviation count cap'),
            work_type: z
              .string()
              .optional()
              .describe("Optional work type (defaults to 'qa' to prioritize drift signal)"),
          },
          async (args) => {
            try {
              if (!args.project_id || args.project_id.trim().length === 0) {
                return errorPayload(new Error('project_id is required'))
              }

              const spec: ArchQuerySpec = {
                workType: (args.work_type as WorkType | undefined) ?? 'qa',
                scope: buildScope(args.project_id),
                includeActiveDrift: true,
                maxTokens: defaultMaxTokens,
              }

              const view = await ai.query(spec)
              const deviations = view.drift?.deviations ?? []
              const sorted = [...deviations].sort((a, b) => {
                const rank: Record<string, number> = { high: 3, medium: 2, low: 1 }
                return (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0)
              })
              const limited = applyLimit(sorted, args.limit)

              const summary = {
                projectId: args.project_id,
                hasCriticalDrift: view.drift?.hasCriticalDrift ?? false,
                summary: view.drift?.summary ?? '',
                deviations: limited,
                deviationCounts: {
                  high: deviations.filter(d => d.severity === 'high').length,
                  medium: deviations.filter(d => d.severity === 'medium').length,
                  low: deviations.filter(d => d.severity === 'low').length,
                  total: deviations.length,
                },
                scope: view.scope,
                retrievedAt: view.retrievedAt,
              }

              return {
                content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
              }
            } catch (err) {
              return errorPayload(err)
            }
          },
        ),
      ]
    },
  }
}
