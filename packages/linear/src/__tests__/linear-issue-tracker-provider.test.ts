import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LinearIssueTrackerProvider } from '../linear-issue-tracker-provider.js'
import type { IssueTrackerProvider } from '@donmai/core'

/**
 * LinearIssueTrackerProvider — unit tests.
 *
 * Verifies:
 * 1. LinearIssueTrackerProvider structurally satisfies IssueTrackerProvider.
 * 2. Capability flags are declared as specified in REN-1295.
 * 3. Verb methods exist and are callable (mocked client to avoid Linear API calls).
 */

// ---------------------------------------------------------------------------
// Mock the Linear SDK client so no real HTTP calls are made
// ---------------------------------------------------------------------------

const mockIssue = {
  id: 'issue-uuid-1',
  identifier: 'REN-999',
  title: 'Test issue',
  description: 'A test issue',
  url: 'https://linear.app/test/issue/REN-999',
  priority: 2,
  state: Promise.resolve({ name: 'In Progress' }),
  team: Promise.resolve({ key: 'REN', name: 'Rensei' }),
  project: Promise.resolve({ name: 'Agent' }),
  labels: () => Promise.resolve({ nodes: [] }),
  parent: Promise.resolve(undefined),
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
}

const mockComment = {
  id: 'comment-uuid-1',
  body: 'Test comment',
  createdAt: new Date('2026-01-01'),
}

vi.mock('../agent-client.js', () => ({
  createLinearAgentClient: vi.fn(() => ({
    getIssue: vi.fn().mockResolvedValue(mockIssue),
    updateIssue: vi.fn().mockResolvedValue(mockIssue),
    getIssueComments: vi.fn().mockResolvedValue([mockComment]),
    createComment: vi.fn().mockResolvedValue(mockComment),
    createIssueRelation: vi.fn().mockResolvedValue({ success: true, relationId: 'rel-1' }),
    linearClient: {
      issues: vi.fn().mockResolvedValue({ nodes: [mockIssue] }),
      projects: vi.fn().mockResolvedValue({ nodes: [] }),
      createIssue: vi.fn().mockResolvedValue({
        success: true,
        issue: Promise.resolve(mockIssue),
      }),
    },
  })),
}))

vi.mock('../utils.js', () => ({
  resolveSDKLabelNames: vi.fn().mockResolvedValue([]),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearIssueTrackerProvider', () => {
  let provider: LinearIssueTrackerProvider

  beforeEach(() => {
    provider = new LinearIssueTrackerProvider({ apiKey: 'test-api-key' })
  })

  // ── Structural conformance ───────────────────────────────────────────────

  it('satisfies the IssueTrackerProvider interface (structural typing)', () => {
    // TypeScript enforces this at compile time; this runtime check verifies
    // all required methods exist at runtime too.
    const p: IssueTrackerProvider = provider
    expect(p).toBeDefined()
    expect(typeof p.getIssue).toBe('function')
    expect(typeof p.listIssues).toBe('function')
    expect(typeof p.createIssue).toBe('function')
    expect(typeof p.updateIssue).toBe('function')
    expect(typeof p.listComments).toBe('function')
    expect(typeof p.createComment).toBe('function')
    expect(typeof p.addRelation).toBe('function')
    expect(p.capabilities).toBeDefined()
  })

  // ── Capability flags ─────────────────────────────────────────────────────

  it('declares supportsSubIssues: true', () => {
    expect(provider.capabilities.supportsSubIssues).toBe(true)
  })

  it('declares supportsLabels: true', () => {
    expect(provider.capabilities.supportsLabels).toBe(true)
  })

  it('declares supportsBlocking: true', () => {
    expect(provider.capabilities.supportsBlocking).toBe(true)
  })

  it('declares supportsCustomFields: false', () => {
    expect(provider.capabilities.supportsCustomFields).toBe(false)
  })

  it('declares identityScheme: username', () => {
    expect(provider.capabilities.identityScheme).toBe('username')
  })

  it('declares webhookProtocol: linear', () => {
    expect(provider.capabilities.webhookProtocol).toBe('linear')
  })

  // ── Verb: getIssue ───────────────────────────────────────────────────────

  it('getIssue returns a TrackerIssue with expected shape', async () => {
    const issue = await provider.getIssue('REN-999')
    expect(issue.id).toBe('issue-uuid-1')
    expect(issue.identifier).toBe('REN-999')
    expect(issue.title).toBe('Test issue')
    expect(issue.url).toContain('linear.app')
    expect(Array.isArray(issue.labels)).toBe(true)
  })

  // ── Verb: listIssues ─────────────────────────────────────────────────────

  it('listIssues returns an array of TrackerIssue', async () => {
    const issues = await provider.listIssues({ project: 'Agent', maxResults: 10 })
    expect(Array.isArray(issues)).toBe(true)
    expect(issues.length).toBeGreaterThanOrEqual(1)
    const first = issues[0]
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('identifier')
    expect(first).toHaveProperty('title')
    expect(first).toHaveProperty('labels')
  })

  // ── Verb: createIssue ────────────────────────────────────────────────────

  it('createIssue returns a TrackerIssue', async () => {
    const issue = await provider.createIssue({
      title: 'New issue',
      teamId: 'team-uuid',
    })
    expect(issue.id).toBe('issue-uuid-1')
    expect(issue.title).toBe('Test issue')
  })

  // ── Verb: updateIssue ────────────────────────────────────────────────────

  it('updateIssue returns a TrackerIssue', async () => {
    const issue = await provider.updateIssue('REN-999', { title: 'Updated title' })
    expect(issue.id).toBe('issue-uuid-1')
  })

  // ── Verb: listComments ───────────────────────────────────────────────────

  it('listComments returns an array of TrackerComment', async () => {
    const comments = await provider.listComments('REN-999')
    expect(Array.isArray(comments)).toBe(true)
    expect(comments[0]).toHaveProperty('id')
    expect(comments[0]).toHaveProperty('body')
    expect(comments[0]).toHaveProperty('createdAt')
  })

  // ── Verb: createComment ──────────────────────────────────────────────────

  it('createComment returns a TrackerComment', async () => {
    const comment = await provider.createComment('REN-999', 'Hello world')
    expect(comment.id).toBe('comment-uuid-1')
    expect(comment.body).toBe('Test comment')
  })

  // ── Verb: addRelation ────────────────────────────────────────────────────

  it('addRelation returns an AddRelationResult with success=true', async () => {
    const result = await provider.addRelation({
      issueId: 'issue-uuid-1',
      relatedIssueId: 'issue-uuid-2',
      type: 'blocks',
    })
    expect(result.success).toBe(true)
    expect(result.relationId).toBe('rel-1')
  })

  // ── Export from package index ────────────────────────────────────────────

  it('is exported from @donmai/plugin-linear barrel', async () => {
    const mod = await import('../index.js')
    expect(mod.LinearIssueTrackerProvider).toBeDefined()
    expect(typeof mod.LinearIssueTrackerProvider).toBe('function')
  })
})
