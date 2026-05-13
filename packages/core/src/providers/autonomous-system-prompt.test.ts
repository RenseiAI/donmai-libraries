import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildAutonomousSystemPrompt,
  loadProjectInstructions,
  type AutonomousSystemPromptOptions,
} from './autonomous-system-prompt.js'

// Mock fs for project instruction loading tests
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  }
})

import { existsSync, readFileSync } from 'fs'

const mockedExistsSync = vi.mocked(existsSync)
const mockedReadFileSync = vi.mocked(readFileSync)

const BASE_OPTIONS: AutonomousSystemPromptOptions = {
  hasCodeIntelligence: false,
}

describe('buildAutonomousSystemPrompt', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ------------------------------------------------------------------
  // 1. Autonomy preamble
  // ------------------------------------------------------------------
  describe('autonomy preamble', () => {
    it('includes headless behavioral frame', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(result).toContain('no human operator present')
      expect(result).toContain('no interactive input is possible')
    })

    it('forbids interactive behavior', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(result).toContain('NEVER ask clarifying questions')
      expect(result).toContain('NEVER use AskUserQuestion')
      expect(result).toContain('NEVER wait for confirmation')
    })

    it('requires completing all steps', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(result).toContain('Complete ALL steps')
      expect(result).toContain('Do not exit early')
    })
  })

  // ------------------------------------------------------------------
  // 2. Tool usage guidance
  // ------------------------------------------------------------------
  describe('tool usage guidance', () => {
    it('includes dedicated tool preferences', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(result).toContain('Use Read')
      expect(result).toContain('Use Edit')
      expect(result).toContain('Use Write')
      expect(result).toContain('Use Glob')
      expect(result).toContain('Use Grep')
    })

    it('discourages Bash equivalents', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(result).toContain('not cat/head/tail via Bash')
      expect(result).toContain('not sed/awk via Bash')
      expect(result).toContain('not grep/rg via Bash')
    })
  })

  // ------------------------------------------------------------------
  // 3. Safety rules
  // ------------------------------------------------------------------
  describe('safety rules', () => {
    it('includes safety instructions from buildSafetyInstructions', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(result).toContain('NEVER run: rm -rf /')
      expect(result).toContain('NEVER run: git worktree remove')
      expect(result).toContain('NEVER run: git reset --hard')
    })
  })

  // ------------------------------------------------------------------
  // 4. Code intelligence — absent when not available
  // ------------------------------------------------------------------
  describe('code intelligence: absent', () => {
    it('omits code intelligence when hasCodeIntelligence is false', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: false,
      })
      expect(result).not.toContain('af_code_')
      expect(result).not.toContain('pnpm af-code')
      expect(result).not.toContain('Code Intelligence')
    })
  })

  // ------------------------------------------------------------------
  // 5. Code intelligence — MCP tools
  // ------------------------------------------------------------------
  describe('code intelligence: MCP tools', () => {
    it('includes af_code_* tool descriptions when useToolPlugins is true', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: true,
      })
      expect(result).toContain('af_code_get_repo_map')
      expect(result).toContain('af_code_search_symbols')
      expect(result).toContain('af_code_search_code')
      expect(result).toContain('af_code_check_duplicate')
      expect(result).toContain('af_code_find_type_usages')
      expect(result).toContain('af_code_validate_cross_deps')
      expect(result).toContain('af_code_reserve_files')
    })

    it('does not include CLI commands when using MCP tools', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: true,
      })
      expect(result).not.toContain('pnpm af-code')
    })
  })

  // ------------------------------------------------------------------
  // 6. Code intelligence — CLI fallback
  // ------------------------------------------------------------------
  describe('code intelligence: CLI', () => {
    it('includes CLI commands when useToolPlugins is false', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: false,
      })
      expect(result).toContain('pnpm af-code get-repo-map')
      expect(result).toContain('pnpm af-code search-symbols')
      expect(result).toContain('pnpm af-code search-code')
      expect(result).toContain('pnpm af-code check-duplicate')
      expect(result).toContain('pnpm af-code find-type-usages')
      expect(result).toContain('pnpm af-code validate-cross-deps')
      expect(result).toContain('pnpm af-code reserve-files')
    })

    it('does not include MCP tool names when using CLI', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: false,
      })
      expect(result).not.toContain('af_code_get_repo_map')
    })
  })

  // ------------------------------------------------------------------
  // 7. Code intelligence enforcement warning
  // ------------------------------------------------------------------
  describe('code intelligence enforcement', () => {
    it('includes enforcement warning when codeIntelEnforced is true (MCP)', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: true,
        codeIntelEnforced: true,
      })
      expect(result).toContain('Grep and Glob are temporarily blocked')
    })

    it('includes enforcement warning when codeIntelEnforced is true (CLI)', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: false,
        codeIntelEnforced: true,
      })
      expect(result).toContain('Grep and Glob are temporarily blocked')
    })

    it('omits enforcement warning when codeIntelEnforced is false', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: true,
        codeIntelEnforced: false,
      })
      expect(result).not.toContain('Grep and Glob are temporarily blocked')
    })
  })

  // ------------------------------------------------------------------
  // 8. Linear — MCP tools
  // ------------------------------------------------------------------
  describe('linear tools: MCP', () => {
    it('includes af_linear_* tool list when useToolPlugins is true', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        useToolPlugins: true,
      })
      expect(result).toContain('af_linear_get_issue')
      expect(result).toContain('af_linear_create_issue')
      expect(result).toContain('af_linear_create_blocker')
      expect(result).toContain('Do NOT use mcp__claude_ai_Linear__')
    })
  })

  // ------------------------------------------------------------------
  // 9. Linear — CLI
  // ------------------------------------------------------------------
  describe('linear tools: CLI', () => {
    it('includes CLI command reference with custom linearCli', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        useToolPlugins: false,
        linearCli: 'npx af-linear',
      })
      expect(result).toContain('npx af-linear')
      expect(result).toContain('create-blocker')
    })

    it('defaults linearCli to rensei linear', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        useToolPlugins: false,
      })
      expect(result).toContain('rensei linear')
    })
  })

  // ------------------------------------------------------------------
  // systemPromptAppend
  // ------------------------------------------------------------------
  describe('systemPromptAppend', () => {
    it('includes appended content in output', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        systemPromptAppend: '# Custom Project Rules\nAlways run pnpm verify.',
      })
      expect(result).toContain('# Custom Project Rules')
      expect(result).toContain('Always run pnpm verify.')
    })

    it('places append after tool sections and before project instructions', () => {
      mockedExistsSync.mockImplementation((p) => String(p).endsWith('AGENTS.md'))
      mockedReadFileSync.mockReturnValue('# Project Docs')

      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        worktreePath: '/fake/worktree',
        systemPromptAppend: '# Custom Append',
      })

      const appendIdx = result.indexOf('# Custom Append')
      const projectIdx = result.indexOf('# Project Docs')
      const preambleIdx = result.indexOf('autonomous')

      expect(appendIdx).toBeGreaterThan(preambleIdx)
      expect(appendIdx).toBeLessThan(projectIdx)
    })

    it('ignores empty/whitespace-only append', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        systemPromptAppend: '   \n  ',
      })
      // Should not have extra blank sections
      expect(result).not.toContain('   \n  ')
    })
  })

  // ------------------------------------------------------------------
  // 10-11. AGENTS.md / CLAUDE.md loading
  // ------------------------------------------------------------------
  describe('project instructions', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('loads AGENTS.md from worktreePath', () => {
      mockedExistsSync.mockImplementation((p) =>
        String(p).endsWith('AGENTS.md'),
      )
      mockedReadFileSync.mockReturnValue('# Custom Agent Rules\nDo things.')

      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        worktreePath: '/fake/worktree',
      })

      expect(result).toContain('# Custom Agent Rules')
      expect(result).toContain('Project Instructions (AGENTS.md)')
    })

    it('prefers AGENTS.md over CLAUDE.md', () => {
      mockedExistsSync.mockReturnValue(true)
      mockedReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('AGENTS.md')) return '# AGENTS content'
        if (String(p).endsWith('CLAUDE.md')) return '# CLAUDE content'
        return ''
      })

      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        worktreePath: '/fake/worktree',
      })

      expect(result).toContain('AGENTS content')
      expect(result).not.toContain('CLAUDE content')
    })

    it('falls back to CLAUDE.md when AGENTS.md is absent', () => {
      mockedExistsSync.mockImplementation((p) =>
        String(p).endsWith('CLAUDE.md'),
      )
      mockedReadFileSync.mockReturnValue('# Claude Rules')

      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        worktreePath: '/fake/worktree',
      })

      expect(result).toContain('Claude Rules')
      expect(result).toContain('Project Instructions (CLAUDE.md)')
    })

    it('omits project instructions when neither file exists', () => {
      mockedExistsSync.mockReturnValue(false)

      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        worktreePath: '/fake/worktree',
      })

      expect(result).not.toContain('Project Instructions')
    })
  })

  // ------------------------------------------------------------------
  // 12. No interactive language
  // ------------------------------------------------------------------
  describe('no interactive language', () => {
    it('does not contain interactive phrases', () => {
      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        hasCodeIntelligence: true,
        useToolPlugins: true,
      })

      // These phrases should never appear as actual instructions to the agent
      // (the preamble quotes some of them in a "NEVER say" context, which is fine)
      const interactivePhrases = [
        'auto-memory',
        'skill system',
        '/help',
      ]

      for (const phrase of interactivePhrases) {
        expect(result.toLowerCase()).not.toContain(phrase.toLowerCase())
      }

      // The preamble should FORBID interactive phrases, not use them
      expect(result).toContain('NEVER say "let me know"')
      expect(result).toContain('NEVER ask clarifying questions')
    })
  })

  // ------------------------------------------------------------------
  // 13-14. Output format
  // ------------------------------------------------------------------
  describe('output format', () => {
    it('returns a string', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })

    it('does not include project instructions when no worktreePath', () => {
      const result = buildAutonomousSystemPrompt(BASE_OPTIONS)
      expect(result).not.toContain('Project Instructions')
    })

    it('includes project instructions when worktreePath has AGENTS.md', () => {
      mockedExistsSync.mockImplementation((p) =>
        String(p).endsWith('AGENTS.md'),
      )
      mockedReadFileSync.mockReturnValue('# Project rules')

      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        worktreePath: '/fake/worktree',
      })

      expect(result).toContain('autonomous') // static section
      expect(result).toContain('Project rules') // dynamic section
    })

    it('contains both static and dynamic content in correct order', () => {
      mockedExistsSync.mockImplementation((p) =>
        String(p).endsWith('CLAUDE.md'),
      )
      mockedReadFileSync.mockReturnValue('# My Project')

      const result = buildAutonomousSystemPrompt({
        ...BASE_OPTIONS,
        worktreePath: '/fake/worktree',
        hasCodeIntelligence: true,
        useToolPlugins: true,
      })

      // Core sections present
      expect(result).toContain('NEVER ask clarifying questions')
      expect(result).toContain('Use Read')
      expect(result).toContain('af_code_get_repo_map')

      // Project instructions at the end
      expect(result).toContain('My Project')
      const projectIndex = result.indexOf('My Project')
      const preambleIndex = result.indexOf('NEVER ask clarifying questions')
      expect(projectIndex).toBeGreaterThan(preambleIndex)
    })
  })
})

// ------------------------------------------------------------------
// loadProjectInstructions (exported for reuse)
// ------------------------------------------------------------------
describe('loadProjectInstructions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns undefined when no files exist', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(loadProjectInstructions('/some/path')).toBeUndefined()
  })

  it('skips empty files', () => {
    mockedExistsSync.mockReturnValue(true)
    mockedReadFileSync.mockReturnValue('   \n  ')
    expect(loadProjectInstructions('/some/path')).toBeUndefined()
  })

  it('handles read errors gracefully', () => {
    mockedExistsSync.mockReturnValue(true)
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(loadProjectInstructions('/some/path')).toBeUndefined()
  })
})
