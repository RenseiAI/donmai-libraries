# @renseiai/agentfactory-nextjs

Next.js route handlers, webhook processor, middleware, and OAuth for [AgentFactory](https://github.com/renseiai/agentfactory). Drop-in API routes that turn a Next.js app into a full agent fleet server.

## Installation

```bash
npm install @renseiai/agentfactory-nextjs
```

Or scaffold a complete project:

```bash
npx @donmai/create-app my-agent
```

## Quick Start

### 1. Configure routes

```typescript
// src/lib/config.ts
import { createAllRoutes, createDefaultLinearClientResolver } from '@renseiai/agentfactory-nextjs'

export const routes = createAllRoutes({
  linearClient: createDefaultLinearClientResolver(),
})
```

### 2. Add webhook route

```typescript
// src/app/webhook/route.ts
import { routes } from '@/lib/config'
export const POST = routes.webhook.POST
export const GET = routes.webhook.GET
```

### 3. Add middleware

```typescript
// src/middleware.ts
import { createAgentFactoryMiddleware } from '@renseiai/agentfactory-nextjs'

const { middleware } = createAgentFactoryMiddleware()
export { middleware }

export const config = {
  matcher: ['/api/:path*', '/webhook', '/dashboard', '/sessions/:path*', '/'],
}
```

## What's Included

`createAllRoutes()` generates 21+ route handlers from a single config:

| Route Group | Endpoints | Purpose |
|-------------|-----------|---------|
| **Webhook** | `POST /webhook` | Receive Linear events, dispatch agents |
| **Workers** | `/api/workers/*` | Worker registration, heartbeat, polling |
| **Sessions** | `/api/sessions/*` | Session management, status, activity |
| **Public** | `/api/public/*` | Public stats, session list |
| **Cleanup** | `/api/cleanup` | Orphaned resource cleanup |
| **OAuth** | `/callback` | Linear OAuth callback |

Each route file is a 2-line re-export:

```typescript
import { routes } from '@/lib/config'
export const GET = routes.sessions.list.GET
```

## Configuration

```typescript
const routes = createAllRoutes({
  // Required: how to resolve a Linear API client
  linearClient: createDefaultLinearClientResolver(),

  // Optional: customize prompts, detection, priority
  generatePrompt: (identifier, workType, mentionContext) => string,
  detectWorkTypeFromPrompt: (prompt, validWorkTypes) => AgentWorkType | undefined,
  getPriority: (workType) => number,

  // Optional: auto-trigger QA/acceptance
  autoTrigger: {
    enableAutoQA: true,
    enableAutoAcceptance: false,
    autoQARequireAgentWorked: true,
    autoAcceptanceRequireAgentWorked: true,
    autoQAProjects: [],
    autoAcceptanceProjects: [],
    autoQAExcludeLabels: [],
    autoAcceptanceExcludeLabels: [],
  },

  // Optional: governor integration
  // 'direct' (default) — webhooks dispatch work directly
  // 'event-bridge' — dispatch AND publish governor events (dual-write)
  // 'governor-only' — only publish events, governor handles all dispatch
  governorMode: 'event-bridge',

  // Optional: OAuth
  oauth: { clientId: '...', clientSecret: '...' },
})
```

### Governor Event Bridge

When `governorMode` is `event-bridge` or `governor-only`, webhook handlers publish events to a `GovernorEventBus`. Wire the bus at server startup:

```typescript
import { RedisEventBus } from '@renseiai/agentfactory-server'
import { setGovernorEventBus } from '@renseiai/agentfactory-nextjs'

const eventBus = new RedisEventBus()
setGovernorEventBus(eventBus)
```

The governor process (running `af-governor`) consumes from the same Redis Stream and dispatches work through the shared Redis queue.

## Middleware

Handles API key auth, rate limiting, and webhook signature verification:

```typescript
const { middleware } = createAgentFactoryMiddleware({
  routes: {
    public: ['/api/public/', '/dashboard', '/'],
    protected: ['/api/sessions', '/api/workers'],
    webhook: '/webhook',
  },
  rateLimits: {
    public: { max: 60, windowMs: 60_000 },
    webhook: { max: 10, windowMs: 1_000 },
  },
})
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_ACCESS_TOKEN` | Yes | Linear API key |
| `LINEAR_WEBHOOK_SECRET` | For webhooks | Webhook signature verification |
| `REDIS_URL` | For distributed | Redis connection URL |

## Related Packages

| Package | Description |
|---------|-------------|
| [@renseiai/agentfactory](https://www.npmjs.com/package/@renseiai/agentfactory) | Core orchestrator |
| [@renseiai/plugin-linear](https://www.npmjs.com/package/@renseiai/plugin-linear) | Linear integration |
| [@renseiai/agentfactory-server](https://www.npmjs.com/package/@renseiai/agentfactory-server) | Redis infrastructure |
| [@renseiai/agentfactory-cli](https://www.npmjs.com/package/@renseiai/agentfactory-cli) | CLI tools |

## License

MIT
