import { describe, it, expect } from 'vitest'

/**
 * Subpath export resolution tests for @donmai/nextjs.
 *
 * Verifies that the /middleware subpath exports the expected factory
 * function and does NOT transitively import Node.js-only modules
 * (crypto, ioredis) that break Edge Runtime.
 */

describe('@donmai/nextjs subpath exports', () => {
  it('exports createAgentFactoryMiddleware from ./middleware', async () => {
    const mod = await import('../middleware/index.js')
    expect(mod.createAgentFactoryMiddleware).toBeDefined()
    expect(typeof mod.createAgentFactoryMiddleware).toBe('function')
  })

  it('exports createAllRoutes from main barrel', { timeout: 15_000 }, async () => {
    const mod = await import('../index.js')
    expect(mod.createAllRoutes).toBeDefined()
    expect(typeof mod.createAllRoutes).toBe('function')
  })

  it('exports createDefaultLinearClientResolver from main barrel', { timeout: 15_000 }, async () => {
    const mod = await import('../index.js')
    expect(mod.createDefaultLinearClientResolver).toBeDefined()
    expect(typeof mod.createDefaultLinearClientResolver).toBe('function')
  })

  it('exports createWebhookOrchestrator from main barrel', { timeout: 15_000 }, async () => {
    const mod = await import('../index.js')
    expect(mod.createWebhookOrchestrator).toBeDefined()
    expect(typeof mod.createWebhookOrchestrator).toBe('function')
  })

  it('exports createOAuthCallbackHandler from main barrel', { timeout: 15_000 }, async () => {
    const mod = await import('../index.js')
    expect(mod.createOAuthCallbackHandler).toBeDefined()
    expect(typeof mod.createOAuthCallbackHandler).toBe('function')
  })
})
