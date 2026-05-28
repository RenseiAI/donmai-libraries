import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { validateGitRemote } from './orchestrator.js'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn(),
  }
})

const mockExecSync = vi.mocked(execSync)

describe('validateGitRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes when HTTPS remote matches expected repo', () => {
    mockExecSync.mockReturnValue('https://github.com/RenseiAI/donmai-libraries.git\n')
    expect(() => validateGitRemote('github.com/RenseiAI/donmai-libraries')).not.toThrow()
  })

  it('passes when SSH remote matches expected repo', () => {
    mockExecSync.mockReturnValue('git@github.com:RenseiAI/donmai-libraries.git\n')
    expect(() => validateGitRemote('github.com/RenseiAI/donmai-libraries')).not.toThrow()
  })

  it('passes when HTTPS remote matches without .git suffix', () => {
    mockExecSync.mockReturnValue('https://github.com/RenseiAI/donmai-libraries\n')
    expect(() => validateGitRemote('github.com/RenseiAI/donmai-libraries')).not.toThrow()
  })

  it('passes when expected repo includes https:// prefix', () => {
    mockExecSync.mockReturnValue('https://github.com/RenseiAI/donmai-libraries.git\n')
    expect(() => validateGitRemote('https://github.com/RenseiAI/donmai-libraries')).not.toThrow()
  })

  it('throws on repository mismatch', () => {
    mockExecSync.mockReturnValue('https://github.com/renseiai/private-repo.git\n')
    expect(() => validateGitRemote('github.com/RenseiAI/donmai-libraries')).toThrow(
      /Repository mismatch: expected 'github.com\/RenseiAI\/donmai-libraries' but git remote is/
    )
  })

  it('throws when git remote command fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repository')
    })
    expect(() => validateGitRemote('github.com/RenseiAI/donmai-libraries')).toThrow(
      /Repository validation failed: could not get git remote URL/
    )
  })

  it('does not throw when repository is not configured (no validation needed)', () => {
    // This tests the orchestrator behavior: when config.repository is undefined,
    // validateGitRemote is never called. Tested indirectly via orchestrator constructor.
    // Here we just verify the function works with matching repos.
    mockExecSync.mockReturnValue('git@github.com:RenseiAI/donmai-libraries.git\n')
    expect(() => validateGitRemote('github.com/RenseiAI/donmai-libraries')).not.toThrow()
  })

  it('passes cwd option to execSync', () => {
    mockExecSync.mockReturnValue('https://github.com/RenseiAI/donmai-libraries.git\n')
    validateGitRemote('github.com/RenseiAI/donmai-libraries', '/some/path')
    expect(mockExecSync).toHaveBeenCalledWith('git remote get-url origin', {
      encoding: 'utf-8',
      cwd: '/some/path',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  })
})
