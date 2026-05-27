/**
 * Merge Worker Sidecar
 *
 * Starts the merge worker as a background loop alongside the fleet.
 * Only one merge worker runs per repo (enforced by Redis lock).
 *
 * The sidecar:
 * 1. Reads .donmai/config.yaml for merge queue settings
 * 2. Creates a dedicated worktree for merge operations
 * 3. Starts the MergeWorker poll loop
 * 4. Stops gracefully on AbortSignal
 *
 * If Redis is not configured or merge queue is not enabled, this is a no-op.
 */

import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import {
  loadRepositoryConfig,
  MergeWorker,
  LocalMergeQueueAdapter,
  type MergeWorkerConfig,
  type MergeWorkerDeps,
  type IssueTrackerClient,
} from '@donmai/core'
import {
  MergeQueueStorage,
  createLocalMergeQueueStorage,
  isRedisConfigured,
  redisSetNX,
  redisDel,
  redisGet,
  redisSet,
  redisExpire,
} from '@donmai/server'
import { LinearIssueTrackerClient, ProxyIssueTrackerAdapter } from '@donmai/plugin-linear'

const execFileAsync = promisify(execFile)

/** Label used to opt a PR into the local merge queue (REN-503 handoff signal). */
export const APPROVED_FOR_MERGE_LABEL = 'approved-for-merge'

/** `gh pr list` limit — plenty of headroom; real queues rarely exceed 10. */
const LABEL_POLL_MAX_PRS = 50

/** Timeout for the `gh pr list` call — stays within one poll interval. */
const LABEL_POLL_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeWorkerSidecarConfig {
  /** Git repository root (default: auto-detect from cwd) */
  gitRoot?: string
  /** Override repoId (default: derived from git remote) */
  repoId?: string
  /**
   * Issue tracker for bubbling merge results back to the originating issue.
   * When omitted, the sidecar autodetects in this order:
   *   1. LINEAR_API_KEY env var → direct Linear client
   *   2. proxyConfig.apiUrl + apiKey → proxy through coordinator API
   *   3. neither → no bubble-up (failures land in Redis only)
   * Pass `null` explicitly to disable bubble-up regardless of env state.
   */
  issueTracker?: IssueTrackerClient | null
  /**
   * Coordinator API credentials for the proxy issue tracker. When the
   * fleet runs against a platform that proxies all Linear operations
   * (rather than each worker holding a Linear API key directly), pass
   * the same apiUrl/apiKey workers use. The sidecar constructs a
   * ProxyIssueTrackerAdapter from these when LINEAR_API_KEY is not set.
   */
  proxyConfig?: {
    apiUrl: string
    apiKey: string
  }
}

export interface MergeWorkerSidecarHandle {
  /** Stop the merge worker gracefully */
  stop(): void
  /** Promise that resolves when the worker exits */
  done: Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGitRoot(): string {
  return execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function getRepoId(gitRoot: string): string {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    // Extract owner/repo from git URL
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)
    return match ? match[1] : 'default'
  } catch {
    return 'default'
  }
}

/**
 * Split a `owner/repo` repoId into components. Returns null for unparseable
 * values (e.g., the "default" fallback) so callers can skip label polling
 * without crashing.
 */
