/**
 * Backlog-Writer Template Tests (REN-1287)
 *
 * Validates that the backlog-creation template:
 *   1. Loads correctly from the built-in defaults registry.
 *   2. Explicitly disallows `rensei linear create-issue --parentId *` (no sub-issues).
 *   3. Contains haiku-executable scope discipline (≤100-line, 3-5 ACs, Fibonacci complexity).
 *   4. Migration: vague icebox input produces refined output or independent issues with blocks
 *      relations — never sub-issues.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { TemplateRegistry } from './registry.js'
import { CodexToolPermissionAdapter, ClaudeToolPermissionAdapter } from './adapters.js'
import type { ToolPermission } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the raw disallow list for the backlog-creation template.
 */
function getDisallowList(registry: TemplateRegistry): ToolPermission[] {
  return registry.getDisallowedTools('backlog-creation') ?? []
}

/**
 * Render the backlog-creation prompt with the given identifier.
 */
function render(registry: TemplateRegistry, identifier: string, extras: Record<string, unknown> = {}): string {
  const result = registry.renderPrompt('backlog-creation', {
    identifier,
    linearCli: 'rensei linear',
    packageManager: 'pnpm',
    ...extras,
  })
  expect(result, 'backlog-creation template must be registered').not.toBeNull()
  return result as string
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('backlog-writer (REN-1287)', () => {
  let registry: TemplateRegistry

  beforeEach(() => {
    registry = TemplateRegistry.create({ useBuiltinDefaults: true })
  })

  // -------------------------------------------------------------------------
  // AC1 – Template loads
  // -------------------------------------------------------------------------
  describe('template registration', () => {
    it('is registered in the built-in defaults registry', () => {
      expect(registry.hasTemplate('backlog-creation')).toBe(true)
    })

    it('has a non-empty prompt', () => {
      const template = registry.getTemplate('backlog-creation')
      expect(template?.prompt.trim().length).toBeGreaterThan(50)
    })
  })

  // -------------------------------------------------------------------------
  // AC2 – No-sub-issue allowlist enforcement
  // -------------------------------------------------------------------------
  describe('no-sub-issue allowlist enforcement (Principle 1)', () => {
    it('disallows rensei linear create-issue --parentId * in template disallow list', () => {
      const disallow = getDisallowList(registry)
      const hasParentIdBlock = disallow.some(
        p => typeof p !== 'string' && 'shell' in p && p.shell.includes('--parentId'),
      )
      expect(hasParentIdBlock, 'template must disallow create-issue --parentId').toBe(true)
    })

    it('Codex approval bridge rejects rensei linear create-issue --parentId SUP-99', () => {
      const { allow, disallow } = registry.getRawToolPermissions('backlog-creation')
      const adapter = new CodexToolPermissionAdapter()
      const config = adapter.buildPermissionConfig(allow, disallow)

      // Simulate what the Codex approval bridge does at runtime
      const command = 'rensei linear create-issue --parentId SUP-99 --title "Child issue"'
      const denied = config.deniedCommandPatterns.some(({ pattern }) => pattern.test(command))
      expect(denied, `"${command}" must be rejected by the deny patterns`).toBe(true)
    })

    it('Codex approval bridge rejects the minimal --parentId invocation', () => {
      const { allow, disallow } = registry.getRawToolPermissions('backlog-creation')
      const adapter = new CodexToolPermissionAdapter()
      const config = adapter.buildPermissionConfig(allow, disallow)

      const command = 'rensei linear create-issue --parentId abc123'
      const denied = config.deniedCommandPatterns.some(({ pattern }) => pattern.test(command))
      expect(denied).toBe(true)
    })

    it('Codex approval bridge allows rensei linear create-issue without --parentId', () => {
      const { allow, disallow } = registry.getRawToolPermissions('backlog-creation')
      const adapter = new CodexToolPermissionAdapter()
      const config = adapter.buildPermissionConfig(allow, disallow)

      // Independent issue creation (no --parentId) is permitted
      const command = 'rensei linear create-issue --title "New feature" --team Engineering'
      const denied = config.deniedCommandPatterns.some(({ pattern }) => pattern.test(command))
      expect(denied, 'create-issue without --parentId must NOT be denied').toBe(false)
    })

    it('Claude adapter produces Bash deny format for --parentId pattern', () => {
      const disallow = getDisallowList(registry)
      const adapter = new ClaudeToolPermissionAdapter()
      const translated = adapter.translatePermissions(disallow)
      // The Claude-format deny for the --parentId shell pattern
      const hasDeny = translated.some(t => t.includes('--parentId'))
      expect(hasDeny, 'Claude disallow translation must include --parentId entry').toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // AC3 – Haiku-executable scope discipline
  // -------------------------------------------------------------------------
  describe('haiku-executable scope discipline', () => {
    it('prompt instructs ≤ 100 lines of description', () => {
      const prompt = render(registry, 'REN-1287')
      expect(prompt).toMatch(/≤\s*100\s*lines/i)
    })

    it('prompt instructs 3–5 acceptance criteria', () => {
      const prompt = render(registry, 'REN-1287')
      // Matches "3-5 ACs", "3–5 ACs", "3–5 specific acceptance criteria", etc.
      expect(prompt).toMatch(/3.{1,3}5\s*(ACs?|acceptance criteria)/i)
    })

    it('prompt instructs Fibonacci complexity (1, 2, 3, 5, 8)', () => {
      const prompt = render(registry, 'REN-1287')
      // Matches "1, 2, 3, 5, or 8" or "1, 2, 3, 5, 8" or "1 2 3 5 8" etc.
      expect(prompt).toMatch(/1[,\s]+2[,\s]+3[,\s]+5[,\s\w]*8/)
    })

    it('prompt instructs explicit file paths in scope', () => {
      const prompt = render(registry, 'REN-1287')
      // Check that the prompt asks for file paths / symbols
      expect(prompt).toMatch(/file path|symbol|specific file/i)
    })

    it('prompt instructs blocks/blocked-by dependency relations', () => {
      const prompt = render(registry, 'REN-1287')
      expect(prompt).toContain('blocks')
      expect(prompt).toContain('add-relation')
    })

    it('prompt contains the hard rule against --parentId', () => {
      const prompt = render(registry, 'REN-1287', { linearCli: 'rensei linear' })
      expect(prompt).toMatch(/NEVER\s+create\s+Linear\s+sub.?issues/i)
      expect(prompt).toContain('--parentId')
    })

    it('prompt references WORK_RESULT marker', () => {
      const prompt = render(registry, 'REN-1287')
      expect(prompt).toContain('WORK_RESULT:passed')
      expect(prompt).toContain('WORK_RESULT:failed')
    })
  })

  // -------------------------------------------------------------------------
  // AC4 – Migration test: vague icebox → refined/independent + blocks, never sub-issues
  // -------------------------------------------------------------------------
  describe('migration: vague icebox issue handling', () => {
    /**
     * Simulates the agent receiving a vague icebox issue.
     * The rendered prompt must:
     *   - Describe the independent-issues shape (not sub-issues)
     *   - Mandate blocks/blocked-by for ordering
     *   - Forbid --parentId
     */
    const vagueMentionContext = [
      'Vague icebox issue: "Improve performance of the data pipeline".',
      'No acceptance criteria. No file paths. No complexity estimate.',
      'Please refine this into actionable backlog issues.',
    ].join('\n')

    it('rendered prompt describes independent-issues shape (not sub-issues)', () => {
      const prompt = render(registry, 'ICE-001', { mentionContext: vagueMentionContext })
      // The template must offer the independent-issues path
      expect(prompt).toMatch(/independent issue/i)
      // --parentId appears only in a FORBIDDEN/NEVER context, never as an instruction
      expect(prompt).toMatch(/NEVER|FORBIDDEN|blocked by template/i)
    })

    it('rendered prompt requires blocks relations between decomposed issues', () => {
      const prompt = render(registry, 'ICE-001', { mentionContext: vagueMentionContext })
      expect(prompt).toContain('blocks')
      expect(prompt).toContain('add-relation')
    })

    it('rendered prompt includes haiku-executable discipline for decomposed issues', () => {
      const prompt = render(registry, 'ICE-001', { mentionContext: vagueMentionContext })
      expect(prompt).toMatch(/≤\s*100\s*lines/i)
      expect(prompt).toMatch(/3.{1,3}5\s*(ACs?|acceptance criteria)/i)
      expect(prompt).toMatch(/1[,\s]+2[,\s]+3[,\s]+5[,\s\w]*8/)
    })

    it('rendered prompt does NOT instruct the agent to use --parentId (only forbids it)', () => {
      const prompt = render(registry, 'ICE-001', { mentionContext: vagueMentionContext })
      // Legacy text that actively invited sub-issue creation is gone.
      // The word "sub-issue" must appear only in NEVER/forbidden context.
      const subIssueMatches = [...prompt.matchAll(/sub.?issue/gi)]
      for (const match of subIssueMatches) {
        // Walk backwards up to 120 chars from the match to find a negation
        const before = prompt.slice(Math.max(0, match.index! - 120), match.index!)
        expect(before + match[0]).toMatch(/NEVER|FORBIDDEN|never|forbidden/i)
      }
    })

    it('rendered prompt contains the source issue identifier', () => {
      const prompt = render(registry, 'ICE-001', { mentionContext: vagueMentionContext })
      expect(prompt).toContain('ICE-001')
    })

    it('rendered prompt carries mentionContext (feedback from research/groomer)', () => {
      const prompt = render(registry, 'ICE-001', { mentionContext: vagueMentionContext })
      expect(prompt).toContain('Vague icebox issue')
      expect(prompt).toContain('Improve performance')
    })
  })

  // -------------------------------------------------------------------------
  // AC5 – In-flight session graceful migration
  // -------------------------------------------------------------------------
  describe('in-flight session graceful migration', () => {
    it('template is still registered under the backlog-creation work type (no rename)', () => {
      // Existing orchestrator sessions reference backlog-creation work type.
      // The rewrite must not rename the key.
      expect(registry.hasTemplate('backlog-creation')).toBe(true)
    })

    it('tool allow-list still includes rensei linear create-issue (minus --parentId)', () => {
      const { allow } = registry.getRawToolPermissions('backlog-creation')
      const hasCreateIssue = allow.some(
        p => typeof p !== 'string' && 'shell' in p && p.shell.includes('create-issue'),
      )
      expect(hasCreateIssue, 'create-issue must remain in allow list').toBe(true)
    })

    it('tool allow-list includes add-relation for dependency authoring', () => {
      const { allow } = registry.getRawToolPermissions('backlog-creation')
      const hasAddRelation = allow.some(
        p => typeof p !== 'string' && 'shell' in p && p.shell.includes('add-relation'),
      )
      expect(hasAddRelation, 'add-relation must be in allow list').toBe(true)
    })

    it('full registry still has 22 registered work types (17 base + 5 strategy templates)', () => {
      // REN-1298: backlog-groomer added (11 base + refinement-coordination + 5 strategy templates)
      // REN-1327: ga-readiness added (13 base + 5 strategy templates)
      // REN-1329: documentation-steward added (14 base + 5 strategy templates)
      // REN-1328: operational-scanner-vercel, -audit, -ci added (17 base + 5 strategy templates)
      const workTypes = registry.getRegisteredWorkTypes()
      expect(workTypes.length).toBe(22)
    })
  })
})
