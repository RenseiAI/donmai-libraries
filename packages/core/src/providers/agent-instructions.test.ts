import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildAutonomyPreamble,
  buildToolUsageGuidance,
  buildCodeEditingPhilosophy,
  buildGitWorkflow,
  buildLargeFileHandling,
  buildCodeIntelligenceMcpTools,
  buildCodeIntelligenceCli,
  buildLinearMcpTools,
  buildLinearCli,
  loadProjectInstructions,
  buildBaseInstructionsFromShared,
} from './agent-instructions.js'

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

// ---------------------------------------------------------------------------
// Core section builders
// ---------------------------------------------------------------------------

describe('buildAutonomyPreamble', () => {
  it('includes headless behavioral frame', () => {
    const result = buildAutonomyPreamble()
    expect(result).toContain('no human operator present')
    expect(result).toContain('no interactive input is possible')
  })

  it('forbids interactive behaviors', () => {
    const result = buildAutonomyPreamble()
    expect(result).toContain('NEVER ask clarifying questions')
    expect(result).toContain('NEVER use AskUserQuestion')
    expect(result).toContain('NEVER wait for confirmation')
    expect(result).toContain('NEVER say "let me know"')
  })

  it('requires completing all steps', () => {
    const result = buildAutonomyPreamble()
    expect(result).toContain('Complete ALL steps')
    expect(result).toContain('Do not exit early')
  })

  it('mentions blocker creation for genuine blocks', () => {
    const result = buildAutonomyPreamble()
    expect(result).toContain('blocker creation mechanism')
  })
})

describe('buildToolUsageGuidance', () => {
  it('recommends each dedicated tool over its Bash equivalent', () => {
    const result = buildToolUsageGuidance()
    expect(result).toContain('Use Read (not cat/head/tail via Bash)')
    expect(result).toContain('Use Edit (not sed/awk via Bash)')
    expect(result).toContain('Use Write (not echo/cat redirects via Bash)')
    expect(result).toContain('Use Glob (not find/ls via Bash)')
    expect(result).toContain('Use Grep (not grep/rg via Bash)')
  })

  it('includes parallel tool call guidance', () => {
    const result = buildToolUsageGuidance()
    expect(result).toContain('parallel')
  })
})

describe('buildCodeEditingPhilosophy', () => {
  it('includes read-before-edit principle', () => {
    const result = buildCodeEditingPhilosophy()
    expect(result).toContain('Read before editing')
  })

  it('includes minimal changes principle', () => {
    const result = buildCodeEditingPhilosophy()
    expect(result).toContain('minimal, targeted changes')
  })

  it('includes security awareness', () => {
    const result = buildCodeEditingPhilosophy()
    expect(result).toContain('security vulnerabilities')
  })
})

describe('buildGitWorkflow', () => {
  it('mandates descriptive commit messages', () => {
    const result = buildGitWorkflow()
    expect(result).toContain('descriptive messages')
  })

  it('requires new commits over amends', () => {
    const result = buildGitWorkflow()
    expect(result).toContain('new commits rather than amending')
  })

  it('blocks dangerous git operations', () => {
    const result = buildGitWorkflow()
    expect(result).toContain('--force-with-lease')
    expect(result).toContain('Never force-push to main/master')
    expect(result).toContain('git reset --hard')
    expect(result).toContain('git worktree remove')
  })
})

describe('buildLargeFileHandling', () => {
  it('includes token overflow strategies', () => {
    const result = buildLargeFileHandling()
    expect(result).toContain('exceeds maximum allowed tokens')
    expect(result).toContain('offset/limit')
    expect(result).toContain('auto-generated files')
  })
})

// ---------------------------------------------------------------------------
// Code intelligence sections
// ---------------------------------------------------------------------------

describe('buildCodeIntelligenceMcpTools', () => {
  it('lists all af_code_* tool names', () => {
    const result = buildCodeIntelligenceMcpTools(false)
    expect(result).toContain('af_code_get_repo_map')
    expect(result).toContain('af_code_search_symbols')
    expect(result).toContain('af_code_search_code')
    expect(result).toContain('af_code_check_duplicate')
    expect(result).toContain('af_code_find_type_usages')
    expect(result).toContain('af_code_validate_cross_deps')
    expect(result).toContain('af_code_reserve_files')
  })

  it('includes usage guidance', () => {
    const result = buildCodeIntelligenceMcpTools(false)
    expect(result).toContain('WHEN TO USE THESE TOOLS')
    expect(result).toContain('Fall back to Grep/Glob')
  })

  it('includes enforcement warning when enforced', () => {
    const result = buildCodeIntelligenceMcpTools(true)
    expect(result).toContain('Grep and Glob are temporarily blocked')
    expect(result).toContain('unlocked as a fallback')
  })

  it('omits enforcement warning when not enforced', () => {
    const result = buildCodeIntelligenceMcpTools(false)
    expect(result).not.toContain('temporarily blocked')
  })

  it('does not contain CLI commands', () => {
    const result = buildCodeIntelligenceMcpTools(false)
    expect(result).not.toContain('pnpm af-code')
  })
})

