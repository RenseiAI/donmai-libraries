/**
 * Shared types for the server package
 *
 * AgentWorkType is re-exported from here until @donmai/plugin-linear
 * provides it. Consumers should import from this module.
 */

/**
 * Type of agent work being performed based on issue status
 */
export type AgentWorkType =
  | 'research'
  | 'backlog-creation'
  | 'backlog-groomer'
  | 'development'
  | 'inflight'
  | 'qa'
  | 'acceptance'
  | 'refinement'
  | 'refinement-coordination'
  | 'merge'
  | 'security'
  | 'improvement-loop'
  | 'outcome-auditor'
  | 'ga-readiness'
  | 'documentation-steward'
  | 'operational-scanner-vercel'
  | 'operational-scanner-audit'
  | 'operational-scanner-ci'