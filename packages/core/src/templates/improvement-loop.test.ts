/**
 * Improvement Loop Template Tests (REN-1299)
 *
 * Validates that the improvement-loop template:
 *   1. Loads correctly from the built-in defaults registry.
 *   2. Hard caps: at most 5 issues per cycle enforced in prompt.
 *   3. Citation requirement: each issue must cite at least 3 specific failure cases.
 *   4. Disallows `rensei linear create-issue --parentId *` (no sub-issues, Principle 1).
 *   5. Tagging scheme: meta:improvement + subsystem:<name> prefix.
 *   6. Cron-trigger: prompt contains WORK_RESULT marker for completion signaling.
 *   7. Pattern clustering: corpus of known-failing sessions maps to a meta-issue.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { TemplateRegistry } from './registry.js'
import { CodexToolPermissionAdapter, ClaudeToolPermissionAdapter } from './adapters.js'
import type { ToolPermission } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the raw disallow list for the improvement-loop template.
 */
function getDisallowList(registry: TemplateRegistry): ToolPermission[] {
  return registry.getDisallowedTools('improvement-loop') ?? []
}

/**
 * Render the improvement-loop prompt with the given identifier.
 */
function render(
  registry: TemplateRegistry,
  identifier: string,
  extras: Record<string, unknown> = {},
): string {
  const result = registry.renderPrompt('improvement-loop', {
    identifier,
    linearCli: 'rensei linear',
    packageManager: 'pnpm',
    ...extras,
  })
  expect(result, 'improvement-loop template must be registered').not.toBeNull()
  return result as string
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('improvement-loop (REN-1299)', () => {
  let registry: TemplateRegistry

  beforeEach(() => {
    registry = TemplateRegistry.create({ useBuiltinDefaults: true })
  })

  // -------------------------------------------------------------------------
  // AC1 – Template loads
  // -------------------------------------------------------------------------
  describe('template registration', () => {
    it('is registered in the built-in defaults registry', () => {
      expect(registry.hasTemplate('improvement-loop')).toBe(true)
    })

    it('has a non-empty prompt', () => {
      const template = registry.getTemplate('improvement-loop')
      expect(template?.prompt.trim().length).toBeGreaterThan(100)
    })

    it('uses sonnet-appropriate label in description (reasoning-heavy synthesis)', () => {
      const template = registry.getTemplate('improvement-loop')
      // Template description should mention meta-issues or systemic patterns
      expect(template?.metadata.description).toMatch(/meta.?issue|systemic/i)
    })
  })

  // -------------------------------------------------------------------------
  // AC2 – Hard cap: at most 5 issues per cycle
  // -------------------------------------------------------------------------
  describe('hard cap: at most 5 issues per cycle', () => {
    it('prompt instructs the model to author at most 5 issues', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/at most 5|≤\s*5|no more than 5/i)
    })

    it('prompt reinforces the 5-issue cap in multiple places', () => {
      const prompt = render(registry, 'REN-1299')
      // Should appear at least twice — once in HARD RULES, once elsewhere
      const matches = [...prompt.matchAll(/5\s*issues?\s*per\s*cycle|at most 5|stop after 5/gi)]
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })
  })

  // -------------------------------------------------------------------------
  // AC3 – Citation requirement: ≥3 specific failure cases per issue
  // -------------------------------------------------------------------------
  describe('citation requirement: at least 3 specific failure cases', () => {
    it('prompt requires at least 3 cited failure cases per issue', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/at least 3|≥\s*3|3 or more|3 specific/i)
    })

    it('prompt cites session IDs or PR URLs as acceptable citation forms', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/session.?id|issue.?id|PR.?URL|session\/issue/i)
    })

    it('prompt labels uncited patterns as speculation', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/speculation|without citations/i)
    })
  })

  // -------------------------------------------------------------------------
  // AC4 – No-sub-issue allowlist enforcement (Principle 1)
  // -------------------------------------------------------------------------
  describe('no-sub-issue allowlist enforcement (Principle 1)', () => {
    it('disallows rensei linear create-issue --parentId * in template disallow list', () => {
      const disallow = getDisallowList(registry)
      const hasParentIdBlock = disallow.some(
        (p) => typeof p !== 'string' && 'shell' in p && p.shell.includes('--parentId'),
      )
      expect(hasParentIdBlock, 'template must disallow create-issue --parentId').toBe(true)
    })

    it('Codex approval bridge rejects rensei linear create-issue --parentId REN-99', () => {
      const { allow, disallow } = registry.getRawToolPermissions('improvement-loop')
      const adapter = new CodexToolPermissionAdapter()
      const config = adapter.buildPermissionConfig(allow, disallow)

      const command = 'rensei linear create-issue --parentId REN-99 --title "Child meta-issue"'
      const denied = config.deniedCommandPatterns.some(({ pattern }) => pattern.test(command))
      expect(denied, `"${command}" must be rejected by the deny patterns`).toBe(true)
    })

    it('Codex approval bridge allows rensei linear create-issue without --parentId', () => {
      const { allow, disallow } = registry.getRawToolPermissions('improvement-loop')
      const adapter = new CodexToolPermissionAdapter()
      const config = adapter.buildPermissionConfig(allow, disallow)

      const command =
        'rensei linear create-issue --title "meta: prompt gap" --labels "meta:improvement,subsystem:qa-agent"'
      const denied = config.deniedCommandPatterns.some(({ pattern }) => pattern.test(command))
      expect(denied, 'create-issue without --parentId must NOT be denied').toBe(false)
    })

    it('prompt contains the hard rule against --parentId (NEVER / FORBIDDEN)', () => {
      const prompt = render(registry, 'REN-1299', { linearCli: 'rensei linear' })
      expect(prompt).toMatch(/NEVER|FORBIDDEN/i)
      expect(prompt).toContain('--parentId')
    })

    it('Claude adapter produces Bash deny format for --parentId pattern', () => {
      const disallow = getDisallowList(registry)
      const adapter = new ClaudeToolPermissionAdapter()
      const translated = adapter.translatePermissions(disallow)
      const hasDeny = translated.some((t) => t.includes('--parentId'))
      expect(hasDeny, 'Claude disallow translation must include --parentId entry').toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // AC5 – Tagging scheme: meta:improvement + subsystem:<name>
  // -------------------------------------------------------------------------
  describe('tagging scheme: meta:improvement + subsystem:<name>', () => {
    it('prompt instructs using meta:improvement label', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toContain('meta:improvement')
    })

    it('prompt instructs using subsystem:<name> prefix for affected subsystem', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/subsystem:<name>|subsystem:<affected.subsystem>/i)
    })

    it('prompt provides example subsystem tags', () => {
      const prompt = render(registry, 'REN-1299')
      // At least one concrete example like subsystem:backlog-writer or subsystem:qa-agent
      expect(prompt).toMatch(/subsystem:[a-z]/)
    })

    it('prompt shows both tags used together in create-issue command', () => {
      const prompt = render(registry, 'REN-1299')
      // The --labels flag must reference both tags together
      expect(prompt).toMatch(/--labels.*meta:improvement.*subsystem|meta:improvement,subsystem/i)
    })
  })

  // -------------------------------------------------------------------------
  // AC6 – Cron-trigger ready: WORK_RESULT marker
  // -------------------------------------------------------------------------
  describe('cron-trigger readiness: WORK_RESULT marker', () => {
    it('prompt references WORK_RESULT:passed', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toContain('WORK_RESULT:passed')
    })

    it('prompt references WORK_RESULT:failed', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toContain('WORK_RESULT:failed')
    })

    it('prompt covers "no patterns found" output path', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/no.*patterns? found|no systemic patterns/i)
    })
  })

  // -------------------------------------------------------------------------
  // AC7 – Tool allow list includes all required Linear commands
  // -------------------------------------------------------------------------
  describe('tool allow list', () => {
    it('includes rensei linear list-issues', () => {
      const { allow } = registry.getRawToolPermissions('improvement-loop')
      const hasListIssues = allow.some(
        (p) => typeof p !== 'string' && 'shell' in p && p.shell.includes('list-issues'),
      )
      expect(hasListIssues, 'list-issues must be in allow list').toBe(true)
    })

    it('includes rensei linear get-issue', () => {
      const { allow } = registry.getRawToolPermissions('improvement-loop')
      const hasGetIssue = allow.some(
        (p) => typeof p !== 'string' && 'shell' in p && p.shell.includes('get-issue'),
      )
      expect(hasGetIssue, 'get-issue must be in allow list').toBe(true)
    })

    it('includes rensei linear create-issue', () => {
      const { allow } = registry.getRawToolPermissions('improvement-loop')
      const hasCreateIssue = allow.some(
        (p) => typeof p !== 'string' && 'shell' in p && p.shell.includes('create-issue'),
      )
      expect(hasCreateIssue, 'create-issue must be in allow list').toBe(true)
    })

    it('includes rensei linear list-comments', () => {
      const { allow } = registry.getRawToolPermissions('improvement-loop')
      const hasListComments = allow.some(
        (p) => typeof p !== 'string' && 'shell' in p && p.shell.includes('list-comments'),
      )
      expect(hasListComments, 'list-comments must be in allow list').toBe(true)
    })

    it('does NOT include add-relation (improvement loop creates independent issues, no deps)', () => {
      const { allow } = registry.getRawToolPermissions('improvement-loop')
      const hasAddRelation = allow.some(
        (p) => typeof p !== 'string' && 'shell' in p && p.shell.includes('add-relation'),
      )
      // Meta-issues are independent per-cluster — no relations needed
      expect(hasAddRelation, 'add-relation should NOT be in allow list for improvement-loop').toBe(
        false,
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC8 – Pattern clustering: corpus of known-failing sessions
  //        The rendered prompt must give the agent clear instructions to
  //        cluster sessions and produce one issue per cluster of ≥3 cases.
  // -------------------------------------------------------------------------
  describe('pattern clustering: corpus of known-failing sessions', () => {
    /**
     * Simulate feeding a corpus context where 10 sessions share the same
     * failure mode — kit-linear missing a `search-issues` verb.
     *
     * The rendered prompt must instruct the agent to:
     *   - Group by failure mode
     *   - Only create issues for clusters of ≥3 cases
     *   - Cite the specific session IDs
     */
    const kitLinearCorpusContext = [
      'Corpus: 10 sessions where kit-linear was missing search-issues verb.',
      'Sessions: REN-0001, REN-0002, REN-0003, REN-0004, REN-0005,',
      'REN-0006, REN-0007, REN-0008, REN-0009, REN-0010.',
      'All sessions failed with: "no such command: search-issues".',
      'Expected subsystem: subsystem:kit-linear',
    ].join('\n')

    it('rendered prompt instructs clustering by failure mode before authoring issues', () => {
      const prompt = render(registry, 'REN-1299', { mentionContext: kitLinearCorpusContext })
      expect(prompt).toMatch(/cluster|group.*failure|failure.*group/i)
    })

    it('rendered prompt instructs ≥3 case threshold before authoring a meta-issue', () => {
      const prompt = render(registry, 'REN-1299', { mentionContext: kitLinearCorpusContext })
      expect(prompt).toMatch(/≥\s*3|at least 3|3 or more|3\+ cases/i)
    })

    it('rendered prompt includes mentionContext (corpus of failing sessions)', () => {
      const prompt = render(registry, 'REN-1299', { mentionContext: kitLinearCorpusContext })
      expect(prompt).toContain('kit-linear')
      expect(prompt).toContain('search-issues')
    })

    it('rendered prompt instructs citing specific issue/session IDs in the evidence section', () => {
      const prompt = render(registry, 'REN-1299', { mentionContext: kitLinearCorpusContext })
      // The prompt must require session/issue ID citations
      expect(prompt).toMatch(/session.?id|issue.?id|evidence/i)
    })

    it('rendered prompt instructs only one meta-issue per cluster (not one per session)', () => {
      const prompt = render(registry, 'REN-1299', { mentionContext: kitLinearCorpusContext })
      // The phrasing should make clear it's one issue per cluster/pattern, not per session
      expect(prompt).toMatch(/one meta.?issue|per cluster|for each cluster/i)
    })

    /**
     * Second corpus: 10 sessions where the qa-agent prompt produced
     * verbose-but-wrong output. This exercises the "prompt quality" pattern type.
     */
    const promptQualityCorpusContext = [
      'Corpus: 10 QA sessions producing verbose-but-wrong output.',
      'Sessions: QA-0001 through QA-0010.',
      'All sessions passed QA but had incorrect acceptance criteria evaluation.',
      'Pattern: prompt asks for thoroughness, produces lengthy but inaccurate analysis.',
    ].join('\n')

    it('rendered prompt covers prompt quality as a detectable pattern type', () => {
      const prompt = render(registry, 'REN-1299', { mentionContext: promptQualityCorpusContext })
      expect(prompt).toMatch(/prompt quality|low.quality output|verbose/i)
    })

    it('rendered prompt covers missing kit capabilities as a detectable pattern type', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/missing kit capabilities|kit.*capabilities|kit.*missing/i)
    })

    it('rendered prompt covers recurring failures as a detectable pattern type', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/recurring failures|repeatedly failing/i)
    })
  })

  // -------------------------------------------------------------------------
  // AC9 – Workflow coverage: steps are present and ordered
  // -------------------------------------------------------------------------
  describe('workflow steps', () => {
    it('prompt includes Step 1 — list recent sessions', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/step 1|list.*(recent|session)/i)
    })

    it('prompt includes step to read each issue', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/step 2|read each|for each.*issue/i)
    })

    it('prompt includes cluster step', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/step 3|cluster|group/i)
    })

    it('prompt includes issue-authoring step', () => {
      const prompt = render(registry, 'REN-1299')
      expect(prompt).toMatch(/step 4|author.*meta.?issue|create.*issue/i)
    })
  })
})
