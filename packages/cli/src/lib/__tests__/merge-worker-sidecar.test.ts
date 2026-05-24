import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from 'child_process'
import {
  pollApprovedForMergeLabel,
  splitRepoId,
  resolveIssueTracker,
  removeApprovedForMergeLabel,
  APPROVED_FOR_MERGE_LABEL,
  type LabelPollerAdapter,
} from '../merge-worker-sidecar.js'
import { LocalMergeQueueAdapter } from '@donmai/core'
import { createLocalMergeQueueStorage } from '@donmai/server'

const mockExecFile = vi.mocked(execFile)

// ---------------------------------------------------------------------------
// splitRepoId
// ---------------------------------------------------------------------------

describe('splitRepoId', () => {
  it('parses owner/repo correctly', () => {
    expect(splitRepoId('RenseiAI/platform')).toEqual({ owner: 'RenseiAI', repo: 'platform' })
  })

  it('returns null for the default-fallback string', () => {
    // getRepoId returns "default" when no git remote is configured.
    // The sidecar must not call `gh pr list --repo default` against GitHub.
    expect(splitRepoId('default')).toBeNull()
  })

  it('returns null for values with more than one slash (ambiguous)', () => {
    expect(splitRepoId('org/team/repo')).toBeNull()
  })

  it('returns null for empty components', () => {
    expect(splitRepoId('/repo')).toBeNull()
    expect(splitRepoId('owner/')).toBeNull()
    expect(splitRepoId('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pollApprovedForMergeLabel
// ---------------------------------------------------------------------------

describe('pollApprovedForMergeLabel', () => {
  function makeAdapter(overrides: Partial<LabelPollerAdapter> = {}): LabelPollerAdapter & {
    canEnqueueMock: ReturnType<typeof vi.fn>
    enqueueMock: ReturnType<typeof vi.fn>
  } {
    const canEnqueueMock = vi.fn(overrides.canEnqueue ?? (async () => true))
    const enqueueMock = vi.fn(overrides.enqueue ?? (async () => ({ state: 'queued' })))
    return {
      canEnqueue: canEnqueueMock,
      enqueue: enqueueMock,
      canEnqueueMock,
      enqueueMock,
    }
  }

  it('enqueues each labeled PR returned by the list callback', async () => {
    const adapter = makeAdapter()
    const listLabeledPRs = vi.fn(async () => [
      { number: 61 },
      { number: 72 },
      { number: 85 },
    ])

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log: () => {} },
    )

    expect(enqueued).toBe(3)
    expect(adapter.canEnqueueMock).toHaveBeenCalledTimes(3)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 61)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 72)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 85)
  })

  it('skips PRs where canEnqueue returns false', async () => {
    const adapter = makeAdapter({
      canEnqueue: vi.fn(async (_o, _r, prNum) => prNum === 61),
    })
    const listLabeledPRs = vi.fn(async () => [
      { number: 61 }, // eligible
      { number: 72 }, // rejected by canEnqueue
    ])

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log: () => {} },
    )

    expect(enqueued).toBe(1)
    expect(adapter.enqueueMock).toHaveBeenCalledTimes(1)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 61)
  })

  it('returns 0 and does not throw when the list callback fails', async () => {
    const adapter = makeAdapter()
    const listLabeledPRs = vi.fn(async () => {
      throw new Error('gh: command not found')
    })
    const log = vi.fn()

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log },
    )

    expect(enqueued).toBe(0)
    expect(adapter.enqueueMock).not.toHaveBeenCalled()
    // Error is logged, not thrown — sidecar loop must never crash on a
    // transient gh failure.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('label poll failed'))
  })

  it('continues after one PR fails to enqueue (independent failures)', async () => {
    let enqueueCalls = 0
    const adapter = makeAdapter({
      canEnqueue: async () => true,
      enqueue: vi.fn(async (_o, _r, prNum) => {
        enqueueCalls++
        if (prNum === 72) throw new Error('Redis connection lost')
        return { state: 'queued' }
      }),
    })
    const log = vi.fn()

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      {
        listLabeledPRs: async () => [{ number: 61 }, { number: 72 }, { number: 85 }],
        log,
      },
    )

    expect(enqueueCalls).toBe(3) // all attempted
    expect(enqueued).toBe(2) // 61, 85 succeeded
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to enqueue labeled PR #72'))
  })

  it('returns 0 when no PRs are labeled', async () => {
    const adapter = makeAdapter()
    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs: async () => [], log: () => {} },
    )
    expect(enqueued).toBe(0)
    expect(adapter.canEnqueueMock).not.toHaveBeenCalled()
    expect(adapter.enqueueMock).not.toHaveBeenCalled()
  })

  it('exports the label name for agents to reference', () => {
    // The template instructs agents to add this exact label. If we rename
    // the constant, acceptance-template renders must update in lockstep.
    expect(APPROVED_FOR_MERGE_LABEL).toBe('approved-for-merge')
  })

  // -----------------------------------------------------------------------
  // AbortSignal plumbing — the sidecar kept marking PRs failed + enqueueing
  // labeled PRs for ~30s after SIGINT. Every shutdown-aware code path must
  // short-circuit when the signal has aborted.
  // -----------------------------------------------------------------------

  it('returns 0 immediately when the signal is already aborted (no list call)', async () => {
    const adapter = makeAdapter()
    const listLabeledPRs = vi.fn(async () => [{ number: 61 }])
    const controller = new AbortController()
    controller.abort()

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log: () => {}, signal: controller.signal },
    )

    expect(enqueued).toBe(0)
    expect(listLabeledPRs).not.toHaveBeenCalled()
    expect(adapter.canEnqueueMock).not.toHaveBeenCalled()
    expect(adapter.enqueueMock).not.toHaveBeenCalled()
  })

  it('passes the signal through to the list callback (so execFile can kill gh)', async () => {
    const adapter = makeAdapter()
    const controller = new AbortController()
    const listLabeledPRs = vi.fn(async (_o: string, _r: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      return [{ number: 61 }]
    })

    await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log: () => {}, signal: controller.signal },
    )

    expect(listLabeledPRs).toHaveBeenCalledWith('RenseiAI', 'platform', controller.signal)
  })

  it('stops mid-iteration when the signal aborts between PRs', async () => {
    const adapter = makeAdapter()
    const controller = new AbortController()
    // After the first enqueue, abort — the loop should break before #72.
    adapter.enqueueMock.mockImplementation(async () => {
      controller.abort()
      return { state: 'queued' }
    })

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      {
        listLabeledPRs: async () => [{ number: 61 }, { number: 72 }, { number: 85 }],
        log: () => {},
        signal: controller.signal,
      },
    )

    expect(enqueued).toBe(1)
    expect(adapter.enqueueMock).toHaveBeenCalledTimes(1)
    // #72 and #85 never touched.
    expect(adapter.enqueueMock).not.toHaveBeenCalledWith('RenseiAI', 'platform', 72)
    expect(adapter.enqueueMock).not.toHaveBeenCalledWith('RenseiAI', 'platform', 85)
  })
})

