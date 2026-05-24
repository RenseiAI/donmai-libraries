import { describe, it, expect } from 'vitest'
import {
  JiraIssueTrackerProvider,
  AsanaIssueTrackerProvider,
  NotionIssueTrackerProvider,
} from '../../issue-tracker/index.js'
import type { IssueTrackerProvider } from '../../issue-tracker/types.js'

/**
 * Stub adapter tests for Jira, Asana, and Notion IssueTrackerProvider skeletons.
 *
 * Verifies:
 * 1. Each stub satisfies the IssueTrackerProvider interface structurally.
 * 2. Each verb throws with a descriptive "not implemented / deferred" message.
 * 3. Capability flags are declared (not undefined).
 */

const STUB_CLASSES = [
  { name: 'JiraIssueTrackerProvider', Klass: JiraIssueTrackerProvider },
  { name: 'AsanaIssueTrackerProvider', Klass: AsanaIssueTrackerProvider },
  { name: 'NotionIssueTrackerProvider', Klass: NotionIssueTrackerProvider },
] as const

for (const { name, Klass } of STUB_CLASSES) {
  describe(name, () => {
    const provider = new Klass() as IssueTrackerProvider

    // ── Structural conformance ─────────────────────────────────────────────

    it('satisfies the IssueTrackerProvider interface at runtime', () => {
      expect(typeof provider.getIssue).toBe('function')
      expect(typeof provider.listIssues).toBe('function')
      expect(typeof provider.createIssue).toBe('function')
      expect(typeof provider.updateIssue).toBe('function')
      expect(typeof provider.listComments).toBe('function')
      expect(typeof provider.createComment).toBe('function')
      expect(typeof provider.addRelation).toBe('function')
      expect(provider.capabilities).toBeDefined()
    })

    // ── Capability flags are declared ──────────────────────────────────────

    it('declares all required capability fields', () => {
      const caps = provider.capabilities
      expect(typeof caps.supportsSubIssues).toBe('boolean')
      expect(typeof caps.supportsLabels).toBe('boolean')
      expect(typeof caps.supportsBlocking).toBe('boolean')
      expect(typeof caps.supportsCustomFields).toBe('boolean')
      expect(typeof caps.identityScheme).toBe('string')
      expect(typeof caps.webhookProtocol).toBe('string')
    })

    // ── Verbs throw ────────────────────────────────────────────────────────

    it('getIssue throws a not-implemented error referencing REN-1295', async () => {
      await expect(provider.getIssue('FAKE-1')).rejects.toThrow(/not implemented/i)
      await expect(provider.getIssue('FAKE-1')).rejects.toThrow(/deferred/i)
    })

    it('listIssues throws a not-implemented error', async () => {
      await expect(provider.listIssues({})).rejects.toThrow(/not implemented/i)
    })

    it('createIssue throws a not-implemented error', async () => {
      await expect(
        provider.createIssue({ title: 'test' } as import('../../issue-tracker/types.js').IssueTrackerCreateInput)
      ).rejects.toThrow(/not implemented/i)
    })

    it('updateIssue throws a not-implemented error', async () => {
      await expect(
        provider.updateIssue('FAKE-1', { title: 'updated' })
      ).rejects.toThrow(/not implemented/i)
    })

    it('listComments throws a not-implemented error', async () => {
      await expect(provider.listComments('FAKE-1')).rejects.toThrow(/not implemented/i)
    })

    it('createComment throws a not-implemented error', async () => {
      await expect(
        provider.createComment('FAKE-1', 'hello')
      ).rejects.toThrow(/not implemented/i)
    })

    it('addRelation throws a not-implemented error', async () => {
      await expect(
        provider.addRelation({
          issueId: 'FAKE-1',
          relatedIssueId: 'FAKE-2',
          type: 'blocks',
        })
      ).rejects.toThrow(/not implemented/i)
    })
  })
}

// ---------------------------------------------------------------------------
// Cross-stub capability snapshot
// ---------------------------------------------------------------------------

describe('IssueTrackerProvider stubs — capability snapshot', () => {
  it('Jira declares email identityScheme', () => {
    const p = new JiraIssueTrackerProvider()
    expect(p.capabilities.identityScheme).toBe('email')
    expect(p.capabilities.webhookProtocol).toBe('jira')
  })

  it('Asana declares supportsBlocking: false', () => {
    const p = new AsanaIssueTrackerProvider()
    expect(p.capabilities.supportsBlocking).toBe(false)
    expect(p.capabilities.webhookProtocol).toBe('asana')
  })

  it('Notion declares webhookProtocol: notion', () => {
    const p = new NotionIssueTrackerProvider()
    expect(p.capabilities.webhookProtocol).toBe('notion')
  })
})

// ---------------------------------------------------------------------------
// Export resolution — contract types re-exported from main barrel
// ---------------------------------------------------------------------------

describe('@donmai/core barrel exports', () => {
  it('exports JiraIssueTrackerProvider from main', async () => {
    const mod = await import('../../index.js')
    expect((mod as any).JiraIssueTrackerProvider).toBeDefined()
  })

  it('exports AsanaIssueTrackerProvider from main', async () => {
    const mod = await import('../../index.js')
    expect((mod as any).AsanaIssueTrackerProvider).toBeDefined()
  })

  it('exports NotionIssueTrackerProvider from main', async () => {
    const mod = await import('../../index.js')
    expect((mod as any).NotionIssueTrackerProvider).toBeDefined()
  })
})
