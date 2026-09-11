import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { disconnectRedis, getRedisClient } from './redis.js'
import {
  claimSession,
  getSessionState,
  resetSessionForRequeue,
  startSession,
  touchSessionHeartbeat,
  transferSessionOwnership,
  updateProviderSessionId,
  updateSessionCostData,
  updateSessionStatus,
  type AgentSessionState,
} from './session-storage.js'

const SESSION_KEY_PREFIX = 'agent:session:'
const SESSION_TTL_SECONDS = 24 * 60 * 60
const RUN_ID = randomUUID()

const touchedKeys = new Set<string>()

if (!process.env.REDIS_URL) {
  throw new Error(
    'REDIS_URL is required for the non-skipping session lifecycle Redis integration gate'
  )
}

const redis = getRedisClient()
const pong = await redis.ping()
if (pong !== 'PONG') {
  throw new Error(`Redis readiness probe returned ${pong}`)
}

function sessionId(label: string): string {
  return `ren-3640:${RUN_ID}:${label}`
}

function sessionKey(id: string): string {
  const key = `${SESSION_KEY_PREFIX}${id}`
  touchedKeys.add(key)
  return key
}

function makeSession(
  id: string,
  overrides: Partial<AgentSessionState> = {}
): AgentSessionState {
  return {
    trackerSessionId: id,
    trackerProvider: 'linear',
    issueId: `issue:${id}`,
    providerSessionId: null,
    worktreePath: '',
    status: 'pending',
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  }
}

async function seedRaw(
  id: string,
  value: unknown,
  ttlSeconds = 60
): Promise<string> {
  const key = sessionKey(id)
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  return key
}

async function readRaw(key: string): Promise<Record<string, unknown>> {
  const raw = await redis.get(key)
  expect(raw).not.toBeNull()
  return JSON.parse(raw!) as Record<string, unknown>
}

afterEach(async () => {
  if (touchedKeys.size > 0) {
    await redis.del(...touchedKeys)
  }
  touchedKeys.clear()
})

afterAll(async () => {
  await disconnectRedis()
})

