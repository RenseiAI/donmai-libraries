import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripMentionTriggers } from '../webhook/handlers/session-prompted.js'

// Mock dependencies before importing the handler
vi.mock('@donmai/server', () => ({
  getSessionState: vi.fn(),
  updateSessionStatus: vi.fn(),
  storeSessionState: vi.fn(),
  releaseClaim: vi.fn(),
  removeWorkerSession: vi.fn(),
  dispatchWork: vi.fn().mockResolvedValue({ dispatched: true, parked: false }),
  publishUrgent: vi.fn(),
  generateIdempotencyKey: vi.fn().mockReturnValue('idem-key-1'),
  isWebhookProcessed: vi.fn().mockResolvedValue(false),
  createLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

import { getSessionState, dispatchWork } from '@donmai/server'
import { handleSessionPrompted } from '../webhook/handlers/session-prompted.js'

const mockGetSessionState = vi.mocked(getSessionState)
const mockDispatchWork = vi.mocked(dispatchWork)

function createMockConfig(overrides?: Partial<any>) {
  return {
    linearClient: {
      getClient: vi.fn().mockResolvedValue({
        getIssue: vi.fn().mockResolvedValue({
          state: Promise.resolve({ name: 'Finished' }),
        }),
        isParentIssue: vi.fn().mockResolvedValue(false),
        emitActivity: vi.fn(),
      }),
    },
    generatePrompt: vi.fn().mockReturnValue('Generated QA prompt for TEST-1'),
    ...overrides,
  } as any
}

function createPayload(overrides?: Partial<any>) {
  return {
    type: 'AgentSessionEvent',
    action: 'prompted',
    organizationId: 'org-1',
    createdAt: '2026-04-20T14:12:35.000Z',
    data: {},
    ...overrides,
  } as any
}

function createRawPayload(overrides?: Partial<any>) {
  return {
    agentSession: {
      id: 'session-1',
      issueId: 'issue-uuid-1',
      issue: { id: 'issue-uuid-1', identifier: 'TEST-1' },
    },
    promptContext: '',
    webhookId: 'wh-1',
    user: { id: 'user-1', name: 'Mark' },
    comment: { body: '@rensei' },
    ...overrides,
  }
}

function createMockLog() {
  const child = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }
  child.child = vi.fn().mockReturnValue(child)
  return child as any
}

// ============================================================================
// stripMentionTriggers unit tests
// ============================================================================

describe('stripMentionTriggers', () => {
  it('strips bare @mention leaving empty string', () => {
    expect(stripMentionTriggers('@rensei')).toBe('')
  })

  it('strips @mention with surrounding whitespace', () => {
    expect(stripMentionTriggers('  @rensei  ')).toBe('')
  })

  it('strips multiple @mentions', () => {
    expect(stripMentionTriggers('@rensei @agent')).toBe('')
  })

  it('preserves actual instructions after @mention', () => {
    expect(stripMentionTriggers('@rensei fix the login bug')).toBe('fix the login bug')
  })

  it('preserves instructions before @mention', () => {
    expect(stripMentionTriggers('please run QA @rensei')).toBe('please run QA')
  })

  it('preserves instructions with @mention in the middle', () => {
    expect(stripMentionTriggers('hey @rensei run tests please')).toBe('hey  run tests please')
  })

  it('handles empty string', () => {
    expect(stripMentionTriggers('')).toBe('')
  })

  it('handles text with no @mention', () => {
    expect(stripMentionTriggers('just some instructions')).toBe('just some instructions')
  })
})

// ============================================================================
// handleSessionPrompted integration tests
// ============================================================================

describe('handleSessionPrompted — bare mention handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bare @mention generates proper work prompt instead of using "@rensei" as prompt', async () => {
    const config = createMockConfig()
    const log = createMockLog()

    mockGetSessionState.mockResolvedValue({
      issueId: 'issue-uuid-1',
      issueIdentifier: 'TEST-1',
      status: 'completed',
      workType: 'development',
      providerSessionId: null,
      worktreePath: '',
      queuedAt: Date.now() - 60000,
    } as any)

    await handleSessionPrompted(
      config,
      createPayload(),
      createRawPayload({ comment: { body: '@rensei' }, promptContext: '' }),
      log
    )

    // Should call generatePrompt with the correct work type
    expect(config.generatePrompt).toHaveBeenCalled()
    const [identifier, workType] = config.generatePrompt.mock.calls[0]
    expect(identifier).toBe('TEST-1')
    // Work type should be derived from current status (Finished → qa), not stale session (development)
    expect(workType).toBe('qa')
  })

  it('bare @mention on parent issue uses qa work type (coordinator behavior decided at runtime)', async () => {
    const mockLinearClient = {
      getIssue: vi.fn().mockResolvedValue({
        state: Promise.resolve({ name: 'Finished' }),
      }),
      isParentIssue: vi.fn().mockResolvedValue(true),
      emitActivity: vi.fn(),
    }
    const config = createMockConfig({
      linearClient: { getClient: vi.fn().mockResolvedValue(mockLinearClient) },
    })
    const log = createMockLog()

    mockGetSessionState.mockResolvedValue({
      issueId: 'issue-uuid-1',
      issueIdentifier: 'TEST-1',
      status: 'completed',
      workType: 'development',
      providerSessionId: null,
      worktreePath: '',
      queuedAt: Date.now() - 60000,
    } as any)

    await handleSessionPrompted(
      config,
      createPayload(),
      createRawPayload({ comment: { body: '@rensei' }, promptContext: '' }),
      log
    )

    // After REN-1286: parent issues use 'qa' work type, coordinator behavior is runtime-decided
    expect(config.generatePrompt).toHaveBeenCalledWith('TEST-1', 'qa')
  })

  it('@mention with actual instructions uses stripped instructions as prompt', async () => {
    const config = createMockConfig()
    const log = createMockLog()

    mockGetSessionState.mockResolvedValue({
      issueId: 'issue-uuid-1',
      issueIdentifier: 'TEST-1',
      status: 'running',
      workType: 'development',
      agentId: 'agent-1',
      providerSessionId: null,
      worktreePath: '',
      queuedAt: Date.now() - 60000,
    } as any)

    await handleSessionPrompted(
      config,
      createPayload(),
      createRawPayload({ comment: { body: '@rensei fix the login bug' }, promptContext: '' }),
      log
    )

    // Should NOT call generatePrompt — user provided actual instructions
    expect(config.generatePrompt).not.toHaveBeenCalled()
  })

  it('promptContext takes precedence over comment body', async () => {
    const config = createMockConfig()
    const log = createMockLog()

    mockGetSessionState.mockResolvedValue({
      issueId: 'issue-uuid-1',
      issueIdentifier: 'TEST-1',
      status: 'running',
      workType: 'development',
      agentId: 'agent-1',
      providerSessionId: null,
      worktreePath: '',
      queuedAt: Date.now() - 60000,
    } as any)

    await handleSessionPrompted(
      config,
      createPayload(),
      createRawPayload({
        comment: { body: '@rensei' },
        promptContext: 'Please validate the implementation',
      }),
      log
    )

    // promptContext is used directly, not generatePrompt
    expect(config.generatePrompt).not.toHaveBeenCalled()
  })

  it('bare mention with no existing session skips', async () => {
    const config = createMockConfig()
    const log = createMockLog()

    mockGetSessionState.mockResolvedValue(null)

    const result = await handleSessionPrompted(
      config,
      createPayload(),
      createRawPayload({ comment: { body: '@rensei' }, promptContext: '' }),
      log
    )

    // With no session and no prompt, should generate from status
    // (falls through to generatePrompt even without a session)
    expect(config.generatePrompt).toHaveBeenCalled()
  })

  it('dispatches work with derived work type for non-running session', async () => {
    const mockLinearClient = {
      getIssue: vi.fn().mockResolvedValue({
        state: Promise.resolve({ name: 'Backlog' }),
      }),
      isParentIssue: vi.fn().mockResolvedValue(false),
      emitActivity: vi.fn(),
    }
    const config = createMockConfig({
      linearClient: { getClient: vi.fn().mockResolvedValue(mockLinearClient) },
      generatePrompt: vi.fn().mockReturnValue('Start work on TEST-1. Implement the feature/fix as specified.'),
    })
    const log = createMockLog()

    mockGetSessionState.mockResolvedValue({
      issueId: 'issue-uuid-1',
      issueIdentifier: 'TEST-1',
      status: 'completed',
      workType: 'qa', // stale work type from previous session
      providerSessionId: null,
      worktreePath: '',
      queuedAt: Date.now() - 60000,
    } as any)

    await handleSessionPrompted(
      config,
      createPayload(),
      createRawPayload({ comment: { body: '@rensei' }, promptContext: '' }),
      log
    )

    // generatePrompt should be called with 'development' (from Backlog status), not 'qa'
    expect(config.generatePrompt).toHaveBeenCalledWith('TEST-1', 'development')

    // The dispatched work prompt should be the generated prompt
    expect(mockDispatchWork).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Start work on TEST-1. Implement the feature/fix as specified.',
      })
    )
  })
})
