/**
 * Types for the webhook orchestrator factory.
 */

import type { AgentProcess, StopAgentResult, ForwardPromptResult } from '@donmai/core'
import type { RetryConfig } from '@donmai/plugin-linear'

/**
 * Configuration for the webhook orchestrator.
 */
export interface WebhookOrchestratorConfig {
  /** Maximum concurrent agents (default: 10) */
  maxConcurrent?: number
  /** Enable auto-transition of Linear statuses (default: true) */
  autoTransition?: boolean
  /** Retry configuration for agent spawning */
  retryConfig?: Required<RetryConfig>
}

/**
 * Lifecycle hooks for agent events.
 * Consumers use these to add custom behavior (e.g., marking agent-worked).
 */
export interface WebhookOrchestratorHooks {
  /** Called when an agent starts successfully */
  onAgentComplete?: (agent: AgentProcess) => Promise<void> | void
  /** Called when an agent fails with an error */
  onAgentError?: (agent: AgentProcess, error: Error) => Promise<void> | void
  /** Called when an agent is stopped (e.g., by user) */
  onAgentStopped?: (agent: AgentProcess) => void
}

/**
 * The webhook orchestrator instance provides methods to spawn, stop,
 * and forward prompts to agents.
 */
export interface WebhookOrchestratorInstance {
  /**
   * Spawn an agent for an issue with idempotency and retry logic.
   * Returns immediately after spawning — does not wait for completion.
   */
  spawnAgentAsync(
    issueId: string,
    sessionId: string,
    webhookId?: string
  ): Promise<{
    spawned: boolean
    reason?: string
    agent?: AgentProcess
    error?: Error
  }>

  /** Stop an agent by session ID */
  stopAgentBySession(
    sessionId: string,
    cleanupWorktree?: boolean
  ): Promise<StopAgentResult>

  /** Get an active agent by session ID */
  getAgentBySession(sessionId: string): AgentProcess | undefined

  /** Check if an agent is already running for an issue */
  isAgentRunningForIssue(issueId: string): boolean

  /** Forward a follow-up prompt to an existing or new agent */
  forwardPromptAsync(
    issueId: string,
    sessionId: string,
    promptText: string
  ): Promise<ForwardPromptResult>
}
