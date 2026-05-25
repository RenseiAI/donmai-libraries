/**
 * Default auto-trigger configuration parser.
 *
 * Parses environment variables to determine which automated
 * workflows (QA, acceptance) should be triggered on status transitions.
 */

/**
 * Auto-trigger configuration shape.
 * Matches the AutoTriggerConfig interface from @donmai/server.
 */
export interface DefaultAutoTriggerConfig {
  enableAutoQA: boolean
  enableAutoAcceptance: boolean
  autoQARequireAgentWorked: boolean
  autoAcceptanceRequireAgentWorked: boolean
  autoQAProjects: string[]
  autoAcceptanceProjects: string[]
  autoQAExcludeLabels: string[]
  autoAcceptanceExcludeLabels: string[]
}

/**
 * Parse auto-trigger configuration from environment variables.
 *
 * Environment variables:
 *   ENABLE_AUTO_QA                     - Enable automatic QA on Finished transition
 *   ENABLE_AUTO_ACCEPTANCE             - Enable automatic acceptance on Delivered transition
 *   AUTO_QA_REQUIRE_AGENT_WORKED       - Only auto-QA agent-worked issues (default: true)
 *   AUTO_ACCEPTANCE_REQUIRE_AGENT_WORKED - Only auto-accept agent-worked issues (default: true)
 *   AUTO_QA_PROJECTS                   - Comma-separated project names to auto-QA
 *   AUTO_ACCEPTANCE_PROJECTS           - Comma-separated project names to auto-accept
 *   AUTO_QA_EXCLUDE_LABELS             - Labels that exclude issues from auto-QA
 *   AUTO_ACCEPTANCE_EXCLUDE_LABELS     - Labels that exclude issues from auto-acceptance
 */
export function defaultParseAutoTriggerConfig(): DefaultAutoTriggerConfig {
  return {
    enableAutoQA: process.env.ENABLE_AUTO_QA === 'true',
    enableAutoAcceptance: process.env.ENABLE_AUTO_ACCEPTANCE === 'true',
    autoQARequireAgentWorked: process.env.AUTO_QA_REQUIRE_AGENT_WORKED !== 'false',
    autoAcceptanceRequireAgentWorked: process.env.AUTO_ACCEPTANCE_REQUIRE_AGENT_WORKED !== 'false',
    autoQAProjects: parseCommaSeparated(process.env.AUTO_QA_PROJECTS),
    autoAcceptanceProjects: parseCommaSeparated(process.env.AUTO_ACCEPTANCE_PROJECTS),
    autoQAExcludeLabels: parseCommaSeparated(process.env.AUTO_QA_EXCLUDE_LABELS),
    autoAcceptanceExcludeLabels: parseCommaSeparated(process.env.AUTO_ACCEPTANCE_EXCLUDE_LABELS),
  }
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map(s => s.trim()).filter(Boolean)
}