export function splitRepoId(repoId: string): { owner: string; repo: string } | null {
  const parts = repoId.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

/**
 * Resolve which issue tracker the worker should use:
 *   - explicit `null` → opt-out (no bubble-up)
 *   - explicit instance → use it
 *   - omitted (undefined) → autodetect:
 *       1. LINEAR_API_KEY env var → direct Linear client
 *       2. proxyConfig.apiUrl + apiKey → proxy through coordinator API
 *       3. neither → null (no bubble-up)
 *
 * The proxy path supports deployments where workers don't hold Linear
 * credentials directly and instead route all tracker operations through
 * a coordinator. Mirrors the worker-runner.ts resolution order so the
 * sidecar matches whatever the fleet's workers use.
 *
 * Exported for testing.
 */
export function resolveIssueTracker(
  fromConfig: IssueTrackerClient | null | undefined,
  proxyConfig?: { apiUrl: string; apiKey: string },
): IssueTrackerClient | null {
  if (fromConfig === null) return null
  if (fromConfig) return fromConfig

  const linearApiKey = process.env.LINEAR_API_KEY
  if (linearApiKey) {
    return new LinearIssueTrackerClient({ apiKey: linearApiKey })
  }

  if (proxyConfig?.apiUrl && proxyConfig?.apiKey) {
    return new ProxyIssueTrackerAdapter({
      apiUrl: proxyConfig.apiUrl,
      apiKey: proxyConfig.apiKey,
    })
  }

  return null
}

/** Shape `gh pr list --json number` returns (we only use `number`). */
interface LabeledPR {
  number: number
}

/** Minimal adapter surface the label poller needs. Exported for testing. */
export interface LabelPollerAdapter {
  canEnqueue(owner: string, repo: string, prNumber: number): Promise<boolean>
  enqueue(owner: string, repo: string, prNumber: number): Promise<unknown>
}

/**
 * Poll GitHub for PRs carrying the `approved-for-merge` label and hand any
 * that aren't already queued to the merge queue adapter. This is the
 * secondary REN-503 handoff path — complements the orchestrator's
 * synchronous enqueue on acceptance pass, covers human-initiated queueing
 * (someone labels a PR by hand), and recovers from any missed acceptance
 * event (agent crashed between pass and enqueue).
 *
 * Exported for testing. `gh` is invoked via execFile (no shell), with a
 * dedicated timeout so a stalled call doesn't wedge the sidecar.
 *
 * Returns the number of PRs that were newly enqueued this pass (already-
 * queued PRs are idempotently no-op and not counted).
 */
export async function pollApprovedForMergeLabel(
  adapter: LabelPollerAdapter,
  owner: string,
  repo: string,
  options: {
    /** Injectable for testing — defaults to `gh pr list` via execFile. */
    listLabeledPRs?: (owner: string, repo: string, signal?: AbortSignal) => Promise<LabeledPR[]>
    log?: (msg: string) => void
    /** Abort signal; an in-flight `gh` call is killed and the poll returns 0 on abort. */
    signal?: AbortSignal
  } = {},
): Promise<number> {
  const log = options.log ?? ((m: string) => console.log(`[merge-worker] ${m}`))
  const list = options.listLabeledPRs ?? defaultListLabeledPRs

  if (options.signal?.aborted) return 0

  let prs: LabeledPR[]
  try {
    prs = await list(owner, repo, options.signal)
  } catch (error) {
    log(`label poll failed: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }

  if (prs.length === 0) return 0

  let enqueued = 0
  for (const pr of prs) {
    // Bail mid-iteration if shutdown has been requested — the fleet is
    // trying to tear down and we don't want to keep enqueueing PRs.
    if (options.signal?.aborted) break
    try {
      const canEnqueue = await adapter.canEnqueue(owner, repo, pr.number)
      if (!canEnqueue) continue
      // adapter.enqueue is idempotent: if already queued it returns the
      // current status without double-inserting, so we don't need to
      // pre-check `isEnqueued` — simpler and avoids a race between check
      // and insert.
      await adapter.enqueue(owner, repo, pr.number)
      enqueued++
      log(`enqueued labeled PR #${pr.number} (${owner}/${repo})`)
    } catch (error) {
      log(`failed to enqueue labeled PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return enqueued
}

/**
 * Remove the `approved-for-merge` label from a PR via the `gh` CLI. Best-
 * effort — logs on failure but never throws. Exported for testing.
 *
 * `gh pr edit --remove-label` is idempotent: if the label isn't present it
 * exits non-zero with "Unprocessable Entity" style output. We treat that as
 * success because the end state is what we want.
 */
export async function removeApprovedForMergeLabel(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  try {
    await execFileAsync(
      'gh',
      [
        'pr', 'edit', String(prNumber),
        '--repo', `${owner}/${repo}`,
        '--remove-label', APPROVED_FOR_MERGE_LABEL,
      ],
      { timeout: LABEL_POLL_TIMEOUT_MS },
    )
    console.log(`[merge-worker] removed ${APPROVED_FOR_MERGE_LABEL} label from PR #${prNumber}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Label already absent is success from our perspective — the PR no
    // longer has the label, which is the desired post-condition.
    if (msg.includes('does not have label') || msg.includes('not found')) {
      return
    }
    console.warn(
      `[merge-worker] failed to remove ${APPROVED_FOR_MERGE_LABEL} label from PR #${prNumber}: ${msg}`,
    )
  }
}

/**
 * Fetch a PR's state via `gh pr view`. Returns null when the call fails
 * (network, missing PR, gh not installed) so callers can fall through to
 * the normal merge path rather than skipping unintentionally.
 */
export async function getPRState(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ state: 'OPEN' | 'CLOSED' | 'MERGED'; mergedAt: string | null } | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr', 'view', String(prNumber),
        '--repo', `${owner}/${repo}`,
        '--json', 'state,mergedAt',
      ],
      { timeout: LABEL_POLL_TIMEOUT_MS },
    )
    const parsed = JSON.parse(stdout.trim() || '{}') as {
      state?: string
      mergedAt?: string | null
    }
    if (parsed.state === 'OPEN' || parsed.state === 'CLOSED' || parsed.state === 'MERGED') {
      return { state: parsed.state, mergedAt: parsed.mergedAt ?? null }
    }
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[merge-worker] getPRState(#${prNumber}) failed: ${msg}`)
    return null
  }
}

