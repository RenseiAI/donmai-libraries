// Types
export type {
  AgentSessionState,
  AgentActivityType,
  AgentActivitySignal,
  AgentActivityContent,
  AgentActivityContentPayload,
  ThoughtActivityContent,
  ActionActivityContent,
  ResponseActivityContent,
  ElicitationActivityContent,
  ErrorActivityContent,
  PromptActivityContent,
  AgentActivityCreateInput,
  AgentActivityResult,
  CreateActivityOptions,
  AgentPlanItemState,
  AgentPlanItem,
  AgentPlan,
  AgentSignals,
  LinearAgentClientConfig,
  RetryConfig,
  LinearWorkflowStatus,
  StatusMapping,
  AgentSessionConfig,
  SessionOperationResult,
  AgentSessionExternalUrl,
  AgentSessionUpdateInput,
  AgentSessionUpdateResult,
  AgentSessionCreateOnIssueInput,
  AgentSessionCreateResult,
  AgentWorkType,
  // Issue relations
  IssueRelationType,
  IssueRelationCreateInput,
  IssueRelationResult,
  IssueRelationBatchResult,
  IssueRelationInfo,
  IssueRelationsResult,
  // Sub-issue graph (coordination)
  SubIssueGraphNode,
  SubIssueGraph,
  SubIssueStatus,
  // Rate limiter & circuit breaker strategy interfaces
  RateLimiterStrategy,
  CircuitBreakerStrategy,
  CircuitBreakerConfig,
  // API quota tracking
  LinearApiQuota,
} from './types.js'

// Re-export ToolCategory from core for consumers that import from @donmai/plugin-linear
export type { ToolCategory } from '@donmai/core'

// Work type mappings for status-based routing
export {
  STATUS_WORK_TYPE_MAP,
  WORK_TYPE_START_STATUS,
  WORK_TYPE_COMPLETE_STATUS,
  WORK_TYPE_FAIL_STATUS,
  WORK_TYPE_ALLOWED_STATUSES,
  STATUS_VALID_WORK_TYPES,
  TERMINAL_STATUSES,
  WORK_TYPES_REQUIRING_WORKTREE,
  validateWorkTypeForStatus,
  getValidWorkTypesForStatus,
} from './types.js'

export type { WorkTypeValidationResult } from './types.js'

// Errors
export {
  LinearAgentError,
  LinearApiError,
  LinearRetryExhaustedError,
  LinearSessionError,
  LinearActivityError,
  LinearPlanError,
  LinearStatusTransitionError,
  AgentSpawnError,
  CircuitOpenError,
  isLinearAgentError,
  isRetryableError,
  isAgentSpawnError,
  isCircuitOpenError,
} from './errors.js'

// Retry utilities
export {
  DEFAULT_RETRY_CONFIG,
  sleep,
  calculateDelay,
  withRetry,
  createRetryWrapper,
} from './retry.js'
export type { RetryContext, RetryCallback, WithRetryOptions } from './retry.js'

// Constants
export {
  LINEAR_COMMENT_MAX_LENGTH,
  TRUNCATION_MARKER,
  MAX_COMPLETION_COMMENTS,
  COMMENT_OVERHEAD,
  CONTINUATION_MARKER,
  getDefaultTeamId,
  getDefaultTeamName,
  LINEAR_PROJECTS,
  LINEAR_LABELS,
  ENVIRONMENT_ISSUE_TYPES,
} from './constants.js'
export type { EnvironmentIssueType } from './constants.js'

// Utilities
export {
  truncateText,
  buildCompletionComment,
  splitContentIntoComments,
  buildCompletionComments,
  resolveGraphQLLabelNames,
  resolveSDKLabelNames,
} from './utils.js'
export type { CommentChunk } from './utils.js'

// Checkbox utilities
export {
  parseCheckboxes,
  updateCheckbox,
  updateCheckboxByText,
  updateCheckboxes,
  hasCheckboxes,
  getCheckboxSummary,
} from './checkbox-utils.js'
export type { CheckboxItem, CheckboxUpdate } from './checkbox-utils.js'

// Rate limiter
export { TokenBucket, DEFAULT_RATE_LIMIT_CONFIG, extractRetryAfterMs } from './rate-limiter.js'
export type { TokenBucketConfig } from './rate-limiter.js'

// Circuit breaker
export { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from './circuit-breaker.js'
export type { CircuitState } from './circuit-breaker.js'

// Platform-agnostic issue tracker proxy types
export type {
  ProxyRequest,
  ProxyResponse,
  IssueTrackerMethod,
  SerializedIssue,
  SerializedComment,
  SerializedViewer,
  SerializedTeam,
  ProxyHealthStatus,
} from './issue-tracker-proxy.js'

// Proxy client (routes calls through dashboard instead of Linear directly)
export { ProxyIssueTrackerClient, createProxyClientIfConfigured } from './proxy-client.js'
export type { ProxyClientConfig } from './proxy-client.js'

// Client
export { LinearAgentClient, createLinearAgentClient } from './agent-client.js'

// Session
export { AgentSession, createAgentSession } from './agent-session.js'

// Webhook types
export * from './webhook-types.js'

// Frontend adapter
export { LinearFrontendAdapter } from './frontend-adapter.js'
export type {
  AbstractStatus as LinearAbstractStatus,
  AbstractIssue as LinearAbstractIssue,
  AbstractComment as LinearAbstractComment,
  ExternalUrl as LinearExternalUrl,
  CreateIssueInput as LinearCreateIssueInput,
  UpdateSessionInput as LinearUpdateSessionInput,
} from './frontend-adapter.js'

// Default implementations (prompt templates, work type detection, priority, auto-trigger)
export {
  defaultGeneratePrompt,
  defaultBuildParentQAContext,
  defaultBuildParentAcceptanceContext,
  buildFailureContextBlock,
  WORK_RESULT_MARKER_INSTRUCTION,
  PR_SELECTION_GUIDANCE,
  defaultDetectWorkTypeFromPrompt,
  defaultGetPriority,
  defaultParseAutoTriggerConfig,
  type DefaultAutoTriggerConfig,
  type WorkflowContext,
} from './defaults/index.js'

// Platform adapter (Governor event integration)
export { LinearPlatformAdapter } from './platform-adapter.js'
export type { GovernorIssue as LinearGovernorIssue } from './platform-adapter.js'

// Issue tracker adapter (implements core's IssueTrackerClient)
export { LinearIssueTrackerClient, createLinearStatusMappings } from './issue-tracker-adapter.js'

// IssueTrackerProvider implementation (implements core's IssueTrackerProvider contract)
export { LinearIssueTrackerProvider } from './linear-issue-tracker-provider.js'

// Proxy issue tracker adapter (implements IssueTrackerClient via remote proxy)
export { ProxyIssueTrackerAdapter } from './proxy-issue-tracker-adapter.js'

// Tool plugin and runner (moved from core)
export { linearPlugin } from './tools/linear-plugin.js'
export { runLinear, parseLinearArgs } from './tools/linear-runner.js'
export type { LinearRunnerConfig, LinearRunnerResult } from './tools/linear-runner.js'