describe('buildCodeIntelligenceCli', () => {
  it('lists CLI commands with pnpm af-code prefix', () => {
    const result = buildCodeIntelligenceCli(false)
    expect(result).toContain('pnpm af-code get-repo-map')
    expect(result).toContain('pnpm af-code search-symbols')
    expect(result).toContain('pnpm af-code search-code')
    expect(result).toContain('pnpm af-code check-duplicate')
    expect(result).toContain('pnpm af-code find-type-usages')
    expect(result).toContain('pnpm af-code validate-cross-deps')
    expect(result).toContain('pnpm af-code reserve-files')
  })

  it('includes enforcement warning when enforced', () => {
    const result = buildCodeIntelligenceCli(true)
    expect(result).toContain('Grep and Glob are temporarily blocked')
  })

  it('omits enforcement warning when not enforced', () => {
    const result = buildCodeIntelligenceCli(false)
    expect(result).not.toContain('temporarily blocked')
  })

  it('does not contain MCP tool names', () => {
    const result = buildCodeIntelligenceCli(false)
    expect(result).not.toContain('af_code_get_repo_map')
  })
})

// ---------------------------------------------------------------------------
// Linear tool sections
// ---------------------------------------------------------------------------

describe('buildLinearMcpTools', () => {
  it('lists af_linear_* tool names', () => {
    const result = buildLinearMcpTools()
    expect(result).toContain('af_linear_get_issue')
    expect(result).toContain('af_linear_create_issue')
    expect(result).toContain('af_linear_create_blocker')
  })

  it('blocks claude.ai Linear MCP tools', () => {
    const result = buildLinearMcpTools()
    expect(result).toContain('Do NOT use mcp__claude_ai_Linear__')
  })

  it('includes human blocker instructions', () => {
    const result = buildLinearMcpTools()
    expect(result).toContain('HUMAN-NEEDED BLOCKERS')
    expect(result).toContain('af_linear_create_blocker')
  })
})

describe('buildLinearCli', () => {
  it('uses provided CLI path', () => {
    const result = buildLinearCli('npx af-linear')
    expect(result).toContain('npx af-linear')
  })

  it('includes blocker creation command', () => {
    const result = buildLinearCli('pnpm af-linear')
    expect(result).toContain('pnpm af-linear create-blocker')
  })

  it('blocks Linear MCP tools', () => {
    const result = buildLinearCli('pnpm af-linear')
    expect(result).toContain('Do NOT use Linear MCP tools')
    expect(result).toContain('Do NOT use ToolSearch')
  })

  it('includes file-based flag guidance', () => {
    const result = buildLinearCli('pnpm af-linear')
    expect(result).toContain('--description-file')
    expect(result).toContain('--body-file')
  })
})

// ---------------------------------------------------------------------------
// loadProjectInstructions
// ---------------------------------------------------------------------------

