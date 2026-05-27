/**
 * API-based Activity Emitter
 *
 * Emits Claude stream events to Linear via the agent app's API endpoint.
 * This is used when the orchestrator runs remotely (as a worker) and needs
 * to proxy activities through the Vercel app which has OAuth tokens.
 *
 * The agent app API endpoint (/api/sessions/[id]/activity) retrieves the
 * OAuth token from Redis using the session's organizationId and forwards
 * the activity to Linear's Agent API.
 *
 * Mapping:
 * - assistant message → response (persisted, user-directed communication)
 * - tool_use → action (ephemeral)
 * - tool_result → action (ephemeral)
 * - result → response (persisted)
 * - error → error (persisted)
 */

import type { SecurityScanEvent } from './security-scan-event.js'
import { classifyTool, type ToolCategory } from '../tools/tool-category.js'

/** Configuration for the API activity emitter */
export interface ApiActivityEmitterConfig {
  /** Linear session ID */
  sessionId: string
  /** Worker ID for authentication */
  workerId: string
  /** API base URL (e.g., https://donmai.dev/dashboard) */
  apiBaseUrl: string
  /** API authentication key */
  apiKey: string
  /** Minimum interval between activities in ms (default: 500ms) */
  minInterval?: number
  /** Maximum length for tool outputs before truncation (default: 2000) */
  maxOutputLength?: number
  /** Whether to include timestamps in activities (default: false) */
  includeTimestamps?: boolean
  /** Optional callback when an activity is emitted */
  onActivityEmitted?: (type: string, content: string) => void
  /** Optional callback when an activity is throttled */
  onActivityThrottled?: (type: string, content: string) => void
  /** Optional callback when API call fails */
  onActivityError?: (type: string, error: Error) => void
  /** Optional callback when a progress update is posted */
  onProgressPosted?: (milestone: string, message: string) => void
  /** Optional callback when session ownership is revoked (403 from another worker) */
  onOwnershipRevoked?: () => void
}

/** Progress milestone types */
export type ProgressMilestone =
  | 'claimed'
  | 'worktree'
  | 'started'
  | 'running'
  | 'tests'
  | 'pr'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'resumed'

interface QueuedActivity {
  type: 'thought' | 'action' | 'response' | 'error' | 'context'
  content: string
  ephemeral: boolean
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  toolCategory?: ToolCategory
  contextKey?: string
  contextValue?: unknown
}

const DEFAULT_MIN_INTERVAL = 500
const DEFAULT_MAX_OUTPUT_LENGTH = 2000

/**
 * API Activity Emitter
 *
 * Handles rate-limited emission of Claude events to Linear via API proxy.
 */
export class ApiActivityEmitter {
  private readonly sessionId: string
  private workerId: string // Mutable to allow update after worker re-registration
  private readonly apiBaseUrl: string
  private readonly apiKey: string
  private readonly minInterval: number
  private readonly maxOutputLength: number
  private readonly includeTimestamps: boolean
  private readonly onActivityEmitted?: (type: string, content: string) => void
  private readonly onActivityThrottled?: (type: string, content: string) => void
  private readonly onActivityError?: (type: string, error: Error) => void
  private readonly onProgressPosted?: (milestone: string, message: string) => void
  private readonly onOwnershipRevoked?: () => void

  /** Circuit breaker: set when 403 ownership error is received */
  private ownershipRevoked = false

  private lastEmitTime = 0
  private queue: QueuedActivity[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private isProcessing = false
  // Track reported tool error signatures for deduplication
  private readonly reportedToolErrors: Set<string> = new Set()

  constructor(config: ApiActivityEmitterConfig) {
    this.sessionId = config.sessionId
    this.workerId = config.workerId
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, '') // Remove trailing slash
    this.apiKey = config.apiKey
    this.minInterval = config.minInterval ?? DEFAULT_MIN_INTERVAL
    this.maxOutputLength = config.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH
    this.includeTimestamps = config.includeTimestamps ?? false
    this.onActivityEmitted = config.onActivityEmitted
    this.onActivityThrottled = config.onActivityThrottled
    this.onActivityError = config.onActivityError
    this.onProgressPosted = config.onProgressPosted
    this.onOwnershipRevoked = config.onOwnershipRevoked
  }

  /**
   * Update the worker ID used for API requests.
   * Called after worker re-registration to ensure activities are attributed
   * to the new worker ID and pass ownership checks.
   */
  updateWorkerId(newWorkerId: string): void {
    this.workerId = newWorkerId
  }

  /**
   * Get the current worker ID
   */
  getWorkerId(): string {
    return this.workerId
  }

  /**
   * Check if ownership has been revoked (circuit breaker tripped)
   */
  isOwnershipRevoked(): boolean {
    return this.ownershipRevoked
  }

  /**
   * Emit a thought activity (persistent by default for visibility in Linear)
   */
  async emitThought(content: string, ephemeral = false): Promise<void> {
    await this.queueActivity({
      type: 'thought',
      content,
      ephemeral,
    })
  }

