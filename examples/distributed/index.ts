/**
 * Distributed Worker Pool Example
 *
 * Demonstrates the coordinator + remote worker architecture:
 *   - Coordinator: receives webhooks, enqueues work into Redis
 *   - Workers: claim work from the queue and run agents locally
 *
 * Prerequisites:
 *   - Redis server running (REDIS_URL)
 *   - LINEAR_API_KEY set
 *
 * Usage:
 *   # Terminal 1: Run as coordinator (enqueue work)
 *   npx tsx examples/distributed/index.ts coordinator PROJ-123
 *
 *   # Terminal 2: Run as worker (claim and execute work)
 *   npx tsx examples/distributed/index.ts worker
 */

import {
  createRedisClient,
  createWorkQueue,
  createSessionStorage,
  createWorkerStorage,
} from '@donmai/server'
import { createOrchestrator } from '@donmai/core'

const role = process.argv[2] as 'coordinator' | 'worker'
const issueId = process.argv[3]

if (!role || !['coordinator', 'worker'].includes(role)) {
  console.error('Usage:')
  console.error('  Coordinator: npx tsx examples/distributed/index.ts coordinator PROJ-123')
  console.error('  Worker:      npx tsx examples/distributed/index.ts worker')
  process.exit(1)
}

async function runCoordinator() {
  if (!issueId) {
    console.error('Coordinator requires an issue ID')
    process.exit(1)
  }

  const redis = createRedisClient()
  const queue = createWorkQueue(redis)

  console.log(`Enqueuing work for ${issueId}...`)

  // Enqueue work into the Redis priority queue
  await queue.enqueue({
    issueId,
    identifier: issueId,
    workType: 'development',
    priority: 2, // High priority
    sessionId: `session-${Date.now()}`,
  })

  console.log('Work enqueued. Workers will pick it up from the queue.')
  console.log('Queue depth:', await queue.depth())

  await redis.quit()
}

async function runWorker() {
  const redis = createRedisClient()
  const queue = createWorkQueue(redis)
  const sessions = createSessionStorage(redis)
  const workers = createWorkerStorage(redis)

  const workerId = `worker-${process.pid}`

  // Register this worker
  await workers.register(workerId, { maxConcurrent: 1 })
  console.log(`Worker ${workerId} registered. Polling for work...`)

  // Poll the queue for work
  const work = await queue.claim(workerId)

  if (!work) {
    console.log('No work available in queue.')
    await redis.quit()
    return
  }

  console.log(`Claimed work: ${work.identifier} (${work.workType})`)

  // Create a session record
  await sessions.create({
    id: work.sessionId,
    issueId: work.issueId,
    workType: work.workType,
    workerId,
    status: 'running',
  })

  // Run the agent locally
  const orchestrator = createOrchestrator({
    maxConcurrent: 1,
    // worktreePath defaults to '../{repoName}.wt/'
  })

  await orchestrator.spawnAgentForIssue(work.identifier)
  await orchestrator.waitForAll()

  // Update session status
  const agents = orchestrator.getAgents()
  const agent = agents[0]
  await sessions.update(work.sessionId, {
    status: agent?.status === 'completed' ? 'completed' : 'failed',
    completedAt: new Date().toISOString(),
    totalCostUsd: agent?.totalCostUsd,
  })

  console.log(`Work completed: ${agent?.status}`)
  await redis.quit()
}

if (role === 'coordinator') {
  runCoordinator().catch(console.error)
} else {
  runWorker().catch(console.error)
}