describe('production atomic worker lifecycle Lua against Redis', () => {
  it('rejects missing and malformed rows without creating or rewriting them', async () => {
    const missingId = sessionId('missing')
    const missingKey = sessionKey(missingId)

    await expect(claimSession(missingId, 'worker-a')).resolves.toBe(false)
    await expect(
      startSession(missingId, 'worker-a', '/tmp/missing')
    ).resolves.toBe(false)
    await expect(redis.exists(missingKey)).resolves.toBe(0)

    const malformedId = sessionId('malformed')
    const malformedKey = sessionKey(malformedId)
    const malformedValue = '{not-json'
    await redis.set(malformedKey, malformedValue, 'EX', 60)

    await expect(claimSession(malformedId, 'worker-a')).resolves.toBe(false)
    await expect(
      startSession(malformedId, 'worker-a', '/tmp/malformed')
    ).resolves.toBe(false)
    await expect(redis.get(malformedKey)).resolves.toBe(malformedValue)
    expect(await redis.ttl(malformedKey)).toBeGreaterThan(0)
  })

  it('preserves TTL and bytes on rejection, then resets TTL on successful claim and start', async () => {
    const id = sessionId('ttl-contract')
    const key = await seedRaw(id, makeSession(id, { status: 'running' }))
    const rejectedValue = await redis.get(key)
    const rejectedTtl = await redis.ttl(key)

    await expect(claimSession(id, 'worker-a')).resolves.toBe(false)
    await expect(redis.get(key)).resolves.toBe(rejectedValue)
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(rejectedTtl - 2)

    await seedRaw(id, makeSession(id), 60)
    await expect(claimSession(id, 'worker-a')).resolves.toBe(true)
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(
      SESSION_TTL_SECONDS - 2
    )

    await redis.expire(key, 60)
    await expect(
      startSession(id, 'worker-a', '/tmp/ttl-contract')
    ).resolves.toBe(true)
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(
      SESSION_TTL_SECONDS - 2
    )
  })

  it('migrates legacy tracker fields on both successful transitions', async () => {
    const claimId = sessionId('legacy-claim')
    const claimKey = await seedRaw(claimId, {
      linearSessionId: claimId,
      issueId: 'issue-legacy-claim',
      providerSessionId: null,
      worktreePath: '',
      status: 'pending',
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
    })

    await expect(claimSession(claimId, 'worker-legacy')).resolves.toBe(true)
    expect(await readRaw(claimKey)).toMatchObject({
      linearSessionId: claimId,
      trackerSessionId: claimId,
      trackerProvider: 'linear',
      status: 'claimed',
      workerId: 'worker-legacy',
    })

    const startId = sessionId('legacy-start')
    const exactClaimedAt = 1_234_567
    const startKey = await seedRaw(startId, {
      linearSessionId: startId,
      issueId: 'issue-legacy-start',
      providerSessionId: null,
      worktreePath: '',
      status: 'claimed',
      workerId: 'worker-legacy',
      claimedAt: exactClaimedAt,
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
    })

    await expect(
      startSession(startId, 'worker-legacy', '/tmp/legacy')
    ).resolves.toBe(true)
    expect(await readRaw(startKey)).toMatchObject({
      linearSessionId: startId,
      trackerSessionId: startId,
      trackerProvider: 'linear',
      status: 'running',
      workerId: 'worker-legacy',
      claimedAt: exactClaimedAt,
      worktreePath: '/tmp/legacy',
    })
  })

  it('allows a claim only from pending and leaves every other status unchanged', async () => {
    for (const status of [
      'claimed',
      'running',
      'finalizing',
      'completed',
      'failed',
      'stopped',
      'timed_out',
    ] as const) {
      const id = sessionId(`claim-from-${status}`)
      const key = await seedRaw(id, makeSession(id, { status }))
      const before = await redis.get(key)

      await expect(claimSession(id, 'worker-a')).resolves.toBe(false)
      await expect(redis.get(key)).resolves.toBe(before)
    }
  })

  it('permits exactly one winner across concurrent pending claims', async () => {
    const id = sessionId('one-claim-winner')
    const key = await seedRaw(id, makeSession(id))
    const workers = Array.from({ length: 24 }, (_, index) => `worker-${index}`)

    const results = await Promise.all(
      workers.map((workerId) => claimSession(id, workerId))
    )

    expect(results.filter(Boolean)).toHaveLength(1)
    const winningWorker = workers[results.findIndex(Boolean)]
    expect(await readRaw(key)).toMatchObject({
      status: 'claimed',
      workerId: winningWorker,
      claimedAt: expect.any(Number),
    })
  })

  it('starts only a claimed row owned by the same worker with numeric claimedAt', async () => {
    const invalidRows: Array<{
      label: string
      row: Partial<AgentSessionState>
    }> = [
      { label: 'pending', row: { status: 'pending', workerId: 'worker-a' } },
      { label: 'running', row: { status: 'running', workerId: 'worker-a' } },
      {
        label: 'wrong-worker',
        row: { status: 'claimed', workerId: 'worker-b', claimedAt: 123 },
      },
      {
        label: 'missing-claimed-at',
        row: { status: 'claimed', workerId: 'worker-a' },
      },
      {
        label: 'null-claimed-at',
        row: { status: 'claimed', workerId: 'worker-a', claimedAt: null },
      },
    ]

    for (const { label, row } of invalidRows) {
      const id = sessionId(`invalid-start-${label}`)
      const key = await seedRaw(id, makeSession(id, row))
      const before = await redis.get(key)

      await expect(
        startSession(id, 'worker-a', `/tmp/${label}`)
      ).resolves.toBe(false)
      await expect(redis.get(key)).resolves.toBe(before)
    }

    const validId = sessionId('valid-start')
    const validKey = await seedRaw(
      validId,
      makeSession(validId, {
        status: 'claimed',
        workerId: 'worker-a',
        claimedAt: 123,
      })
    )
    await expect(
      startSession(validId, 'worker-a', '/tmp/valid')
    ).resolves.toBe(true)
    expect(await readRaw(validKey)).toMatchObject({
      status: 'running',
      workerId: 'worker-a',
      claimedAt: 123,
      worktreePath: '/tmp/valid',
    })
  })

  it('preserves the exact claimedAt sampled by claim through start', async () => {
    const id = sessionId('claimed-at')
    const key = await seedRaw(id, makeSession(id))

    await expect(claimSession(id, 'worker-a')).resolves.toBe(true)
    const claimed = await readRaw(key)
    expect(claimed.claimedAt).toEqual(expect.any(Number))
    const exactClaimedAt = claimed.claimedAt

    await expect(
      startSession(id, 'worker-a', '/tmp/claimed-at')
    ).resolves.toBe(true)
    expect((await readRaw(key)).claimedAt).toBe(exactClaimedAt)
  })

  it('serializes both claim/start command orderings without an impossible running row', async () => {
    const startFirstId = sessionId('start-first')
    const startFirstKey = await seedRaw(
      startFirstId,
      makeSession(startFirstId)
    )
    const startFirst = await Promise.all([
      startSession(startFirstId, 'worker-a', '/tmp/start-first'),
      claimSession(startFirstId, 'worker-a'),
    ])
    expect(startFirst).toEqual([false, true])
    expect(await readRaw(startFirstKey)).toMatchObject({
      status: 'claimed',
      workerId: 'worker-a',
      claimedAt: expect.any(Number),
    })

    const claimFirstId = sessionId('claim-first')
    const claimFirstKey = await seedRaw(
      claimFirstId,
      makeSession(claimFirstId)
    )
    const claimFirst = await Promise.all([
      claimSession(claimFirstId, 'worker-a'),
      startSession(claimFirstId, 'worker-a', '/tmp/claim-first'),
    ])
    expect(claimFirst).toEqual([true, true])
    expect(await readRaw(claimFirstKey)).toMatchObject({
      status: 'running',
      workerId: 'worker-a',
      claimedAt: expect.any(Number),
      worktreePath: '/tmp/claim-first',
    })
  })

  it('propagates Redis EVAL errors instead of converting them to a skipped transition', async () => {
    const id = sessionId('wrong-type')
    const key = sessionKey(id)
    await redis.rpush(key, 'not-a-session-row')

    await expect(claimSession(id, 'worker-a')).rejects.toThrow(/WRONGTYPE/)
    await expect(
      startSession(id, 'worker-a', '/tmp/wrong-type')
    ).rejects.toThrow(/WRONGTYPE/)
  })
})

