import { describe, it, expect } from 'vitest'
import { createAutonomousCanUseTool, type CodeIntelEnforcementConfig } from './claude-provider.js'

// Helper to call the CanUseTool with minimal args
async function callTool(
  canUseTool: Awaited<ReturnType<typeof createAutonomousCanUseTool>>,
  toolName: string,
  input: Record<string, unknown> = {},
) {
  return canUseTool(toolName, input, undefined as never)
}

// ---------------------------------------------------------------------------
// No enforcement (default behavior)
// ---------------------------------------------------------------------------

describe('createAutonomousCanUseTool — no enforcement', () => {
  const canUseTool = createAutonomousCanUseTool()

  it('allows Grep', async () => {
    const result = await callTool(canUseTool, 'Grep', { pattern: 'foo' })
    expect(result.behavior).toBe('allow')
  })

  it('allows Glob', async () => {
    const result = await callTool(canUseTool, 'Glob', { pattern: '**/*.ts' })
    expect(result.behavior).toBe('allow')
  })

  it('allows Read', async () => {
    const result = await callTool(canUseTool, 'Read', { file_path: '/foo.ts' })
    expect(result.behavior).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// Enforcement active, fallbackAfterAttempt = true (default)
// ---------------------------------------------------------------------------

describe('createAutonomousCanUseTool — enforcement with fallback', () => {
  const enforcement: CodeIntelEnforcementConfig = {
    enforceUsage: true,
    fallbackAfterAttempt: true,
  }

  it('denies Grep before any af_code_* attempt', async () => {
    const canUseTool = createAutonomousCanUseTool(enforcement)
    const result = await callTool(canUseTool, 'Grep', { pattern: 'foo' })
    expect(result.behavior).toBe('deny')
    expect((result as { message: string }).message).toContain('af_code_search_code')
    expect((result as { message: string }).message).toContain('will be unlocked as a fallback')
  })

  it('denies Glob before any af_code_* attempt', async () => {
    const canUseTool = createAutonomousCanUseTool(enforcement)
    const result = await callTool(canUseTool, 'Glob', { pattern: '**/*.ts' })
    expect(result.behavior).toBe('deny')
    expect((result as { message: string }).message).toContain('af_code_get_repo_map')
  })

  it('allows Grep after an af_code_* tool is used', async () => {
    const canUseTool = createAutonomousCanUseTool(enforcement)

    // Use a code-intel tool first
    await callTool(canUseTool, 'mcp__af-code-intelligence__af_code_search_symbols', { query: 'foo' })

    // Now Grep should be allowed
    const result = await callTool(canUseTool, 'Grep', { pattern: 'foo' })
    expect(result.behavior).toBe('allow')
  })

  it('allows Glob after an af_code_* tool is used', async () => {
    const canUseTool = createAutonomousCanUseTool(enforcement)

    await callTool(canUseTool, 'mcp__af-code-intelligence__af_code_get_repo_map', {})

    const result = await callTool(canUseTool, 'Glob', { pattern: '**/*.ts' })
    expect(result.behavior).toBe('allow')
  })

  it('never blocks Read', async () => {
    const canUseTool = createAutonomousCanUseTool(enforcement)
    const result = await callTool(canUseTool, 'Read', { file_path: '/foo.ts' })
    expect(result.behavior).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// Enforcement active, fallbackAfterAttempt = false
// ---------------------------------------------------------------------------

describe('createAutonomousCanUseTool — enforcement without fallback', () => {
  const enforcement: CodeIntelEnforcementConfig = {
    enforceUsage: true,
    fallbackAfterAttempt: false,
  }

  it('denies Grep even after af_code_* attempt', async () => {
    const canUseTool = createAutonomousCanUseTool(enforcement)

    await callTool(canUseTool, 'mcp__af-code-intelligence__af_code_search_code', { query: 'foo' })

    const result = await callTool(canUseTool, 'Grep', { pattern: 'foo' })
    expect(result.behavior).toBe('deny')
    expect((result as { message: string }).message).toContain('disabled for this session')
  })
})

// ---------------------------------------------------------------------------
// Per-session isolation
// ---------------------------------------------------------------------------

describe('createAutonomousCanUseTool — session isolation', () => {
  const enforcement: CodeIntelEnforcementConfig = {
    enforceUsage: true,
    fallbackAfterAttempt: true,
  }

  it('two factory calls produce independent state', async () => {
    const session1 = createAutonomousCanUseTool(enforcement)
    const session2 = createAutonomousCanUseTool(enforcement)

    // Unlock fallback in session1 only
    await callTool(session1, 'mcp__af-code-intelligence__af_code_search_symbols', { query: 'x' })

    // session1: Grep allowed
    const result1 = await callTool(session1, 'Grep', { pattern: 'x' })
    expect(result1.behavior).toBe('allow')

    // session2: Grep still denied (independent state)
    const result2 = await callTool(session2, 'Grep', { pattern: 'x' })
    expect(result2.behavior).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Existing deny rules preserved
// ---------------------------------------------------------------------------

describe('createAutonomousCanUseTool — existing rules', () => {
  const canUseTool = createAutonomousCanUseTool()

  it('blocks Linear MCP tools', async () => {
    const result = await callTool(canUseTool, 'mcp__claude_ai_Linear__get_issue', {})
    expect(result.behavior).toBe('deny')
    expect((result as { message: string }).message).toContain('rensei linear')
  })

  it('blocks rm of filesystem root', async () => {
    const result = await callTool(canUseTool, 'Bash', { command: 'rm -rf / ' })
    expect(result.behavior).toBe('deny')
  })

  it('blocks git worktree remove', async () => {
    const result = await callTool(canUseTool, 'Bash', { command: 'git worktree remove /path' })
    expect(result.behavior).toBe('deny')
  })

  it('blocks force push without lease', async () => {
    const result = await callTool(canUseTool, 'Bash', { command: 'git push --force origin main' })
    expect(result.behavior).toBe('deny')
  })

  it('allows force-with-lease on feature branches', async () => {
    const result = await callTool(canUseTool, 'Bash', { command: 'git push --force-with-lease origin feature-branch' })
    expect(result.behavior).toBe('allow')
  })

  it('blocks git checkout', async () => {
    const result = await callTool(canUseTool, 'Bash', { command: 'git checkout main' })
    expect(result.behavior).toBe('deny')
  })

  it('strips run_in_background from Agent tool', async () => {
    const result = await callTool(canUseTool, 'Agent', { prompt: 'test', run_in_background: true })
    expect(result.behavior).toBe('allow')
    expect((result as { updatedInput: Record<string, unknown> }).updatedInput).not.toHaveProperty('run_in_background')
  })

  it('allows other MCP tools', async () => {
    const result = await callTool(canUseTool, 'mcp__claude_ai_Vercel__list_projects', {})
    expect(result.behavior).toBe('allow')
  })
})