  /**
   * Emit a tool use activity (ephemeral by default)
   */
  async emitToolUse(
    tool: string,
    input: Record<string, unknown>,
    ephemeral = true,
    context?: { key: string; value: unknown }
  ): Promise<void> {
    const inputSummary = this.summarizeToolInput(tool, input)
    const category = classifyTool(tool)
    await this.queueActivity({
      type: 'action',
      content: `${tool}: ${inputSummary}`,
      ephemeral,
      toolName: tool,
      toolInput: input,
      toolCategory: category,
      contextKey: context?.key,
      contextValue: context?.value,
    })
  }

  /**
   * Emit a response activity (persisted)
   */
  async emitResponse(
    content: string,
    context?: { key: string; value: unknown }
  ): Promise<void> {
    await this.queueActivity({
      type: 'response',
      content,
      ephemeral: false,
      contextKey: context?.key,
      contextValue: context?.value,
    })
  }

  /**
   * Emit a context entry (persisted, not forwarded to Linear).
   * Used by ContextManager to emit artifact summaries, structured state, etc.
   */
  async emitContext(key: string, value: unknown): Promise<void> {
    await this.queueActivity({
      type: 'context',
      content: `context:${key}`,
      ephemeral: false,
      contextKey: key,
      contextValue: value,
    })
  }

  /**
   * Emit an error activity (persisted)
   */
  async emitError(error: Error | string): Promise<void> {
    const message = error instanceof Error ? error.message : error
    await this.queueActivity({
      type: 'error',
      content: message,
      ephemeral: false,
    })
  }