describe('loadProjectInstructions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns undefined when no files exist', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(loadProjectInstructions('/path')).toBeUndefined()
  })

  it('loads AGENTS.md with Project Instructions header', () => {
    mockedExistsSync.mockImplementation((p) => String(p).endsWith('AGENTS.md'))
    mockedReadFileSync.mockReturnValue('# Rules\nDo things.')
    const result = loadProjectInstructions('/path')
    expect(result).toContain('# Project Instructions (AGENTS.md)')
    expect(result).toContain('# Rules')
    expect(result).toContain('Do things.')
  })

  it('prefers AGENTS.md over CLAUDE.md when both exist', () => {
    mockedExistsSync.mockReturnValue(true)
    mockedReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('AGENTS.md')) return '# Agent Rules'
      return '# Claude Rules'
    })
    const result = loadProjectInstructions('/path')
    expect(result).toContain('AGENTS.md')
    expect(result).toContain('Agent Rules')
    expect(result).not.toContain('CLAUDE.md')
  })

  it('falls back to CLAUDE.md when AGENTS.md does not exist', () => {
    mockedExistsSync.mockImplementation((p) => String(p).endsWith('CLAUDE.md'))
    mockedReadFileSync.mockReturnValue('# Claude content')
    const result = loadProjectInstructions('/path')
    expect(result).toContain('Project Instructions (CLAUDE.md)')
    expect(result).toContain('Claude content')
  })

  it('skips empty files', () => {
    mockedExistsSync.mockReturnValue(true)
    mockedReadFileSync.mockReturnValue('   \n  ')
    expect(loadProjectInstructions('/path')).toBeUndefined()
  })

  it('handles read errors gracefully', () => {
    mockedExistsSync.mockReturnValue(true)
    mockedReadFileSync.mockImplementation(() => { throw new Error('EACCES') })
    expect(loadProjectInstructions('/path')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildBaseInstructionsFromShared (composite builder)
// ---------------------------------------------------------------------------

describe('buildBaseInstructionsFromShared', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('includes all core sections in correct order', () => {
    const result = buildBaseInstructionsFromShared('# Safety Rules', {})

    // All core sections present
    expect(result).toContain('no human operator present')
    expect(result).toContain('Use Read')
    expect(result).toContain('Read before editing')
    expect(result).toContain('# Safety Rules')
    expect(result).toContain('Git Workflow')
    expect(result).toContain('Large File Handling')

    // Order: preamble → tools → editing → safety → git → large files
    const preambleIdx = result.indexOf('no human operator present')
    const toolIdx = result.indexOf('Use Read')
    const editIdx = result.indexOf('Read before editing')
    const safetyIdx = result.indexOf('# Safety Rules')
    const gitIdx = result.indexOf('Git Workflow')
    const largeIdx = result.indexOf('Large File Handling')

    expect(preambleIdx).toBeLessThan(toolIdx)
    expect(toolIdx).toBeLessThan(editIdx)
    expect(editIdx).toBeLessThan(safetyIdx)
    expect(safetyIdx).toBeLessThan(gitIdx)
    expect(gitIdx).toBeLessThan(largeIdx)
  })

  it('includes code intelligence MCP tools when available with plugins', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      hasCodeIntelligence: true,
      useToolPlugins: true,
    })
    expect(result).toContain('af_code_get_repo_map')
    expect(result).not.toContain('pnpm af-code')
  })

  it('includes code intelligence CLI when available without plugins', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      hasCodeIntelligence: true,
      useToolPlugins: false,
    })
    expect(result).toContain('pnpm af-code get-repo-map')
    expect(result).not.toContain('af_code_get_repo_map')
  })

  it('includes code intelligence enforcement warning when enforced', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      hasCodeIntelligence: true,
      useToolPlugins: true,
      codeIntelEnforced: true,
    })
    expect(result).toContain('Grep and Glob are temporarily blocked')
  })

  it('omits code intelligence when not available', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      hasCodeIntelligence: false,
    })
    expect(result).not.toContain('af_code_')
    expect(result).not.toContain('pnpm af-code')
    expect(result).not.toContain('Code Intelligence')
  })

  it('includes Linear MCP tools when useToolPlugins is true', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      useToolPlugins: true,
    })
    expect(result).toContain('af_linear_get_issue')
    expect(result).not.toContain('pnpm af-linear')
  })

  it('includes Linear CLI when useToolPlugins is false', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      useToolPlugins: false,
      linearCli: 'pnpm af-linear',
    })
    expect(result).toContain('pnpm af-linear')
  })

  it('defaults linearCli to rensei linear', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      useToolPlugins: false,
    })
    expect(result).toContain('rensei linear')
  })

  it('appends systemPromptAppend content', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      systemPromptAppend: '# Custom Rules\nAlways run verify.',
    })
    expect(result).toContain('# Custom Rules')
    expect(result).toContain('Always run verify.')
  })

  it('trims whitespace-only systemPromptAppend', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {
      systemPromptAppend: '   \n  ',
    })
    // Should not inject an empty section
    expect(result).not.toContain('\n\n\n\n')
  })

  it('places systemPromptAppend after tool sections and before project instructions', () => {
    mockedExistsSync.mockImplementation((p) => String(p).endsWith('AGENTS.md'))
    mockedReadFileSync.mockReturnValue('# Project Content')

    const result = buildBaseInstructionsFromShared('# Safety', {
      worktreePath: '/fake',
      systemPromptAppend: '# Custom Append',
    })

    const customIdx = result.indexOf('# Custom Append')
    const projectIdx = result.indexOf('# Project Content')
    const safetyIdx = result.indexOf('# Safety')

    expect(customIdx).toBeGreaterThan(safetyIdx)
    expect(customIdx).toBeLessThan(projectIdx)
  })

  it('loads project instructions from worktreePath', () => {
    mockedExistsSync.mockImplementation((p) => String(p).endsWith('CLAUDE.md'))
    mockedReadFileSync.mockReturnValue('# My Project')

    const result = buildBaseInstructionsFromShared('# Safety', {
      worktreePath: '/fake',
    })
    expect(result).toContain('My Project')
    expect(result).toContain('Project Instructions (CLAUDE.md)')
  })

  it('omits project instructions when worktreePath has no instruction files', () => {
    mockedExistsSync.mockReturnValue(false)

    const result = buildBaseInstructionsFromShared('# Safety', {
      worktreePath: '/fake',
    })
    expect(result).not.toContain('Project Instructions')
  })

  it('returns string type', () => {
    const result = buildBaseInstructionsFromShared('# Safety', {})
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
