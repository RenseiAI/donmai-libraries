import { describe, it, expect } from 'vitest'

/**
 * Subpath export resolution tests for @donmai/core.
 *
 * Verifies that every key export defined in the main barrel resolves
 * to a module that exports the expected symbol. These tests catch:
 * - Missing `default` condition in exports map (breaks tsx/CJS loaders)
 * - Mismatched file paths between exports map and built output
 * - Missing or renamed function/class exports
 */

describe('@donmai/core subpath exports', () => {
  // Orchestrator exports
  it('exports AgentOrchestrator from main', async () => {
    const mod = await import('../index.js')
    expect(mod.AgentOrchestrator).toBeDefined()
    expect(typeof mod.AgentOrchestrator).toBe('function')
  })

  it('exports createOrchestrator from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createOrchestrator).toBeDefined()
    expect(typeof mod.createOrchestrator).toBe('function')
  })

  it('exports validateGitRemote from main', async () => {
    const mod = await import('../index.js')
    expect(mod.validateGitRemote).toBeDefined()
    expect(typeof mod.validateGitRemote).toBe('function')
  })

  // Provider exports
  it('exports createProvider from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createProvider).toBeDefined()
    expect(typeof mod.createProvider).toBe('function')
  })

  it('exports resolveProviderName from main', async () => {
    const mod = await import('../index.js')
    expect(mod.resolveProviderName).toBeDefined()
    expect(typeof mod.resolveProviderName).toBe('function')
  })

  it('exports isValidProviderName from main', async () => {
    const mod = await import('../index.js')
    expect(mod.isValidProviderName).toBeDefined()
    expect(typeof mod.isValidProviderName).toBe('function')
  })

  // Logger exports
  it('exports Logger class from main', async () => {
    const mod = await import('../index.js')
    expect(mod.Logger).toBeDefined()
    expect(typeof mod.Logger).toBe('function')
  })

  it('exports createLogger from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createLogger).toBeDefined()
    expect(typeof mod.createLogger).toBe('function')
  })

  // Template exports
  it('exports TemplateRegistry from main', async () => {
    const mod = await import('../index.js')
    expect(mod.TemplateRegistry).toBeDefined()
    expect(typeof mod.TemplateRegistry).toBe('function')
  })

  it('exports renderPromptWithFallback from main', async () => {
    const mod = await import('../index.js')
    expect(mod.renderPromptWithFallback).toBeDefined()
    expect(typeof mod.renderPromptWithFallback).toBe('function')
  })

  it('exports createToolPermissionAdapter from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createToolPermissionAdapter).toBeDefined()
    expect(typeof mod.createToolPermissionAdapter).toBe('function')
  })

  // Config exports
  it('exports loadRepositoryConfig from main', async () => {
    const mod = await import('../index.js')
    expect(mod.loadRepositoryConfig).toBeDefined()
    expect(typeof mod.loadRepositoryConfig).toBe('function')
  })

  it('exports getProjectConfig from main', async () => {
    const mod = await import('../index.js')
    expect(mod.getProjectConfig).toBeDefined()
    expect(typeof mod.getProjectConfig).toBe('function')
  })

  // Stream parser exports
  it('exports ClaudeStreamParser from main', async () => {
    const mod = await import('../index.js')
    expect(mod.ClaudeStreamParser).toBeDefined()
    expect(typeof mod.ClaudeStreamParser).toBe('function')
  })

  it('exports createStreamParser from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createStreamParser).toBeDefined()
    expect(typeof mod.createStreamParser).toBe('function')
  })

  // Work result parser
  it('exports parseWorkResult from main', async () => {
    const mod = await import('../index.js')
    expect(mod.parseWorkResult).toBeDefined()
    expect(typeof mod.parseWorkResult).toBe('function')
  })
})
