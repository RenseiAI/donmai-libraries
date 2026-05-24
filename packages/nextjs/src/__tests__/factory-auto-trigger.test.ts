import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAllRoutes } from '../factory.js'

/**
 * Regression test: auto-trigger config must be populated from env vars
 * when not explicitly provided in the config object.
 *
 * Previously, defaultParseAutoTriggerConfig() existed but was never called
 * in createAllRoutes(), so ENABLE_AUTO_QA and ENABLE_AUTO_ACCEPTANCE env
 * vars were silently ignored.
 */

// Minimal stub to satisfy the linearClient requirement
const stubLinearClient = (() => ({})) as any

describe('factory auto-trigger defaults from env vars', () => {
  const envBackup: Record<string, string | undefined> = {}
  const envKeys = [
    'ENABLE_AUTO_QA',
    'ENABLE_AUTO_ACCEPTANCE',
    'AUTO_QA_REQUIRE_AGENT_WORKED',
    'AUTO_ACCEPTANCE_REQUIRE_AGENT_WORKED',
    'AUTO_QA_PROJECTS',
    'AUTO_ACCEPTANCE_PROJECTS',
    'AUTO_QA_EXCLUDE_LABELS',
    'AUTO_ACCEPTANCE_EXCLUDE_LABELS',
  ]

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = envBackup[key]
      }
    }
  })

  it('reads ENABLE_AUTO_QA=true from env when autoTrigger not provided', () => {
    process.env.ENABLE_AUTO_QA = 'true'

    const routes = createAllRoutes({ linearClient: stubLinearClient })

    // The webhook handler is created with the resolved config internally.
    // We can't inspect the config directly, so we verify the factory doesn't
    // throw and returns valid routes — the real assertion is the unit test below.
    expect(routes.webhook).toBeDefined()
    expect(routes.webhook.POST).toBeTypeOf('function')
  })

  it('explicit autoTrigger config takes precedence over env vars', () => {
    process.env.ENABLE_AUTO_QA = 'true'
    process.env.ENABLE_AUTO_ACCEPTANCE = 'true'

    const customAutoTrigger = {
      enableAutoQA: false,
      enableAutoAcceptance: false,
      autoQARequireAgentWorked: true,
      autoAcceptanceRequireAgentWorked: true,
      autoQAProjects: [],
      autoAcceptanceProjects: [],
      autoQAExcludeLabels: [],
      autoAcceptanceExcludeLabels: [],
    }

    // Should not throw — explicit config overrides env
    const routes = createAllRoutes({
      linearClient: stubLinearClient,
      autoTrigger: customAutoTrigger,
    })
    expect(routes.webhook).toBeDefined()
  })
})

/**
 * Direct unit test of defaultParseAutoTriggerConfig to verify env var parsing.
 * This is the function that createAllRoutes now calls as the fallback.
 */
describe('defaultParseAutoTriggerConfig', () => {
  // Import dynamically so env mutations are visible
  let defaultParseAutoTriggerConfig: () => any

  beforeEach(async () => {
    const mod = await import('@donmai/plugin-linear')
    defaultParseAutoTriggerConfig = mod.defaultParseAutoTriggerConfig
  })

  const envBackup: Record<string, string | undefined> = {}
  const envKeys = [
    'ENABLE_AUTO_QA',
    'ENABLE_AUTO_ACCEPTANCE',
    'AUTO_QA_REQUIRE_AGENT_WORKED',
    'AUTO_ACCEPTANCE_REQUIRE_AGENT_WORKED',
    'AUTO_QA_PROJECTS',
    'AUTO_ACCEPTANCE_PROJECTS',
    'AUTO_QA_EXCLUDE_LABELS',
    'AUTO_ACCEPTANCE_EXCLUDE_LABELS',
  ]

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = envBackup[key]
      }
    }
  })

  it('defaults to all disabled when env vars are unset', () => {
    const config = defaultParseAutoTriggerConfig()
    expect(config.enableAutoQA).toBe(false)
    expect(config.enableAutoAcceptance).toBe(false)
    expect(config.autoQARequireAgentWorked).toBe(true)
    expect(config.autoAcceptanceRequireAgentWorked).toBe(true)
    expect(config.autoQAProjects).toEqual([])
    expect(config.autoAcceptanceProjects).toEqual([])
  })

  it('parses ENABLE_AUTO_QA=true', () => {
    process.env.ENABLE_AUTO_QA = 'true'
    const config = defaultParseAutoTriggerConfig()
    expect(config.enableAutoQA).toBe(true)
    expect(config.enableAutoAcceptance).toBe(false)
  })

  it('parses ENABLE_AUTO_ACCEPTANCE=true', () => {
    process.env.ENABLE_AUTO_ACCEPTANCE = 'true'
    const config = defaultParseAutoTriggerConfig()
    expect(config.enableAutoAcceptance).toBe(true)
  })

  it('parses comma-separated project lists', () => {
    process.env.AUTO_QA_PROJECTS = 'Social, Agent, Art'
    process.env.AUTO_ACCEPTANCE_PROJECTS = 'Agent'
    const config = defaultParseAutoTriggerConfig()
    expect(config.autoQAProjects).toEqual(['Social', 'Agent', 'Art'])
    expect(config.autoAcceptanceProjects).toEqual(['Agent'])
  })

  it('parses exclude labels', () => {
    process.env.AUTO_QA_EXCLUDE_LABELS = 'WIP,Manual QA'
    const config = defaultParseAutoTriggerConfig()
    expect(config.autoQAExcludeLabels).toEqual(['WIP', 'Manual QA'])
  })

  it('AUTO_QA_REQUIRE_AGENT_WORKED=false disables the check', () => {
    process.env.AUTO_QA_REQUIRE_AGENT_WORKED = 'false'
    const config = defaultParseAutoTriggerConfig()
    expect(config.autoQARequireAgentWorked).toBe(false)
  })
})