describe('field-atomic metadata updates against Redis', () => {
  it('holds the ACTUAL cost writer read across a terminal commit: completed survives and final cost lands', async () => {
    const id = sessionId('cost-vs-terminal')
    const key = await seedRaw(
      id,
      makeSession(id, {
        status: 'running',
        workerId: 'worker-a',
        totalCostUsd: 1.0,
        inputTokens: 100,
        outputTokens: 50,
      })
    )

    // Barrier on the production writer's own read/write seam: pause the
    // cost writer AFTER its internal row read (not a separate test-side
    // snapshot), commit `completed` through the real status writer, then
    // release the stale writer. The repaired writer retries from the fresh
    // row, so the terminal status survives and the final cost still lands.
    const client = getRedisClient()
    const realGet = client.get.bind(client)
    let releaseCostWrite!: () => void
    const costWriteReleased = new Promise<void>((resolve) => {
      releaseCostWrite = resolve
    })
    let holdCostWrite!: () => void
    const costWriteHeld = new Promise<void>((resolve) => {
      holdCostWrite = resolve
    })
    let heldOnce = false
    const getSpy = vi.spyOn(client, 'get').mockImplementation((async (redisKey: Parameters<typeof client.get>[0]) => {
        const value = await realGet(redisKey)
        if (!heldOnce && String(redisKey) === key && value !== null) {
          heldOnce = true
          holdCostWrite()
          await costWriteReleased
        }
        return value
      }) as never)

    const costPromise = updateSessionCostData(id, {
      totalCostUsd: 9.99,
      inputTokens: 999,
      outputTokens: 999,
    })
    await costWriteHeld

    // Concurrent terminal commit via the actual status writer.
    await expect(updateSessionStatus(id, 'completed')).resolves.toBe(true)
    releaseCostWrite()
    await expect(costPromise).resolves.toBe(true)
    getSpy.mockRestore()

    // Repaired behavior: terminal status survives and final cost fields land.
    expect(await readRaw(key)).toMatchObject({
      status: 'completed',
      totalCostUsd: 9.99,
      inputTokens: 999,
      outputTokens: 999,
    })
    await expect(getSessionState(id)).resolves.toMatchObject({
      status: 'completed',
      totalCostUsd: 9.99,
    })
  })

  it('provider-only writes preserve nested arrays and numeric precision byte-for-byte elsewhere', async () => {
    const id = sessionId('lossless-provider')
    const key = await seedRaw(
      id,
      makeSession(id, {
        status: 'running',
        workerId: 'worker-a',
        providerSessionId: null,
        totalCostUsd: 1.2345678901234567,
        inputTokens: 9007199254740991,
        outputTokens: 7,
      })
    )
    // Untouched nested carrier data with an empty array.
    const before = (await readRaw(key)) as Record<string, unknown>
    const withCarrier = { ...before, extra: { tags: [] as unknown[] } }
    await redis.set(key, JSON.stringify(withCarrier), 'EX', 60)
    const beforeRaw = (await redis.get(key)) as string

    await expect(
      updateProviderSessionId(id, 'provider-keep')
    ).resolves.toBe(true)

    const afterRaw = (await redis.get(key)) as string
    const after = JSON.parse(afterRaw) as Record<string, unknown>
    expect(after.providerSessionId).toBe('provider-keep')
    expect(after.extra).toEqual({ tags: [] })
    expect(Array.isArray((after.extra as { tags: unknown }).tags)).toBe(true)
    expect(after.totalCostUsd).toBe(1.2345678901234567)
    expect(after.inputTokens).toBe(9007199254740991)
    expect(after.outputTokens).toBe(7)
    expect(after.status).toBe('running')
    expect(after.workerId).toBe('worker-a')
    // Only the patched field plus updatedAt differ from the seeded bytes.
    const beforeParsed = JSON.parse(beforeRaw) as Record<string, unknown>
    const afterParsed = JSON.parse(afterRaw) as Record<string, unknown>
    expect({
      ...afterParsed,
      providerSessionId: beforeParsed.providerSessionId,
      updatedAt: beforeParsed.updatedAt,
    }).toEqual(beforeParsed)
  })

  it('null, undefined, and empty owners all accept a transfer', async () => {
    for (const owner of [null, undefined, ''] as const) {
      const id = sessionId(`transfer-unowned-${owner === '' ? 'empty' : String(owner)}-${Math.random().toString(36).slice(2, 6)}`)
      const overrides: Partial<AgentSessionState> =
        owner === undefined ? {} : { workerId: owner }
      const key = await seedRaw(id, makeSession(id, overrides))
      await expect(
        transferSessionOwnership(id, 'worker-new', 'worker-old')
      ).resolves.toEqual({ transferred: true })
      expect(await readRaw(key)).toMatchObject({ workerId: 'worker-new' })
    }
  })

  it('a stale transfer against a newer owner is rejected and keeps the newer owner', async () => {
    const id = sessionId('transfer-stale')
    const key = await seedRaw(
      id,
      makeSession(id, { status: 'claimed', workerId: 'worker-newer' })
    )
    await expect(
      transferSessionOwnership(id, 'worker-stale', 'worker-old')
    ).resolves.toMatchObject({ transferred: false })
    expect(await readRaw(key)).toMatchObject({ workerId: 'worker-newer' })
  })

  it('a refused transfer writes nothing: bytes and TTL are unchanged', async () => {
    const id = sessionId('transfer-refused-no-write')
    const row = makeSession(id, { status: 'running', workerId: 'foreign' })
    const key = await seedRaw(id, row, 60)
    const beforeRaw = (await redis.get(key)) as string
    const beforeTtl = await redis.ttl(key)

    const result = await transferSessionOwnership(id, 'replacement', 'expected')

    expect(result.transferred).toBe(false)
    expect(result.reason).toContain('foreign')
    expect(await redis.get(key)).toBe(beforeRaw)
    expect(await redis.ttl(key)).toBe(beforeTtl)
  })

  it('a transfer that becomes eligible mid-flight commits the new owner and reports success', async () => {
    const id = sessionId('transfer-race-eligible')
    const row = makeSession(id, { status: 'running', workerId: 'foreign' })
    const key = await seedRaw(id, row, 60)
    // Simulate the race at the production CAS seam: the row is eligible by
    // the time the single Lua guard runs (observed holder already matches).
    await redis.set(
      key,
      JSON.stringify({ ...row, workerId: 'expected' }),
      'EX',
      60
    )
    const result = await transferSessionOwnership(id, 'replacement', 'expected')
    expect(result).toEqual({ transferred: true })
    expect(await readRaw(key)).toMatchObject({ workerId: 'replacement' })
  })

  it('preserves newer provider and owner fields when heartbeat races a terminal commit', async () => {
    const id = sessionId('heartbeat-vs-terminal')
    const key = await seedRaw(
      id,
      makeSession(id, {
        status: 'running',
        workerId: 'worker-a',
        providerSessionId: 'provider-first',
      })
    )
    const before = await readRaw(key)

    const [statusOk, touchOk, providerOk] = await Promise.all([
      updateSessionStatus(id, 'failed'),
      touchSessionHeartbeat(id),
      updateProviderSessionId(id, 'provider-second'),
    ])

    expect(statusOk).toBe(true)
    expect(providerOk).toBe(true)
    // The terminal commit wins the predicate race against at least one
    // ordering; the touch may still succeed when it runs first, but it must
    // never change the status or clear the newer provider id.
    void touchOk
    expect(await readRaw(key)).toMatchObject({
      status: 'failed',
      providerSessionId: 'provider-second',
      workerId: 'worker-a',
      worktreePath: before.worktreePath,
    })
  })

  it('heartbeat never refreshes a terminal row', async () => {
    for (const status of [
      'completed',
      'failed',
      'stopped',
      'timed_out',
    ] as const) {
      const id = sessionId(`terminal-touch-${status}`)
      const key = await seedRaw(id, makeSession(id, { status }))
      const before = await redis.get(key)
      const beforeTtl = await redis.ttl(key)

      await expect(touchSessionHeartbeat(id)).resolves.toBe(false)
      await expect(redis.get(key)).resolves.toBe(before)
      expect(await redis.ttl(key)).toBeGreaterThanOrEqual(beforeTtl - 2)
    }
  })

  it('provider and cost patches preserve untouched fields, TTL, and missing-row behavior', async () => {
    const missingId = sessionId('metadata-missing')
    const missingKey = sessionKey(missingId)
    await expect(
      updateProviderSessionId(missingId, 'provider-x')
    ).resolves.toBe(false)
    await expect(
      updateSessionCostData(missingId, { totalCostUsd: 1 })
    ).resolves.toBe(false)
    await expect(updateSessionStatus(missingId, 'running')).resolves.toBe(false)
    await expect(touchSessionHeartbeat(missingId)).resolves.toBe(false)
    await expect(redis.exists(missingKey)).resolves.toBe(0)

    const id = sessionId('metadata-ttl')
    const key = await seedRaw(
      id,
      makeSession(id, {
        status: 'running',
        workerId: 'worker-a',
        worktreePath: '/tmp/keep',
        issueIdentifier: 'GEN-1',
      }),
      60
    )
    await expect(
      updateProviderSessionId(id, 'provider-keep')
    ).resolves.toBe(true)
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(
      SESSION_TTL_SECONDS - 2
    )
    await expect(
      updateSessionCostData(id, { totalCostUsd: 3.25 })
    ).resolves.toBe(true)
    expect(await readRaw(key)).toMatchObject({
      status: 'running',
      workerId: 'worker-a',
      worktreePath: '/tmp/keep',
      issueIdentifier: 'GEN-1',
      providerSessionId: 'provider-keep',
      totalCostUsd: 3.25,
    })
  })

  it('status patches preserve newer cost/provider fields and stay idempotent', async () => {
    const id = sessionId('status-preserves-metadata')
    const key = await seedRaw(
      id,
      makeSession(id, {
        status: 'running',
        workerId: 'worker-a',
        providerSessionId: 'provider-new',
        totalCostUsd: 4.5,
        inputTokens: 40,
        outputTokens: 5,
      })
    )

    await expect(updateSessionStatus(id, 'completed')).resolves.toBe(true)
    await expect(updateSessionStatus(id, 'completed')).resolves.toBe(true)
    expect(await readRaw(key)).toMatchObject({
      status: 'completed',
      providerSessionId: 'provider-new',
      totalCostUsd: 4.5,
      inputTokens: 40,
      outputTokens: 5,
      workerId: 'worker-a',
    })
  })

  it('transfer keeps the newer owner and reset preserves cost metadata', async () => {
    const id = sessionId('transfer-vs-reset')
    const key = await seedRaw(
      id,
      makeSession(id, {
        status: 'claimed',
        workerId: 'worker-first',
        claimedAt: 777,
        totalCostUsd: 2.0,
        providerSessionId: 'provider-keep',
      })
    )

    // A newer owner wins first; a stale transfer against the old owner fails.
    await expect(
      transferSessionOwnership(id, 'worker-second', 'worker-first')
    ).resolves.toEqual({ transferred: true })
    await expect(
      transferSessionOwnership(id, 'worker-stale', 'worker-first')
    ).resolves.toMatchObject({ transferred: false })
    expect(await readRaw(key)).toMatchObject({
      workerId: 'worker-second',
      status: 'claimed',
      totalCostUsd: 2.0,
      providerSessionId: 'provider-keep',
    })

    // Concurrent transfer/reset: the reset clears the binding while
    // preserving cost/provider metadata. An unowned row still accepts a
    // transfer (preserving the previous behavior for rows that never
    // recorded an owner); the atomic owner check only rejects a stale
    // transfer while a NEWER owner is present, as covered above.
    await expect(resetSessionForRequeue(id)).resolves.toBe(true)
    expect(await readRaw(key)).toMatchObject({
      status: 'pending',
      totalCostUsd: 2.0,
      providerSessionId: 'provider-keep',
    })
    expect((await readRaw(key)).workerId).toBeUndefined()
    await expect(
      transferSessionOwnership(id, 'worker-late', 'worker-second')
    ).resolves.toEqual({ transferred: true })
    expect(await readRaw(key)).toMatchObject({
      status: 'pending',
      workerId: 'worker-late',
      totalCostUsd: 2.0,
      providerSessionId: 'provider-keep',
    })
  })

  it('malformed rows throw for writers and never refresh on touch', async () => {
    const id = sessionId('malformed-metadata')
    const key = sessionKey(id)
    await redis.set(key, '{not-json', 'EX', 60)

    await expect(updateSessionStatus(id, 'running')).rejects.toThrow()
    await expect(
      updateSessionCostData(id, { totalCostUsd: 1 })
    ).rejects.toThrow()
    await expect(
      updateProviderSessionId(id, 'provider-x')
    ).rejects.toThrow()
    await expect(resetSessionForRequeue(id)).rejects.toThrow()
    await expect(
      transferSessionOwnership(id, 'worker-new', 'worker-old')
    ).rejects.toThrow()
    await expect(touchSessionHeartbeat(id)).resolves.toBe(false)
    await expect(redis.get(key)).resolves.toBe('{not-json')
  })
})
