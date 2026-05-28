/**
 * @donmai/nextjs
 *
 * Next.js API route handlers for AgentFactory.
 * Provides webhook processing, worker/session management, public stats,
 * OAuth callback, middleware factory, webhook orchestrator, and Linear client resolver.
 */

// Types
export type {
  LinearClientResolver,
  RouteConfig,
  WebhookConfig,
  AutoTriggerConfig,
  CronConfig,
  RouteHandler,
} from './types.js'

// Factory
export { createAllRoutes } from './factory.js'
export type { AllRoutes, AllRoutesConfig } from './factory.js'

// OAuth handler
export { createOAuthCallbackHandler } from './handlers/oauth/callback.js'
export type { OAuthConfig } from './handlers/oauth/callback.js'

// Middleware factory
export { createAgentFactoryMiddleware } from './middleware/factory.js'
export type { MiddlewareConfig } from './middleware/types.js'

// Webhook orchestrator
export {
  createWebhookOrchestrator,
  formatErrorForComment,
} from './orchestrator/index.js'
export type {
  WebhookOrchestratorConfig,
  WebhookOrchestratorHooks,
  WebhookOrchestratorInstance,
} from './orchestrator/index.js'

// Default Linear client resolver
export { createDefaultLinearClientResolver } from './linear-client-resolver.js'
export type { DefaultLinearClientResolverConfig } from './linear-client-resolver.js'

// Middleware (existing)
export { verifyCronAuth } from './middleware/cron-auth.js'
export {
  verifyWorkerAuth,
  requireWorkerAuth,
  unauthorizedResponse,
  isWorkerAuthConfigured,
} from './middleware/worker-auth.js'

// Webhook
export { createWebhookHandler } from './webhook/processor.js'
export { verifyWebhookSignature } from './webhook/signature.js'

// Governor bridge
export { setGovernorEventBus, getGovernorEventBus, publishGovernorEvent } from './webhook/governor-bridge.js'

// Individual handler factories (for custom wiring)

// Worker handlers
export { createWorkerRegisterHandler } from './handlers/workers/register.js'
export { createWorkerListHandler } from './handlers/workers/list.js'
export { createWorkerGetHandler, createWorkerDeleteHandler } from './handlers/workers/get-delete.js'
export { createWorkerHeartbeatHandler } from './handlers/workers/heartbeat.js'
export { createWorkerPollHandler } from './handlers/workers/poll.js'

// Session handlers (no Linear dependency)
export { createSessionListHandler } from './handlers/sessions/list.js'
export type { AgentSessionResponse } from './handlers/sessions/list.js'
export { createSessionGetHandler } from './handlers/sessions/get.js'
export { createSessionClaimHandler } from './handlers/sessions/claim.js'
export { createSessionStatusPostHandler, createSessionStatusGetHandler } from './handlers/sessions/status.js'
export { createSessionLockRefreshHandler } from './handlers/sessions/lock-refresh.js'
export { createSessionPromptsGetHandler, createSessionPromptsPostHandler } from './handlers/sessions/prompts.js'
export { createSessionInboxAckHandler } from './handlers/sessions/inbox-ack.js'
export { createSessionTransferOwnershipHandler } from './handlers/sessions/transfer-ownership.js'

// Session handlers (Linear forwarding)
export { createSessionActivityHandler } from './handlers/sessions/activity.js'
export { createSessionCompletionHandler } from './handlers/sessions/completion.js'
export { createSessionExternalUrlsHandler } from './handlers/sessions/external-urls.js'
export { createSessionProgressHandler } from './handlers/sessions/progress.js'
export { createSessionToolErrorHandler } from './handlers/sessions/tool-error.js'
export { createSessionSecurityScanHandler } from './handlers/sessions/security-scan.js'

// Public handlers
export { createPublicStatsHandler } from './handlers/public/stats.js'
export type { PublicStatsResponse } from './handlers/public/stats.js'
export { createPublicSessionsListHandler } from './handlers/public/sessions-list.js'
export type { PublicSessionResponse } from './handlers/public/sessions-list.js'
export { createPublicSessionDetailHandler } from './handlers/public/session-detail.js'
export type { PublicSessionDetailResponse } from './handlers/public/session-detail.js'
export { createPublicRoutingMetricsHandler } from './handlers/public/routing-metrics.js'
export type { PublicRoutingMetricsResponse } from './handlers/public/routing-metrics.js'
export { createPublicSessionActivitiesHandler } from './handlers/public/session-activities.js'
export type { PublicActivityResponse } from './handlers/public/session-activities.js'
export { createPublicPhaseMetricsHandler } from './handlers/public/phase-metrics.js'

// Cleanup handler
export { createCleanupHandler } from './handlers/cleanup.js'

// Config handler
export { createConfigHandler } from './handlers/config.js'

// Issue tracker proxy handler (centralized API gateway for agents/governors)
export { createIssueTrackerProxyHandler } from './handlers/issue-tracker-proxy/index.js'
export type { ProxyHandlerConfig } from './handlers/issue-tracker-proxy/types.js'

// Factory handlers
export { createFactoryEventsHandler } from './handlers/factory/events.js'

// Workflow handlers
export { createWorkflowDeployHandler } from './handlers/workflows/deploy.js'

// A2A handlers (Agent-to-Agent protocol)
export { createAgentCardHandler } from './handlers/a2a/agent-card.js'
export type { AgentCardRouteConfig } from './handlers/a2a/agent-card.js'
export { createA2aRpcHandler } from './handlers/a2a/rpc.js'
export type { A2aRpcRouteConfig } from './handlers/a2a/rpc.js'
