/**
 * Autonomous System Prompt Builder
 *
 * Builds a custom system prompt for headless Claude agents spawned by the
 * orchestrator. Replaces the interactive `claude_code` preset with instructions
 * tailored for autonomous operation.
 *
 * Uses shared section builders from agent-instructions.ts — the same builders
 * are used by the orchestrator's buildBaseInstructions() for Codex and other
 * providers, ensuring consistent instructions across all providers.
 */

import { buildSafetyInstructions } from './safety-rules.js'
import {
  buildAutonomyPreamble,
  buildToolUsageGuidance,
  buildCodeEditingPhilosophy,
  buildGitWorkflow,
  buildLargeFileHandling,
  buildCodeIntelligenceMcpTools,
  buildCodeIntelligenceCli,
  buildLinearMcpTools,
  buildLinearCli,
  loadProjectInstructions,
} from './agent-instructions.js'

/**
 * Options for building an autonomous system prompt.
 */
export interface AutonomousSystemPromptOptions {
  /** Worktree path — used to load AGENTS.md / CLAUDE.md */
  worktreePath?: string
  /** Whether code intelligence tools (af_code_*) are available */
  hasCodeIntelligence: boolean
  /** Actual MCP tool names for code intelligence */
  codeIntelToolNames?: string[]
  /** Whether code intelligence usage is enforced (Grep/Glob blocked until af_code_* used) */
  codeIntelEnforced?: boolean
  /** Whether MCP tool plugins are active (vs CLI fallback) */
  useToolPlugins?: boolean
  /** Linear CLI command path (default: 'rensei linear'; OSS substitutes 'af linear') */
  linearCli?: string
  /** Custom instructions to append (from RepositoryConfig.systemPrompt) */
  systemPromptAppend?: string
}

// Re-export loadProjectInstructions for backwards compatibility
export { loadProjectInstructions } from './agent-instructions.js'

/**
 * Build a custom system prompt for autonomous Claude agents.
 *
 * Returns a single string containing all sections. When the Claude Agent SDK
 * is upgraded to support `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`,
 * this can be refactored to return `string[]` for prompt caching — the static
 * sections (identical across agents with the same config) would go before the
 * boundary, and project-specific instructions (AGENTS.md/CLAUDE.md) after.
 */
export function buildAutonomousSystemPrompt(
  options: AutonomousSystemPromptOptions,
): string {
  const {
    worktreePath,
    hasCodeIntelligence,
    codeIntelEnforced = false,
    useToolPlugins = false,
    linearCli = 'rensei linear',
    systemPromptAppend,
  } = options

  // Assemble sections
  const sections: string[] = [
    buildAutonomyPreamble(),
    buildToolUsageGuidance(),
    buildCodeEditingPhilosophy(),
    buildSafetyInstructions(),
    buildGitWorkflow(),
    buildLargeFileHandling(),
  ]

  // Conditional: code intelligence
  if (hasCodeIntelligence) {
    sections.push(
      useToolPlugins
        ? buildCodeIntelligenceMcpTools(codeIntelEnforced)
        : buildCodeIntelligenceCli(codeIntelEnforced),
    )
  }

  // Conditional: Linear tools
  sections.push(
    useToolPlugins
      ? buildLinearMcpTools()
      : buildLinearCli(linearCli),
  )

  // Custom append from RepositoryConfig.systemPrompt
  if (systemPromptAppend?.trim()) {
    sections.push(systemPromptAppend.trim())
  }

  // Dynamic: project instructions from worktree
  const projectInstructions = worktreePath
    ? loadProjectInstructions(worktreePath)
    : undefined

  if (projectInstructions) {
    sections.push(projectInstructions)
  }

  return sections.join('\n\n')
}
