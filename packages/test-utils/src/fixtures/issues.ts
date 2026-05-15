export function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-uuid-1',
    identifier: 'SUP-123',
    title: 'Test Issue',
    description: 'Test description',
    priority: 2,
    state: { id: 'state-1', name: 'In Progress' },
    team: { id: 'team-1', name: 'Engineering' },
    project: { id: 'project-1', name: 'Agent' },
    labels: { nodes: [] },
    ...overrides,
  }
}

export function makeQueuedWork(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: Date.now(),
    prompt: 'test prompt',
    workType: 'development',
    ...overrides,
  }
}

export function makeSessionState(overrides: Record<string, unknown> = {}) {
  return {
    trackerSessionId: 'session-1',
    trackerProvider: 'linear',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-123',
    providerSessionId: null,
    worktreePath: '/tmp/worktree',
    status: 'pending' as const,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

export function makeWorktreeState(overrides: Record<string, unknown> = {}) {
  return {
    issueId: 'issue-1',
    issueIdentifier: 'SUP-123',
    linearSessionId: 'session-1',
    providerSessionId: null,
    workType: 'development' as const,
    prompt: 'test prompt',
    startedAt: Date.now(),
    status: 'running' as const,
    currentPhase: null,
    lastUpdatedAt: Date.now(),
    recoveryAttempts: 0,
    workerId: null,
    pid: 12345,
    ...overrides,
  }
}

export function makeHeartbeatState(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: Date.now(),
    pid: 12345,
    memoryUsageMB: 100,
    uptime: 60,
    lastActivityType: 'thinking' as const,
    lastActivityTimestamp: Date.now(),
    toolCallsCount: 5,
    currentOperation: null,
    ...overrides,
  }
}
