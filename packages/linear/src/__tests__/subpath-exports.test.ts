import { describe, it, expect } from 'vitest'

/**
 * Subpath export resolution tests for @donmai/plugin-linear.
 *
 * Verifies that every key export defined in the main barrel resolves
 * to a module that exports the expected symbol. These tests catch:
 * - Missing `default` condition in exports map (breaks tsx/CJS loaders)
 * - Mismatched file paths between exports map and built output
 * - Missing or renamed function/class exports
 */

describe('@donmai/plugin-linear subpath exports', () => {
  // Client exports
  it('exports LinearAgentClient from main', async () => {
    const mod = await import('../index.js')
    expect(mod.LinearAgentClient).toBeDefined()
    expect(typeof mod.LinearAgentClient).toBe('function')
  })

  it('exports createLinearAgentClient from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createLinearAgentClient).toBeDefined()
    expect(typeof mod.createLinearAgentClient).toBe('function')
  })

  // Session exports
  it('exports AgentSession from main', async () => {
    const mod = await import('../index.js')
    expect(mod.AgentSession).toBeDefined()
    expect(typeof mod.AgentSession).toBe('function')
  })

  it('exports createAgentSession from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createAgentSession).toBeDefined()
    expect(typeof mod.createAgentSession).toBe('function')
  })

  // Error exports
  it('exports LinearAgentError from main', async () => {
    const mod = await import('../index.js')
    expect(mod.LinearAgentError).toBeDefined()
    expect(typeof mod.LinearAgentError).toBe('function')
  })

  it('exports LinearApiError from main', async () => {
    const mod = await import('../index.js')
    expect(mod.LinearApiError).toBeDefined()
    expect(typeof mod.LinearApiError).toBe('function')
  })

  it('exports isLinearAgentError from main', async () => {
    const mod = await import('../index.js')
    expect(mod.isLinearAgentError).toBeDefined()
    expect(typeof mod.isLinearAgentError).toBe('function')
  })

  it('exports isRetryableError from main', async () => {
    const mod = await import('../index.js')
    expect(mod.isRetryableError).toBeDefined()
    expect(typeof mod.isRetryableError).toBe('function')
  })

  // Retry utilities
  it('exports withRetry from main', async () => {
    const mod = await import('../index.js')
    expect(mod.withRetry).toBeDefined()
    expect(typeof mod.withRetry).toBe('function')
  })

  it('exports createRetryWrapper from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createRetryWrapper).toBeDefined()
    expect(typeof mod.createRetryWrapper).toBe('function')
  })

  // Constants
  it('exports LINEAR_COMMENT_MAX_LENGTH from main', async () => {
    const mod = await import('../index.js')
    expect(mod.LINEAR_COMMENT_MAX_LENGTH).toBeDefined()
    expect(typeof mod.LINEAR_COMMENT_MAX_LENGTH).toBe('number')
  })

  // Utilities
  it('exports truncateText from main', async () => {
    const mod = await import('../index.js')
    expect(mod.truncateText).toBeDefined()
    expect(typeof mod.truncateText).toBe('function')
  })

  it('exports buildCompletionComment from main', async () => {
    const mod = await import('../index.js')
    expect(mod.buildCompletionComment).toBeDefined()
    expect(typeof mod.buildCompletionComment).toBe('function')
  })

  // Work type mappings
  it('exports STATUS_WORK_TYPE_MAP from main', async () => {
    const mod = await import('../index.js')
    expect(mod.STATUS_WORK_TYPE_MAP).toBeDefined()
    expect(typeof mod.STATUS_WORK_TYPE_MAP).toBe('object')
  })

  it('exports validateWorkTypeForStatus from main', async () => {
    const mod = await import('../index.js')
    expect(mod.validateWorkTypeForStatus).toBeDefined()
    expect(typeof mod.validateWorkTypeForStatus).toBe('function')
  })

  // Checkbox utilities
  it('exports parseCheckboxes from main', async () => {
    const mod = await import('../index.js')
    expect(mod.parseCheckboxes).toBeDefined()
    expect(typeof mod.parseCheckboxes).toBe('function')
  })

  // Rate limiter
  it('exports TokenBucket from main', async () => {
    const mod = await import('../index.js')
    expect(mod.TokenBucket).toBeDefined()
    expect(typeof mod.TokenBucket).toBe('function')
  })

  // Circuit breaker
  it('exports CircuitBreaker from main', async () => {
    const mod = await import('../index.js')
    expect(mod.CircuitBreaker).toBeDefined()
    expect(typeof mod.CircuitBreaker).toBe('function')
  })

  // Frontend adapter
  it('exports LinearFrontendAdapter from main', async () => {
    const mod = await import('../index.js')
    expect(mod.LinearFrontendAdapter).toBeDefined()
    expect(typeof mod.LinearFrontendAdapter).toBe('function')
  })

  // Platform adapter
  it('exports LinearPlatformAdapter from main', async () => {
    const mod = await import('../index.js')
    expect(mod.LinearPlatformAdapter).toBeDefined()
    expect(typeof mod.LinearPlatformAdapter).toBe('function')
  })

  // Proxy client
  it('exports ProxyIssueTrackerClient from main', async () => {
    const mod = await import('../index.js')
    expect(mod.ProxyIssueTrackerClient).toBeDefined()
    expect(typeof mod.ProxyIssueTrackerClient).toBe('function')
  })

  // Defaults
  it('exports defaultGeneratePrompt from main', async () => {
    const mod = await import('../index.js')
    expect(mod.defaultGeneratePrompt).toBeDefined()
    expect(typeof mod.defaultGeneratePrompt).toBe('function')
  })
})
