/**
 * Memory MCP Tool Plugin
 *
 * Exposes af_memory_remember, af_memory_recall, and af_memory_forget
 * MCP tools so agents can explicitly store and retrieve knowledge.
 *
 * These complement automatic observation capture (REN-1150) by giving
 * agents active control over their memory. Both write to the same
 * ObservationStore — explicit memories get `source: explicit` tag and
 * higher default weight.
 */

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { ObservationStore } from './observation-store.js'
import { InMemoryStore } from './memory-store.js'
import type { Observation } from './observations.js'

// ── Plugin Types ─────────────────────────────────────────────────────

/**
 * Structurally identical to ToolPlugin in core — defined locally
 * to avoid compile-time dependency on @donmai/core.
 */
export interface MemoryToolPlugin {
  name: string
  description: string
  createTools(context: MemoryToolPluginContext): SdkMcpToolDefinition<any>[]
}

export interface MemoryToolPluginContext {
  env: Record<string, string>
  cwd: string
}

// ── Plugin Configuration ─────────────────────────────────────────────

export interface MemoryPluginConfig {
  /** Pre-configured ObservationStore. If not provided, creates an in-memory one. */
  observationStore?: ObservationStore
  /** Whether memory tools are enabled (default: true) */
  enabled?: boolean
}

// ── Default Weight for Explicit Memories ─────────────────────────────

const EXPLICIT_MEMORY_WEIGHT = 1.5

// ── Plugin Factory ───────────────────────────────────────────────────

/**
 * Create the memory MCP tool plugin.
 *
 * @example
 * ```typescript
 * const plugin = createMemoryPlugin({ observationStore: store })
 * const tools = plugin.createTools({ env: process.env, cwd: process.cwd() })
 * ```
 */
export function createMemoryPlugin(config: MemoryPluginConfig = {}): MemoryToolPlugin {
  const { enabled = true } = config

  return {
    name: 'af-memory',
    description: 'Agent memory — remember, recall, and forget knowledge across sessions',

    createTools(context: MemoryToolPluginContext): SdkMcpToolDefinition<any>[] {
      if (!enabled) return []

      // Use provided store or create a default in-memory one
      const store = config.observationStore ?? new ObservationStore(new InMemoryStore())
      const sessionId = context.env.LINEAR_SESSION_ID ?? 'unknown'
      const projectScope = context.env.PROJECT_NAME ?? context.cwd

      let idCounter = 0
      function generateMemoryId(): string {
        return `mem_${sessionId}_${Date.now()}_${++idCounter}`
      }

      return [
        tool(
          'af_memory_remember',
          'Store a knowledge item for future sessions. Use this to remember important patterns, conventions, architectural decisions, or gotchas you discover during this session.',
          {
            content: z.string().min(1).describe('The knowledge to remember'),
            tags: z.array(z.string()).optional().describe('Optional tags for categorization (e.g., ["architecture", "api"])'),
            scope: z.string().optional().describe('Optional project/repo scope override'),
          },
          async (args) => {
            try {
              const observation: Observation = {
                id: generateMemoryId(),
                type: 'pattern_discovered',
                content: args.content,
                sessionId,
                projectScope: args.scope ?? projectScope,
                timestamp: Date.now(),
                source: 'explicit',
                weight: EXPLICIT_MEMORY_WEIGHT,
                tags: args.tags,
              }
              const id = await store.store(observation)
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({ stored: true, id, content: args.content }),
                }],
              }
            } catch (err) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error storing memory: ${err instanceof Error ? err.message : String(err)}`,
                }],
                isError: true,
              }
            }
          },
        ),

        tool(
          'af_memory_recall',
          'Query stored knowledge from past sessions. Returns ranked results matching your query.',
          {
            query: z.string().min(1).describe('Natural language query to search memories'),
            tags: z.array(z.string()).optional().describe('Optional tag filter'),
            scope: z.string().optional().describe('Optional project/repo scope override'),
            max_results: z.number().optional().describe('Maximum results (default 10)'),
          },
          async (args) => {
            try {
              const results = await store.retrieve({
                query: args.query,
                projectScope: args.scope ?? projectScope,
                maxResults: args.max_results ?? 10,
                tags: args.tags,
              })
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    results: results.map(r => ({
                      id: r.observation.id,
                      content: r.observation.content,
                      score: r.score,
                      source: r.observation.source,
                      type: r.observation.type,
                      tags: r.observation.tags,
                      sessionId: r.observation.sessionId,
                      timestamp: r.observation.timestamp,
                    })),
                    total: results.length,
                  }, null, 2),
                }],
              }
            } catch (err) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error recalling memories: ${err instanceof Error ? err.message : String(err)}`,
                }],
                isError: true,
              }
            }
          },
        ),

        tool(
          'af_memory_forget',
          'Remove a specific knowledge item by ID. Use this to correct stale or wrong knowledge.',
          {
            id: z.string().min(1).describe('The ID of the memory item to remove'),
          },
          async (args) => {
            try {
              const deleted = await store.delete(args.id)
              if (deleted) {
                return {
                  content: [{
                    type: 'text' as const,
                    text: JSON.stringify({ deleted: true, id: args.id }),
                  }],
                }
              }
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({ deleted: false, id: args.id, error: `No memory found with id "${args.id}"` }),
                }],
                isError: true,
              }
            } catch (err) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Error forgetting memory: ${err instanceof Error ? err.message : String(err)}`,
                }],
                isError: true,
              }
            }
          },
        ),
      ]
    },
  }
}