  /**
   * Emit a security scan event to the API for storage and downstream consumption.
   * Posts to `/api/sessions/[id]/security-scan`.
   */
  async emitSecurityScan(event: SecurityScanEvent): Promise<void> {
    if (this.ownershipRevoked) return

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/sessions/${this.sessionId}/security-scan`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            workerId: this.workerId,
            event,
          }),
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API error ${response.status}: ${errorText}`)
      }

      this.onActivityEmitted?.('security-scan', event.scanner)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[ApiActivityEmitter] Failed to emit security scan event:', err)
      this.onActivityError?.('security-scan', err)
    }
  }

  /**
   * Post a progress update comment to the Linear issue thread.
   * Unlike activities which are ephemeral, progress updates are
   * persisted as comments and visible in the issue thread.
   *
   * @param milestone - The type of progress milestone (e.g., 'started', 'completed')
   * @param message - The progress message to post
   */
  async postProgress(
    milestone: ProgressMilestone,
    message: string
  ): Promise<boolean> {
    if (this.ownershipRevoked) return false

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/sessions/${this.sessionId}/progress`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            workerId: this.workerId,
            milestone,
            message,
          }),
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API error ${response.status}: ${errorText}`)
      }

      const result = (await response.json()) as { posted: boolean; reason?: string }

      if (result.posted) {
        this.onProgressPosted?.(milestone, message)
      } else {
        console.warn(`Progress not posted: ${result.reason ?? 'unknown'}`)
      }

      return result.posted
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      console.error(`Failed to post progress (${milestone}):`, err)
      this.onActivityError?.('progress', err)
      return false
    }
  }

  /**
   * Report a tool error as a Linear issue for tracking and improvement.
   * Creates a bug in the Agent project backlog via API.
   *
   * @param toolName - Name of the tool that errored
   * @param errorMessage - The error message
   * @param context - Additional context about the error
   * @returns The created issue, or null if creation failed or was deduplicated
   */
  async reportToolError(
    toolName: string,
    errorMessage: string,
    context?: {
      issueIdentifier?: string
      additionalContext?: Record<string, unknown>
    }
  ): Promise<{ id: string; identifier: string; url: string } | null> {
    // Deduplicate using tool name + first 100 chars of error
    const signature = `${toolName}:${errorMessage.substring(0, 100)}`
    if (this.reportedToolErrors.has(signature)) {
      return null
    }
    this.reportedToolErrors.add(signature)

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/sessions/${this.sessionId}/tool-error`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            workerId: this.workerId,
            toolName,
            errorMessage,
            context,
          }),
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API error ${response.status}: ${errorText}`)
      }

      const result = (await response.json()) as {
        created: boolean
        issue?: { id: string; identifier: string; url: string }
        reason?: string
      }

      if (result.created && result.issue) {
        return result.issue
      }

      return null
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[ApiActivityEmitter] Failed to report tool error:', err)
      this.onActivityError?.('tool-error', err)
      return null
    }
  }

  /**
   * Queue an activity for emission with rate limiting
   */
  private async queueActivity(activity: QueuedActivity): Promise<void> {
    if (this.ownershipRevoked) return

    this.queue.push(activity)

    // Schedule flush if not already scheduled
    if (!this.flushTimer && !this.isProcessing) {
      const timeSinceLastEmit = Date.now() - this.lastEmitTime
      const delay = Math.max(0, this.minInterval - timeSinceLastEmit)

      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.processQueue()
      }, delay)
    }
  }

  /**
   * Process queued activities
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return

    this.isProcessing = true

    try {
      // Merge similar consecutive activities to reduce API calls
      const merged = this.mergeQueuedActivities()

      for (const activity of merged) {
        await this.emitActivity(activity)
        this.lastEmitTime = Date.now()

        // Small delay between emissions to avoid rate limits
        if (merged.length > 1) {
          await this.delay(100)
        }
      }
    } finally {
      this.isProcessing = false

      // If more activities were queued during processing, schedule another flush
      if (this.queue.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null
          this.processQueue()
        }, this.minInterval)
      }
    }
  }

  /**
   * Merge consecutive similar activities in the queue
   */
  private mergeQueuedActivities(): QueuedActivity[] {
    const activities = [...this.queue]
    this.queue = []

    if (activities.length <= 1) return activities

    const merged: QueuedActivity[] = []
    let current = activities[0]

    for (let i = 1; i < activities.length; i++) {
      const next = activities[i]

      // Merge consecutive thoughts
      if (
        current.type === 'thought' &&
        next.type === 'thought' &&
        current.ephemeral === next.ephemeral
      ) {
        current = {
          ...current,
          content: `${current.content}\n\n${next.content}`,
        }
        this.onActivityThrottled?.('thought', next.content)
        continue
      }

      // Merge consecutive tool results for same tool
      if (
        current.type === 'action' &&
        next.type === 'action' &&
        current.toolName === next.toolName &&
        current.ephemeral === next.ephemeral
      ) {
        current = {
          ...current,
          content: `${current.content}\n${next.content}`,
        }
        this.onActivityThrottled?.('action', next.content)
        continue
      }

      merged.push(current)
      current = next
    }

    merged.push(current)
    return merged
  }

  /**
   * Emit a single activity to Linear via API
   */
  private async emitActivity(activity: QueuedActivity): Promise<void> {
    if (this.ownershipRevoked) return

    try {
      const content = this.includeTimestamps
        ? `[${new Date().toISOString()}] ${activity.content}`
        : activity.content

      const response = await fetch(
        `${this.apiBaseUrl}/api/sessions/${this.sessionId}/activity`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            workerId: this.workerId,
            activity: {
              type: activity.type,
              content,
              toolName: activity.toolName,
              toolInput: activity.toolInput,
              toolCategory: activity.toolCategory,
              contextKey: activity.contextKey,
              contextValue: activity.contextValue,
            },
          }),
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API error ${response.status}: ${errorText}`)
      }

      const result = (await response.json()) as { forwarded: boolean; reason?: string }

      if (!result.forwarded) {
        console.warn(`Activity not forwarded: ${result.reason ?? 'unknown'}`)
      }

      this.onActivityEmitted?.(activity.type, content)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      // Circuit breaker: stop emitting if session ownership was revoked
      if (err.message.includes('403') && err.message.includes('owned by another worker')) {
        this.ownershipRevoked = true
        console.warn(`[${this.sessionId}] Session ownership revoked — stopping activity emission`)
        this.onOwnershipRevoked?.()
        return
      }

      console.error(`Failed to emit ${activity.type} activity via API:`, err)
      this.onActivityError?.(activity.type, err)
    }
  }

  /**
   * Summarize tool input for display
   */
  private summarizeToolInput(
    tool: string,
    input: Record<string, unknown>
  ): string {
    // Tool-specific summaries
    switch (tool) {
      case 'Read':
        return String(input.file_path || input.path || 'file')
      case 'Write':
        return String(input.file_path || input.path || 'file')
      case 'Edit':
        return String(input.file_path || input.path || 'file')
      case 'Grep':
        return `"${input.pattern}" in ${input.path || '.'}`
      case 'Glob':
        return String(input.pattern || '*')
      case 'Bash':
        const cmd = String(input.command || '')
        return cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd
      case 'Task':
        return String(input.description || input.prompt || 'task')
      default:
        // Generic: show first string value or truncated JSON
        const firstStringValue = Object.values(input).find(
          (v) => typeof v === 'string'
        ) as string | undefined
        if (firstStringValue) {
          return firstStringValue.length > 50
            ? firstStringValue.substring(0, 47) + '...'
            : firstStringValue
        }
        const json = JSON.stringify(input)
        return json.length > 50 ? json.substring(0, 47) + '...' : json
    }
  }

  /**
   * Truncate long output strings
   */
  private truncateOutput(output: string): string {
    if (output.length <= this.maxOutputLength) return output
    return (
      output.substring(0, this.maxOutputLength) +
      `\n\n... (truncated ${output.length - this.maxOutputLength} chars)`
    )
  }

  /**
   * Flush all pending activities immediately
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.processQueue()
  }

  /**
   * Helper delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Create an API activity emitter instance
 */
export function createApiActivityEmitter(
  config: ApiActivityEmitterConfig
): ApiActivityEmitter {
  return new ApiActivityEmitter(config)
}
