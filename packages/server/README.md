# @donmai/server

Redis-backed infrastructure for [Donmai](https://github.com/RenseiAI/donmai-libraries). Provides work queue, session storage, worker pool management, issue locking, and webhook idempotency.

## Installation

```bash
npm install @donmai/server
```

Requires a Redis instance (works with Redis, Upstash, Vercel KV, or any Redis-compatible store).

## What It Provides

| Component | Description |
|-----------|-------------|
| **WorkQueue** | Priority queue with atomic claim/release (sorted sets) |
| **SessionStorage** | Key-value session state (status, cost, timestamps) |
| **WorkerStorage** | Worker registration, heartbeat, capacity tracking |
| **IssueLock** | Per-issue mutex with pending queue |
| **AgentTracking** | QA attempt counts, agent-worked history |
| **WebhookIdempotency** | Dedup webhook deliveries with TTL |
| **TokenStorage** | OAuth token storage and retrieval |
| **RateLimit** | Token bucket rate limiting |
| **WorkerAuth** | API key verification for workers |
| **RedisEventBus** | Governor event bus backed by Redis Streams (consumer groups, MAXLEN trim) |
| **RedisEventDeduplicator** | Governor event dedup using SETNX with TTL |
| **RedisOverrideStorage** | Governor human override state (HOLD, PRIORITY) |
| **RedisProcessingStateStorage** | Top-of-funnel phase tracking (research, backlog-creation) |

## Quick Start

```typescript
import { createRedisClient, enqueueWork, claimWork } from '@donmai/server'

// Redis client (auto-reads REDIS_URL from env)
const redis = createRedisClient()

// Enqueue a work item with priority
await enqueueWork({
  issueId: 'issue-uuid',
  identifier: 'PROJ-123',
  workType: 'development',
  priority: 2,
  prompt: 'Implement the login feature...',
})

// Worker claims next item
const work = await claimWork('worker-1')
if (work) {
  console.log(`Claimed: ${work.identifier} [${work.workType}]`)
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection URL (e.g., `redis://localhost:6379`) |

## Related Packages

| Package | Description |
|---------|-------------|
| [@donmai/core](https://www.npmjs.com/package/@donmai/core) | Core orchestrator |
| [@donmai/cli](https://www.npmjs.com/package/@donmai/cli) | CLI tools (worker, orchestrator) |
| [@donmai/nextjs](https://www.npmjs.com/package/@donmai/nextjs) | Next.js webhook server |

## License

MIT
