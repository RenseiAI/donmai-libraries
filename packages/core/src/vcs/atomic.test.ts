/**
 * AtomicVCSProvider — unit tests
 *
 * Tests cover:
 * - Capability declarations match 008 spec table
 * - Manifest shape
 * - parseAtomicPullOutput — clean / auto-resolved / conflict variants
 * - parseAutoResolutions — per-file resolution parsing
 * - parseAtomicConflicts — conflict extraction
 * - classifyAtomicPushError — auth / policy / non-fast-forward
 * - buildAtomicAttestationMessage — native session metadata format
 * - openProposal() throws structured unsupported-operation error
 * - activate() throws when atomic CLI is absent
 * - Tests that require the actual atomic binary are guarded by describe.skipIf(!hasAtomic)
 *
 * Note: Tests that require the `atomic` binary skip cleanly when the binary is
 * not installed. Run `which atomic` to check — if absent, install atomic and
 * rerun `pnpm --filter @donmai/core test -- vcs/atomic`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execSync } from 'child_process'

// ---------------------------------------------------------------------------
// Detect whether atomic CLI is available
// ---------------------------------------------------------------------------

const hasAtomic = (() => {
  try {
    execSync('which atomic', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// ---------------------------------------------------------------------------
// Mock child_process for unit tests (no binary required)
// ---------------------------------------------------------------------------

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>()
  return {
    ...original,
    exec: vi.fn(),
  }
})

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}))

import { exec } from 'child_process'
import { writeFile, unlink } from 'node:fs/promises'
import {
  AtomicVCSProvider,
  ATOMIC_VCS_CAPABILITIES,
  parseAtomicPullOutput,
  parseAutoResolutions,
  parseAtomicConflicts,
  classifyAtomicPushError,
  buildAtomicAttestationMessage,
} from './atomic.js'
import type { SessionAttestation, Workspace } from './types.js'

const mockExec = vi.mocked(exec)

// ---------------------------------------------------------------------------
// Mock helpers — callback-based (matches how promisify works)
// ---------------------------------------------------------------------------

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void

function mockExecSuccess(stdout = '', stderr = '') {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: unknown) => {
    const cb: ExecCallback = typeof _opts === 'function'
      ? (_opts as ExecCallback)
      : (callback as ExecCallback)
    cb?.(null, { stdout, stderr })
    return {} as ReturnType<typeof exec>
  })
}

function mockExecFailure(message: string) {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: unknown) => {
    const cb: ExecCallback = typeof _opts === 'function'
      ? (_opts as ExecCallback)
      : (callback as ExecCallback)
    cb?.(new Error(message), { stdout: '', stderr: message })
    return {} as ReturnType<typeof exec>
  })
}

function mockExecSequence(
  responses: Array<{ success: boolean; stdout?: string; error?: string }>,
) {
  let callIndex = 0
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: unknown) => {
    const cb: ExecCallback = typeof _opts === 'function'
      ? (_opts as ExecCallback)
      : (callback as ExecCallback)
    const response = responses[callIndex++] ?? { success: true, stdout: '' }
    if (response.success) {
      cb?.(null, { stdout: response.stdout ?? '', stderr: '' })
    } else {
      cb?.(new Error(response.error ?? 'unknown error'), { stdout: '', stderr: response.error ?? '' })
    }
    return {} as ReturnType<typeof exec>
  })
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'atomic:atomic://remote.example.com/org/repo',
    providerId: 'atomic',
    path: '/tmp/test-atomic-workspace',
    headRef: 'patch-abc123',
    ...overrides,
  }
}

function makeAttestation(overrides: Partial<SessionAttestation> = {}): SessionAttestation {
  return {
    agentId: 'agent-002',
    modelRef: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    sessionId: 'sess-atomic-001',
    kitIds: [{ id: 'spring/java', version: '1.0.0' }],
    startedAt: new Date('2026-04-27T00:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Capability profile — matches 008-version-control-providers.md spec table
// ---------------------------------------------------------------------------

describe('Atomic capability profile', () => {
  it('declares patch-theory merge strategy', () => {
    expect(ATOMIC_VCS_CAPABILITIES.mergeStrategy).toBe('patch-theory')
  })

  it('declares token-level conflict granularity', () => {
    expect(ATOMIC_VCS_CAPABILITIES.conflictGranularity).toBe('token')
  })

  it('declares hasPullRequests = false (no PR concept today)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.hasPullRequests).toBe(false)
  })

  it('declares hasReviewWorkflow = false', () => {
    expect(ATOMIC_VCS_CAPABILITIES.hasReviewWorkflow).toBe(false)
  })

  it('declares hasMergeQueue = false (commutative — pushes commute)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.hasMergeQueue).toBe(false)
  })

  it('declares ed25519 identity scheme', () => {
    expect(ATOMIC_VCS_CAPABILITIES.identityScheme).toBe('ed25519')
  })

  it('declares provenanceNative = true (first-class attestation, NOT trailers)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.provenanceNative).toBe(true)
  })

  // ── REN-1343 corpus-008 surface ─────────────────────────────────────────
  it('declares mergeModel = patch-theory (corpus-008 alias of mergeStrategy)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.mergeModel).toBe('patch-theory')
    expect(ATOMIC_VCS_CAPABILITIES.mergeModel).toBe(ATOMIC_VCS_CAPABILITIES.mergeStrategy)
  })

  it('declares patchModel = patch-theoretic (the headline distinction per corpus 008 §Atomic)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.patchModel).toBe('patch-theoretic')
  })

  it('declares branchSemantics = atomic-views (Atomic "views", not git refs)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.branchSemantics).toBe('atomic-views')
  })

  it('declares auditModel = native (Ed25519 + session metadata embedded in patch)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.auditModel).toBe('native')
  })

  it('declares supportsAttest = true (consumed by REN-1314 sigstore work)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.supportsAttest).toBe(true)
  })

  it('declares remoteProtocol = atomic-merkle', () => {
    expect(ATOMIC_VCS_CAPABILITIES.remoteProtocol).toBe('atomic-merkle')
  })

  it('declares supportsRebase = false (rebase is a commit-graph concept)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.supportsRebase).toBe(false)
  })

  it('declares supportsBranches = true (Atomic views are branches)', () => {
    expect(ATOMIC_VCS_CAPABILITIES.supportsBranches).toBe(true)
  })

  it('declares supportsBinary = true', () => {
    expect(ATOMIC_VCS_CAPABILITIES.supportsBinary).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Constructor + manifest
// ---------------------------------------------------------------------------

describe('AtomicVCSProvider constructor', () => {
  it('exposes vcs family manifest', () => {
    const provider = new AtomicVCSProvider()
    expect(provider.manifest.family).toBe('vcs')
    expect(provider.manifest.id).toBe('atomic')
    expect(provider.manifest.apiVersion).toBe('rensei.dev/v1')
  })

  it('has null signature by default', () => {
    const provider = new AtomicVCSProvider()
    expect(provider.signature).toBeNull()
  })

  it('defaults to global scope', () => {
    const provider = new AtomicVCSProvider()
    expect(provider.scope).toEqual({ level: 'global' })
  })

  it('accepts custom scope', () => {
    const provider = new AtomicVCSProvider({ scope: { level: 'tenant', selector: { tenant: 't1' } } })
    expect(provider.scope).toEqual({ level: 'tenant', selector: { tenant: 't1' } })
  })
})

// ---------------------------------------------------------------------------
// openProposal — always unsupported-operation
// ---------------------------------------------------------------------------

describe('AtomicVCSProvider.openProposal()', () => {
  let provider: AtomicVCSProvider

  beforeEach(() => {
    provider = new AtomicVCSProvider()
  })

  it('throws with structured unsupported-operation error', async () => {
    const ws = makeWorkspace()
    await expect(
      provider.openProposal!(ws, { title: 'test PR', body: 'body', baseRef: 'main' })
    ).rejects.toThrow('does not support openProposal')
  })

  it('thrown error includes hasPullRequests capability in message', async () => {
    const ws = makeWorkspace()
    await expect(
      provider.openProposal!(ws, { title: 'test', body: 'body', baseRef: 'main' })
    ).rejects.toThrow('hasPullRequests is false')
  })

  it('thrown error carries a Result-shaped .result property', async () => {
    const ws = makeWorkspace()
    let caught: (Error & { result?: unknown }) | undefined
    try {
      await provider.openProposal!(ws, { title: 'test', body: 'body', baseRef: 'main' })
    } catch (err) {
      caught = err as Error & { result?: unknown }
    }

    expect(caught).toBeDefined()
    expect(caught?.result).toMatchObject({
      ok: false,
      error: {
        kind: 'unsupported-operation',
        capability: 'hasPullRequests',
        providerId: 'atomic',
      },
    })
  })
})

// ---------------------------------------------------------------------------
// activate() — binary availability check
// ---------------------------------------------------------------------------

describe('AtomicVCSProvider.activate()', () => {
  it('throws when atomic CLI is not available', async () => {
    const provider = new AtomicVCSProvider()
    vi.clearAllMocks()
    mockExecFailure('command not found: atomic')

    const host = { emit: vi.fn() }
    await expect(provider.activate(host)).rejects.toThrow('atomic CLI not found')
  })

  it('resolves when atomic --version succeeds', async () => {
    const provider = new AtomicVCSProvider()
    vi.clearAllMocks()
    mockExecSuccess('atomic 0.5.1\n', '')

    const host = { emit: vi.fn() }
    await expect(provider.activate(host)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// push() — error classification
// ---------------------------------------------------------------------------

describe('AtomicVCSProvider.push()', () => {
  let provider: AtomicVCSProvider

  beforeEach(() => {
    provider = new AtomicVCSProvider()
    vi.clearAllMocks()
  })

  it('returns { kind: "pushed" } on success', async () => {
    mockExecSequence([
      { success: true, stdout: '' },              // atomic push
      { success: true, stdout: 'patch-xyz\n' },   // atomic log (resolveAtomicHead)
    ])

    const result = await provider.push(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('pushed')
    if (result.kind === 'pushed') {
      expect(result.ref.ref).toBe('patch-xyz')
    }
  })

  it('returns { kind: "rejected", reason: "auth" } on auth failure', async () => {
    mockExecFailure('Permission denied (authentication)')

    const result = await provider.push(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('auth')
    }
  })

  it('returns { kind: "rejected", reason: "policy" } on policy failure', async () => {
    mockExecFailure('Push rejected by repository policy')

    const result = await provider.push(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('policy')
    }
  })
})

// ---------------------------------------------------------------------------
// pull() — VCSMergeResult variants
// ---------------------------------------------------------------------------

describe('AtomicVCSProvider.pull()', () => {
  let provider: AtomicVCSProvider

  beforeEach(() => {
    provider = new AtomicVCSProvider()
    vi.clearAllMocks()
  })

  it('returns { kind: "clean" } on successful pull with no conflicts', async () => {
    mockExecSuccess('Already up to date.\n', '')

    const result = await provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('clean')
  })

  it('returns { kind: "auto-resolved" } when Atomic auto-resolves patches', async () => {
    mockExecSuccess('Auto-resolved 3 patch(es)\nAuto-resolved src/foo.ts (patch-theory)\n', '')

    const result = await provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('auto-resolved')
    if (result.kind === 'auto-resolved') {
      expect(result.resolutions.length).toBeGreaterThan(0)
    }
  })

  it('returns { kind: "conflict" } when structural conflict occurs', async () => {
    mockExecSequence([
      { success: false, error: 'Conflict in src/main.ts: unresolvable structural conflict' },
    ])

    const result = await provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('conflict')
    if (result.kind === 'conflict') {
      expect(result.conflicts.length).toBeGreaterThan(0)
    }
  })

  it('rethrows unexpected errors', async () => {
    mockExecFailure('network error: connection refused')

    await expect(
      provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    ).rejects.toThrow('network error')
  })
})

// ---------------------------------------------------------------------------
// attest() — native Ed25519 attestation
// ---------------------------------------------------------------------------

describe('AtomicVCSProvider.attest()', () => {
  let provider: AtomicVCSProvider

  beforeEach(() => {
    provider = new AtomicVCSProvider()
    vi.clearAllMocks()
    vi.mocked(writeFile).mockResolvedValue(undefined)
    vi.mocked(unlink).mockResolvedValue(undefined)
  })

  it('returns a native storage kind ref (NOT commit-trailer)', async () => {
    mockExecSequence([
      { success: true, stdout: '' },                  // atomic record --signed
      { success: true, stdout: 'attest-patch-1\n' },  // resolveAtomicHead
    ])

    const ref = await provider.attest!(makeWorkspace(), makeAttestation())
    expect(ref.storageKind).toBe('native')
    expect(ref.id).toBe('attest-patch-1')
    expect(ref.attestedAt).toBeTruthy()
  })

  it('writes session id into the attestation message file', async () => {
    mockExecSequence([
      { success: true, stdout: '' },
      { success: true, stdout: 'attest-patch\n' },
    ])

    await provider.attest!(makeWorkspace(), makeAttestation({ sessionId: 'my-atomic-session' }))

    const writeFileCall = vi.mocked(writeFile).mock.calls[0]
    const writtenContent = writeFileCall[1] as string
    expect(writtenContent).toContain('Rensei-Session-Id: my-atomic-session')
  })

  it('does NOT inject git-style X-Rensei-* trailers (native format only)', async () => {
    mockExecSequence([
      { success: true, stdout: '' },
      { success: true, stdout: 'sha\n' },
    ])

    await provider.attest!(makeWorkspace(), makeAttestation())

    const writeFileCall = vi.mocked(writeFile).mock.calls[0]
    const writtenContent = writeFileCall[1] as string
    // Atomic uses Rensei-* headers, not X-Rensei-* trailers
    expect(writtenContent).not.toContain('X-Rensei-')
    expect(writtenContent).toContain('Rensei-')
  })

  it('invokes atomic record --signed (native Ed25519, not empty git commit)', async () => {
    mockExecSequence([
      { success: true, stdout: '' },
      { success: true, stdout: 'sha\n' },
    ])

    await provider.attest!(makeWorkspace(), makeAttestation())

    // The first exec call should include 'atomic' and '--signed'
    const firstCall = mockExec.mock.calls[0][0] as string
    expect(firstCall).toContain('atomic')
    expect(firstCall).toContain('--signed')
  })
})

// ---------------------------------------------------------------------------
// parseAtomicPullOutput — unit tests (pure function, no binary needed)
// ---------------------------------------------------------------------------

describe('parseAtomicPullOutput', () => {
  it('returns { kind: "clean" } for "Already up to date"', () => {
    const result = parseAtomicPullOutput('Already up to date.\n')
    expect(result.kind).toBe('clean')
  })

  it('returns { kind: "clean" } for "Nothing to pull"', () => {
    const result = parseAtomicPullOutput('Nothing to pull.\n')
    expect(result.kind).toBe('clean')
  })

  it('returns { kind: "auto-resolved" } for auto-resolution output', () => {
    const result = parseAtomicPullOutput(
      'Applying 5 patches...\nAuto-resolved 3 patch(es)\nDone.\n',
    )
    expect(result.kind).toBe('auto-resolved')
  })

  it('auto-resolved result includes at least one resolution entry', () => {
    const result = parseAtomicPullOutput(
      'Auto-resolved 2 patch(es)\nAuto-resolved src/api.ts (patch-theory)\n',
    )
    if (result.kind === 'auto-resolved') {
      expect(result.resolutions.length).toBeGreaterThan(0)
    } else {
      throw new Error(`Expected auto-resolved, got ${result.kind}`)
    }
  })

  it('returns { kind: "conflict" } for conflict output', () => {
    const result = parseAtomicPullOutput(
      'Conflict in src/index.ts: unresolvable structural conflict\n',
    )
    expect(result.kind).toBe('conflict')
    if (result.kind === 'conflict') {
      expect(result.conflicts[0].filePath).toBe('src/index.ts')
    }
  })
})

// ---------------------------------------------------------------------------
// parseAutoResolutions — unit tests
// ---------------------------------------------------------------------------

describe('parseAutoResolutions', () => {
  it('parses per-file resolution entries', () => {
    const output = `
      Auto-resolved 2 patch(es)
      Auto-resolved src/foo.ts (patch-theory)
      Auto-resolved src/bar.ts (patch-theory)
    `
    const resolutions = parseAutoResolutions(output)
    expect(resolutions.length).toBe(2)
    expect(resolutions[0].filePath).toBe('src/foo.ts')
    expect(resolutions[0].strategy).toBe('patch-theory')
    expect(resolutions[1].filePath).toBe('src/bar.ts')
  })

  it('synthesizes a summary entry when no per-file lines are found', () => {
    const output = 'Auto-resolved 5 patch(es)\n'
    const resolutions = parseAutoResolutions(output)
    expect(resolutions.length).toBe(1)
    expect(resolutions[0].filePath).toContain('multiple files')
    expect(resolutions[0].strategy).toBe('patch-theory')
  })

  it('returns empty array when no auto-resolution markers', () => {
    const resolutions = parseAutoResolutions('Nothing to pull.\n')
    expect(resolutions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// parseAtomicConflicts — unit tests
// ---------------------------------------------------------------------------

describe('parseAtomicConflicts', () => {
  it('extracts file path from conflict output', () => {
    const conflicts = parseAtomicConflicts('Conflict in src/main.ts: type mismatch')
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].filePath).toBe('src/main.ts')
    expect(conflicts[0].detail).toBe('type mismatch')
  })

  it('extracts multiple conflict entries', () => {
    const output = `
      Conflict in src/a.ts: detail a
      Conflict in src/b.ts: detail b
    `
    const conflicts = parseAtomicConflicts(output)
    expect(conflicts.length).toBe(2)
  })

  it('returns a fallback entry when no conflict pattern matches', () => {
    const conflicts = parseAtomicConflicts('something went wrong')
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].filePath).toContain('unknown')
  })
})

// ---------------------------------------------------------------------------
// classifyAtomicPushError — unit tests
// ---------------------------------------------------------------------------

describe('classifyAtomicPushError', () => {
  it('classifies auth errors', () => {
    expect(classifyAtomicPushError('Permission denied (authentication)')).toBe('auth')
    expect(classifyAtomicPushError('Authentication failed')).toBe('auth')
  })

  it('classifies non-fast-forward errors (defensive — should not occur with patch-theory)', () => {
    expect(classifyAtomicPushError('Push rejected: non-fast-forward')).toBe('non-fast-forward')
  })

  it('classifies unknown errors as policy', () => {
    expect(classifyAtomicPushError('Push rejected by repository policy hook')).toBe('policy')
    expect(classifyAtomicPushError('Unknown remote error')).toBe('policy')
  })
})

// ---------------------------------------------------------------------------
// buildAtomicAttestationMessage — unit tests
// ---------------------------------------------------------------------------

describe('buildAtomicAttestationMessage', () => {
  it('includes session id as Rensei-Session-Id (native format)', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({ sessionId: 'sess-native-001' }))
    expect(msg).toContain('Rensei-Session-Id: sess-native-001')
  })

  it('includes agent id', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({ agentId: 'agent-atomic-1' }))
    expect(msg).toContain('Rensei-Agent-Id: agent-atomic-1')
  })

  it('includes model ref', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({
      modelRef: { provider: 'anthropic', model: 'claude-opus-4-7' },
    }))
    expect(msg).toContain('Rensei-Model: anthropic/claude-opus-4-7')
  })

  it('includes kit set when kitIds present', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({
      kitIds: [
        { id: 'spring/java', version: '1.0.0' },
        { id: 'docker-compose', version: '2.1.0' },
      ],
    }))
    expect(msg).toContain('Rensei-Kit-Set: spring/java@1.0.0,docker-compose@2.1.0')
  })

  it('omits kit set when kitIds is empty', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({ kitIds: [] }))
    expect(msg).not.toContain('Rensei-Kit-Set')
  })

  it('includes workarea snapshot ref when present', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({
      workareaSnapshotRef: { ref: 'snap-atomic-1', providerId: 'workarea-1' },
    }))
    expect(msg).toContain('Rensei-Workarea-Snapshot: snap-atomic-1')
  })

  it('includes signed-by when present', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({
      signedBy: 'did:key:z6MkTestIdentityForAtomicVCS',
    }))
    expect(msg).toContain('Rensei-Signed-By: did:key:z6MkTestIdentityForAtomicVCS')
  })

  it('does NOT contain X-Rensei-* git trailer format', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation())
    expect(msg).not.toContain('X-Rensei-')
  })

  it('starts with attestation header line', () => {
    const msg = buildAtomicAttestationMessage(makeAttestation({ sessionId: 'sess-xyz' }))
    expect(msg.startsWith('attestation: session sess-xyz')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests that require the actual atomic binary (skip if not installed)
// ---------------------------------------------------------------------------

describe.skipIf(!hasAtomic)('AtomicVCSProvider — integration (requires atomic CLI)', () => {
  // These tests run against a real local Atomic remote.
  // They are skipped unless `atomic` is installed and on PATH.

  it('activate() succeeds with real atomic CLI', async () => {
    // Restore real exec for this integration test block
    vi.restoreAllMocks()
    const provider = new AtomicVCSProvider()
    const host = { emit: vi.fn() }
    await expect(provider.activate(host)).resolves.toBeUndefined()
  })

  it('records the installed atomic CLI version (sanity check)', async () => {
    vi.restoreAllMocks()
    const { stdout } = await import('child_process').then(m =>
      new Promise<{ stdout: string }>((resolve, reject) => {
        m.exec('atomic --version', (err, stdout) => {
          if (err) reject(err)
          else resolve({ stdout })
        })
      })
    )
    expect(stdout).toMatch(/atomic\s+\d+\.\d+/)
  })
})