// ---------------------------------------------------------------------------
// resolveIssueTracker
// ---------------------------------------------------------------------------

describe('resolveIssueTracker', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.LINEAR_API_KEY
    delete process.env.LINEAR_API_KEY
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = originalEnv
  })

  it('returns null when caller passes null (explicit opt-out)', () => {
    process.env.LINEAR_API_KEY = 'lin_xxx' // even when env is set, null wins
    expect(resolveIssueTracker(null)).toBeNull()
  })

  it('returns null when no LINEAR_API_KEY and no explicit instance', () => {
    expect(resolveIssueTracker(undefined)).toBeNull()
  })

  it('returns the explicit instance when provided', () => {
    const fake = { getIssue: () => Promise.resolve({} as never) } as never
    expect(resolveIssueTracker(fake)).toBe(fake)
  })

  it('autodetects from LINEAR_API_KEY env when caller passes undefined', () => {
    process.env.LINEAR_API_KEY = 'lin_xxx'
    const tracker = resolveIssueTracker(undefined)
    expect(tracker).not.toBeNull()
    // Has the IssueTrackerClient surface
    expect(typeof tracker?.getIssue).toBe('function')
    expect(typeof tracker?.createComment).toBe('function')
    expect(typeof tracker?.updateIssueStatus).toBe('function')
  })

  it('falls back to proxy adapter when LINEAR_API_KEY is absent but proxyConfig is supplied', () => {
    // Coordinator-proxied deployments don't set LINEAR_API_KEY in the
    // worker fleet env — workers route Linear ops through the platform's
    // API. The sidecar must use the same path or its bubble-up silently
    // no-ops, leaving Accepted-but-unmerged issues stuck.
    const tracker = resolveIssueTracker(undefined, {
      apiUrl: 'https://platform.example.com',
      apiKey: 'pf_xxx',
    })
    expect(tracker).not.toBeNull()
    expect(typeof tracker?.getIssue).toBe('function')
    expect(typeof tracker?.createComment).toBe('function')
    expect(typeof tracker?.updateIssueStatus).toBe('function')
  })

  it('prefers Linear key over proxy when both are present', () => {
    // Direct Linear access is faster than going through the coordinator.
    // If a deployment somehow has both, prefer the direct path.
    process.env.LINEAR_API_KEY = 'lin_xxx'
    const tracker = resolveIssueTracker(undefined, {
      apiUrl: 'https://platform.example.com',
      apiKey: 'pf_xxx',
    })
    expect(tracker).not.toBeNull()
    // Both are valid IssueTrackerClient implementations; we don't assert
    // class identity (would couple this test to internals), but we do
    // verify the resolution didn't end up null.
  })

  it('returns null when neither Linear key nor proxy config is available', () => {
    expect(resolveIssueTracker(undefined, undefined)).toBeNull()
    expect(resolveIssueTracker(undefined, { apiUrl: '', apiKey: '' })).toBeNull()
  })

  it('null override wins over proxy config too', () => {
    // Explicit opt-out: a deployment may want to disable bubble-up even
    // when proxy credentials are available (e.g., dry-run mode).
    expect(resolveIssueTracker(null, {
      apiUrl: 'https://platform.example.com',
      apiKey: 'pf_xxx',
    })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// LocalMergeQueueAdapter wiring (regression)
// ---------------------------------------------------------------------------
//
// Context: v0.8.53 shipped a sidecar that constructed the label poller's
// adapter with `new LocalMergeQueueAdapter(deps.storage as never)`. But
// deps.storage is a narrowed shim that only exposes what MergeWorker
// needs (dequeue/markCompleted/markFailed/markBlocked/peekAll/dequeueBatch).
// The adapter calls isEnqueued / getPosition / remove / getFailedReason /
// getBlockedReason on storage — none of which existed on the shim. At
// runtime: `this.storage.isEnqueued is not a function`.
//
// The `as never` hid the mismatch. The fix routes storage through
// createLocalMergeQueueStorage (the existing server→core bridge) which
// returns a fully-typed LocalMergeQueueStorage. Removing the cast means
// the type system catches this at compile time going forward; this test
// catches it at runtime for good measure.

describe('LocalMergeQueueAdapter wiring via bridge', () => {
  /**
   * Faithful mock of MergeQueueStorage surface for bridge wiring.
   * All methods return sensible defaults so we can call through without
   * caring about the data — the test is about wiring, not behavior.
   */
  function createMockMergeQueueStorage() {
    return {
      enqueue: vi.fn(async () => undefined),
      dequeue: vi.fn(async () => null),
      peek: vi.fn(async () => null),
      peekAll: vi.fn(async () => []),
      dequeueBatch: vi.fn(async () => []),
      reorder: vi.fn(async () => undefined),
      markCompleted: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      markBlocked: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({ depth: 0, processing: null, failed: [], blocked: [] })),
      retry: vi.fn(async () => undefined),
      skip: vi.fn(async () => undefined),
      isEnqueued: vi.fn(async () => false),
      getPosition: vi.fn(async () => null),
      getFailedReason: vi.fn(async () => null),
      getBlockedReason: vi.fn(async () => null),
      list: vi.fn(async () => []),
      listFailed: vi.fn(async () => []),
      listBlocked: vi.fn(async () => []),
    }
  }

  it('createLocalMergeQueueStorage produces a storage the adapter can use', () => {
    const storage = createLocalMergeQueueStorage(createMockMergeQueueStorage() as never)
    // Every method the LocalMergeQueueAdapter touches must be a function —
    // this is the shape that the `as never` cast was hiding.
    expect(typeof storage.enqueue).toBe('function')
    expect(typeof storage.isEnqueued).toBe('function')
    expect(typeof storage.getPosition).toBe('function')
    expect(typeof storage.getFailedReason).toBe('function')
    expect(typeof storage.getBlockedReason).toBe('function')
    expect(typeof storage.remove).toBe('function')
    expect(typeof storage.getQueueDepth).toBe('function')
    expect(typeof storage.peekAll).toBe('function')
    expect(typeof storage.dequeueBatch).toBe('function')
  })

  it('adapter.canEnqueue does not crash with "is not a function"', async () => {
    const storage = createLocalMergeQueueStorage(createMockMergeQueueStorage() as never)
    const adapter = new LocalMergeQueueAdapter(storage)
    // canEnqueue only shells out to gh, which will fail in tests — but it
    // shouldn't throw a TypeError about missing storage methods. If the
    // storage surface is missing a method, we'd get a sync throw here.
    await expect(adapter.canEnqueue('RenseiAI', 'platform', 999)).resolves.not.toThrow()
  })

  it('adapter.enqueue calls isEnqueued without throwing "is not a function"', async () => {
    const mock = createMockMergeQueueStorage()
    const storage = createLocalMergeQueueStorage(mock as never)
    const adapter = new LocalMergeQueueAdapter(storage)

    // adapter.enqueue first checks isEnqueued. If isEnqueued were missing
    // (the original bug), this would throw "is not a function". With the
    // bridge in place, it delegates to mock.isEnqueued and proceeds.
    await adapter.enqueue('RenseiAI', 'platform', 61).catch(() => {
      /* downstream gh call may fail — that's fine, we only care that the
         storage dispatch worked. */
    })

    expect(mock.isEnqueued).toHaveBeenCalledWith('RenseiAI/platform', 61)
  })
})

// ---------------------------------------------------------------------------
// removeApprovedForMergeLabel
//
// Breaks the `markFailed → label poller re-enqueues → markFailed` hot loop
// (REN-1253 follow-up, v0.8.55+). Called by the merge worker on every
// terminal failure state; must be idempotent and best-effort.
// ---------------------------------------------------------------------------

describe('removeApprovedForMergeLabel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockExecFileSuccess(stdout = '') {
    mockExecFile.mockImplementation(((_cmd: string, _args: readonly string[], _opts: unknown, callback?: (err: unknown, stdout: string, stderr: string) => void) => {
      const cb = typeof _opts === 'function' ? _opts : callback
      cb?.(null, stdout, '')
      return {} as ReturnType<typeof execFile>
    }) as unknown as typeof execFile)
  }

  function mockExecFileFailure(message: string) {
    mockExecFile.mockImplementation(((_cmd: string, _args: readonly string[], _opts: unknown, callback?: (err: unknown, stdout: string, stderr: string) => void) => {
      const cb = typeof _opts === 'function' ? _opts : callback
      cb?.(new Error(message), '', message)
      return {} as ReturnType<typeof execFile>
    }) as unknown as typeof execFile)
  }

  it('calls `gh pr edit <N> --repo <owner>/<repo> --remove-label approved-for-merge`', async () => {
    mockExecFileSuccess()

    await removeApprovedForMergeLabel('RenseiAI', 'platform', 63)

    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [cmd, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]]
    expect(cmd).toBe('gh')
    expect(args).toEqual([
      'pr', 'edit', '63',
      '--repo', 'RenseiAI/platform',
      '--remove-label', 'approved-for-merge',
    ])
  })

  it('swallows "does not have label" errors (label already absent is success)', async () => {
    mockExecFileFailure('HTTP 422: Label does not exist on this issue')

    // `gh` returns non-zero when the label isn't on the PR, but the
    // desired post-condition (label absent) already holds. We must not
    // re-throw or log as if it's a real failure.
    await expect(removeApprovedForMergeLabel('RenseiAI', 'platform', 63)).resolves.toBeUndefined()
  })

  it('does not throw when gh CLI is missing', async () => {
    mockExecFileFailure('spawn gh ENOENT')

    // On a workstation without gh installed the removal is a warning,
    // not a fatal error. The worker must keep processing the queue.
    await expect(removeApprovedForMergeLabel('RenseiAI', 'platform', 63)).resolves.toBeUndefined()
  })

  it('does not throw when the PR number is invalid', async () => {
    mockExecFileFailure('no pull requests found for branch')

    await expect(removeApprovedForMergeLabel('RenseiAI', 'platform', 99999)).resolves.toBeUndefined()
  })
})