async function defaultListLabeledPRs(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<LabeledPR[]> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr', 'list',
      '--state', 'open',
      '--label', APPROVED_FOR_MERGE_LABEL,
      '--repo', `${owner}/${repo}`,
      '--json', 'number',
      '--limit', String(LABEL_POLL_MAX_PRS),
    ],
    { timeout: LABEL_POLL_TIMEOUT_MS, signal },
  )
  const parsed = JSON.parse(stdout.trim() || '[]') as Array<{ number: number }>
  return parsed.filter((p): p is LabeledPR => typeof p.number === 'number')
}

function ensureMergeWorktree(gitRoot: string): string {
  const worktreeBase = path.resolve(gitRoot, '..', path.basename(gitRoot) + '.wt')
  const worktreePath = path.join(worktreeBase, '__merge-worker__')

  if (fs.existsSync(worktreePath)) {
    // Verify it's a valid worktree
    try {
      execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] })
      // Pull latest main
      execSync('git fetch origin main && git reset --hard origin/main', {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return worktreePath
    } catch {
      // Invalid worktree — recreate
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch { /* best effort */ }
    }
  }

  // Create the worktree directory parent
  fs.mkdirSync(worktreeBase, { recursive: true })

  // Create a detached worktree on main
  execSync(`git worktree add --detach "${worktreePath}" origin/main`, {
    cwd: gitRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return worktreePath
}

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

/**
 * Start the merge worker sidecar if merge queue is enabled.
 *
 * Returns a handle to stop the worker, or null if merge queue is not
 * configured or Redis is unavailable. Safe to call unconditionally —
 * it checks all preconditions before starting.
 */
export function startMergeWorkerSidecar(
  config: MergeWorkerSidecarConfig = {},
  signal?: AbortSignal,
): MergeWorkerSidecarHandle | null {
  // Check Redis
  if (!isRedisConfigured()) {
    return null
  }

  // Check repo config
  const gitRoot = config.gitRoot ?? getGitRoot()
  const repoConfig = loadRepositoryConfig(gitRoot)
  if (!repoConfig?.mergeQueue?.enabled) {
    return null
  }

  const provider = repoConfig.mergeQueue.provider ?? 'local'
  if (provider !== 'local') {
    // GitHub-native or other external providers handle merging themselves
    return null
  }

  const repoId = config.repoId ?? getRepoId(gitRoot)

  // Create dedicated worktree for merge operations
  let worktreePath: string
  try {
    worktreePath = ensureMergeWorktree(gitRoot)
  } catch (error) {
    console.warn(`[merge-worker] Failed to create merge worktree: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  // Build merge worker config from repo config
  const mqConfig = repoConfig.mergeQueue
  const workerConfig: MergeWorkerConfig = {
    repoId,
    repoPath: worktreePath,
    strategy: mqConfig.strategy ?? 'rebase',
    testCommand: mqConfig.testCommand ?? 'pnpm test',
    testTimeout: mqConfig.testTimeout ?? 300_000,
    lockFileRegenerate: mqConfig.lockFileRegenerate ?? true,
    mergiraf: mqConfig.mergiraf ?? true,
    pollInterval: mqConfig.pollInterval ?? 10_000,
    maxRetries: mqConfig.maxRetries ?? 2,
    escalation: {
      onConflict: mqConfig.escalation?.onConflict ?? 'reassign',
      onTestFailure: mqConfig.escalation?.onTestFailure ?? 'notify',
    },
    deleteBranchOnMerge: mqConfig.deleteBranchOnMerge ?? true,
    packageManager: (repoConfig.packageManager ?? 'pnpm') as 'pnpm' | 'npm' | 'yarn' | 'bun',
    remote: 'origin',
    targetBranch: 'main',
  }

  // Resolve the issue tracker for merge-result bubble-up. Caller can pass
  // an instance, opt out with `null`, or rely on autodetect (Linear key
  // first, then proxy config). Without a tracker the worker still
  // functions — failures land in Redis and the CLI can read them, but the
  // originating issue won't auto-demote.
  const issueTracker = resolveIssueTracker(config.issueTracker, config.proxyConfig)

  // Wire a PR labeler when we can parse owner/repo from the repoId.
  // Non-GitHub deployments (or unparseable repoIds) skip it — the worker
  // will no-op the label-removal call. On terminal failures (conflict,
  // test-failure, error) the worker removes the `approved-for-merge`
  // label so the label poller doesn't immediately re-enqueue the same PR.
  //
  // `getPRState` is the pre-flight check that prevents stale duplicate
  // entries from re-running the merge work and posting spurious Rejected
  // status to the originating issue (the REN-1165 failure mode).
  const labelRepoParts = splitRepoId(repoId)
  const prLabeler = labelRepoParts
    ? {
        removeApprovedForMergeLabel: (prNumber: number) =>
          removeApprovedForMergeLabel(labelRepoParts.owner, labelRepoParts.repo, prNumber),
        getPRState: (prNumber: number) =>
          getPRState(labelRepoParts.owner, labelRepoParts.repo, prNumber),
      }
    : undefined

  // Wire Redis deps for the merge worker
  const storage = new MergeQueueStorage()
  const deps: MergeWorkerDeps = {
    storage: {
      dequeue: (id) => storage.dequeue(id),
      markCompleted: (id, pr) => storage.markCompleted(id, pr),
      markFailed: (id, pr, reason) => storage.markFailed(id, pr, reason),
      markBlocked: (id, pr, reason) => storage.markBlocked(id, pr, reason),
      peekAll: (id) => storage.peekAll(id),
      dequeueBatch: (id, prs) => storage.dequeueBatch(id, prs),
    },
    redis: {
      setNX: async (key, value, ttl) => {
        const result = await redisSetNX(key, value, ttl)
        return result
      },
      del: (key) => redisDel(key).then(() => undefined),
      get: (key) => redisGet<string>(key),
      set: (key, value) => redisSet(key, value).then(() => undefined),
      expire: (key, seconds) => redisExpire(key, seconds).then(() => undefined),
    },
    ...(issueTracker ? { issueTracker } : {}),
    ...(prLabeler ? { prLabeler } : {}),
  }

  const worker = new MergeWorker(workerConfig, deps)

  console.log(`[merge-worker] Starting merge worker sidecar (repo: ${repoId}, worktree: ${worktreePath})`)
  if (issueTracker) {
    const mode = process.env.LINEAR_API_KEY
      ? 'direct Linear'
      : (config.proxyConfig?.apiUrl ? 'proxy via coordinator' : 'caller-supplied')
    console.log(`[merge-worker] Issue tracker enabled (${mode}) — merge results will bubble back to issues (success → Accepted, failure → Rejected)`)
  } else {
    console.log('[merge-worker] No issue tracker configured — merge failures will land in Redis only (set LINEAR_API_KEY or pass proxyConfig to enable bubble-up)')
  }

  const done = worker.start(signal).catch((error) => {
    // Lock acquisition failure is expected if another worker is already running
    if (error instanceof Error && error.message.includes('already running')) {
      console.log(`[merge-worker] Another merge worker is already running for ${repoId} — skipping`)
    } else {
      console.error(`[merge-worker] Merge worker error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Label poller — REN-503 secondary handoff path. Polls GitHub for PRs
  // carrying `approved-for-merge` and enqueues them via the local adapter.
  // Complements the orchestrator's synchronous enqueue on acceptance pass:
  //   - Recovers from missed acceptance events (agent crash, backstop gap)
  //   - Enables human-initiated queueing (`gh pr edit N --add-label …`)
  //   - No effect if repoId is unparseable (e.g., default-fallback string)
  //
  // The adapter requires the full LocalMergeQueueStorage interface
  // (isEnqueued, getPosition, getQueueDepth, remove, getFailedReason,
  // getBlockedReason…). The server's MergeQueueStorage doesn't match
  // that shape 1:1 — e.g., `remove` maps to `skip`. Use the existing
  // bridge instead of casting; the bridge is the supported adapter path.
  const adapter = new LocalMergeQueueAdapter(createLocalMergeQueueStorage(storage))
  const repoParts = splitRepoId(repoId)
  const labelPollHandle = repoParts
    ? startLabelPollLoop(adapter, repoParts.owner, repoParts.repo, workerConfig.pollInterval, signal)
    : null

  return {
    stop: () => {
      labelPollHandle?.stop()
      worker.stop()
    },
    done,
  }
}

/**
 * Start a setInterval loop that runs the label poller at the worker's
 * pollInterval. Returns a handle that can be stopped. Errors in the poller
 * are caught inside pollApprovedForMergeLabel — the loop itself never throws.
 */
function startLabelPollLoop(
  adapter: LabelPollerAdapter,
  owner: string,
  repo: string,
  pollIntervalMs: number,
  signal?: AbortSignal,
): { stop: () => void } {
  let stopped = false
  const run = async (): Promise<void> => {
    if (stopped || signal?.aborted) return
    await pollApprovedForMergeLabel(adapter, owner, repo, { signal })
  }

  // First tick immediately so a labeled PR isn't delayed by up to pollInterval
  // on startup; then run on the configured cadence.
  void run()
  const timer = setInterval(() => void run(), pollIntervalMs)

  signal?.addEventListener('abort', () => {
    stopped = true
    clearInterval(timer)
  })

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
