import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { loadRepositoryConfig, RepositoryConfigSchema, getEffectiveAllowedProjects, getProjectConfig, getProjectPath, getProvidersConfig, getRoutingConfig, GitConfigSchema, getGitIdentityConfig, ProvidersConfigSchema, RoutingConfigSectionSchema } from './repository-config.js'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

describe('loadRepositoryConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toBeNull()
    expect(mockExistsSync).toHaveBeenCalledWith('/some/repo/.donmai/config.yaml')
  })

  it('parses valid YAML with all fields', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/renseiai/agentfactory
allowedProjects:
  - Agent
  - Dashboard
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/agentfactory',
      allowedProjects: ['Agent', 'Dashboard'],
    })
  })

  it('parses valid YAML with only required fields', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
  })

  it('throws on invalid schema — wrong kind', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: WorkflowTemplate
repository: github.com/renseiai/agentfactory
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })

  it('throws on invalid schema — missing apiVersion', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `kind: RepositoryConfig
repository: github.com/renseiai/agentfactory
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })

  it('parses valid YAML with projectPaths and sharedPaths', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/renseiai/renseiai
projectPaths:
  Social: apps/social
  Family: apps/family
sharedPaths:
  - packages/ui
  - packages/lexical
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/renseiai',
      projectPaths: { Social: 'apps/social', Family: 'apps/family' },
      sharedPaths: ['packages/ui', 'packages/lexical'],
    })
  })

  it('parses valid YAML with mixed string and object projectPaths', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/org/monorepo
projectPaths:
  Social: apps/social
  Family iOS:
    path: apps/family-ios
    packageManager: none
    buildCommand: "make build"
    testCommand: "make test"
sharedPaths:
  - packages/ui
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/monorepo',
      projectPaths: {
        Social: 'apps/social',
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
        },
      },
      sharedPaths: ['packages/ui'],
    })
  })

  it('throws on invalid schema — allowedProjects is not an array', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
allowedProjects: NotAnArray
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })
})

describe('RepositoryConfigSchema', () => {
  it('validates a complete config', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/repo',
      allowedProjects: ['ProjectA', 'ProjectB'],
    })
    expect(result.apiVersion).toBe('v1')
    expect(result.kind).toBe('RepositoryConfig')
    expect(result.repository).toBe('github.com/org/repo')
    expect(result.allowedProjects).toEqual(['ProjectA', 'ProjectB'])
  })

  it('validates a minimal config with only required fields', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(result.apiVersion).toBe('v1')
    expect(result.kind).toBe('RepositoryConfig')
    expect(result.repository).toBeUndefined()
    expect(result.allowedProjects).toBeUndefined()
  })

  it('rejects invalid kind', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        apiVersion: 'v1',
        kind: 'InvalidKind',
      })
    ).toThrow()
  })

  it('validates config with projectPaths only (string shorthand)', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/monorepo',
      projectPaths: {
        Social: 'apps/social',
        Family: 'apps/family',
      },
    })
    expect(result.projectPaths).toEqual({ Social: 'apps/social', Family: 'apps/family' })
    expect(result.allowedProjects).toBeUndefined()
  })

  it('validates config with projectPaths object form', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
          validateCommand: 'make build',
        },
      },
    })
    expect(result.projectPaths).toEqual({
      Social: 'apps/social',
      'Family iOS': {
        path: 'apps/family-ios',
        packageManager: 'none',
        buildCommand: 'make build',
        testCommand: 'make test',
        validateCommand: 'make build',
      },
    })
  })

  it('validates config with mixed string and object projectPaths', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        Family: 'apps/family',
        'Family iOS': { path: 'apps/family-ios', packageManager: 'none' },
      },
    })
    expect(Object.keys(result.projectPaths!)).toEqual(['Social', 'Family', 'Family iOS'])
  })

  it('validates config with projectPaths and sharedPaths', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        Family: 'apps/family',
      },
      sharedPaths: ['packages/ui', 'packages/lexical'],
    })
    expect(result.projectPaths).toEqual({ Social: 'apps/social', Family: 'apps/family' })
    expect(result.sharedPaths).toEqual(['packages/ui', 'packages/lexical'])
  })

  it('rejects config with both allowedProjects and projectPaths', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        apiVersion: 'v1',
        kind: 'RepositoryConfig',
        allowedProjects: ['Social'],
        projectPaths: { Social: 'apps/social' },
      })
    ).toThrow(/mutually exclusive/)
  })

  it('validates config with build/test/validate commands', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/native-project',
      buildCommand: 'cargo build --release',
      testCommand: 'cargo test',
      validateCommand: 'cargo clippy -- -D warnings',
    })
    expect(result.buildCommand).toBe('cargo build --release')
    expect(result.testCommand).toBe('cargo test')
    expect(result.validateCommand).toBe('cargo clippy -- -D warnings')
  })

  it('allows omitting build/test/validate commands', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(result.buildCommand).toBeUndefined()
    expect(result.testCommand).toBeUndefined()
    expect(result.validateCommand).toBeUndefined()
  })

  it('validates config with build commands and non-Node settings', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      packageManager: 'none',
      linearCli: 'bash tools/af-linear.sh',
      buildCommand: 'cmake --build build/',
      testCommand: 'ctest --test-dir build/',
    })
    expect(result.packageManager).toBe('none')
    expect(result.linearCli).toBe('bash tools/af-linear.sh')
    expect(result.buildCommand).toBe('cmake --build build/')
    expect(result.testCommand).toBe('ctest --test-dir build/')
  })
})

describe('loadRepositoryConfig with build commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses config with build/test/validate commands', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/org/native-project
packageManager: none
buildCommand: "cargo build --release"
testCommand: "cargo test"
validateCommand: "cargo clippy -- -D warnings"
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/native-project',
      packageManager: 'none',
      buildCommand: 'cargo build --release',
      testCommand: 'cargo test',
      validateCommand: 'cargo clippy -- -D warnings',
    })
  })
})

describe('getEffectiveAllowedProjects', () => {
  it('returns keys from projectPaths when set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social', Family: 'apps/family' },
    })
    expect(getEffectiveAllowedProjects(config)).toEqual(['Social', 'Family'])
  })

  it('returns allowedProjects when projectPaths is not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      allowedProjects: ['Agent', 'Dashboard'],
    })
    expect(getEffectiveAllowedProjects(config)).toEqual(['Agent', 'Dashboard'])
  })

  it('returns undefined when neither is set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getEffectiveAllowedProjects(config)).toBeUndefined()
  })

  it('returns keys from mixed string/object projectPaths', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        'Family iOS': { path: 'apps/family-ios', packageManager: 'none' },
      },
    })
    expect(getEffectiveAllowedProjects(config)).toEqual(['Social', 'Family iOS'])
  })
})

describe('getProjectConfig', () => {
  it('returns null when projectPaths is not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getProjectConfig(config, 'Social')).toBeNull()
  })

  it('returns null for unknown project', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    expect(getProjectConfig(config, 'Unknown')).toBeNull()
  })

  it('normalizes string shorthand to ProjectConfig', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    const result = getProjectConfig(config, 'Social')
    expect(result).toEqual({
      path: 'apps/social',
      packageManager: undefined,
      buildCommand: undefined,
      testCommand: undefined,
      validateCommand: undefined,
    })
  })

  it('returns per-project overrides from object form', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
          validateCommand: 'make build',
        },
      },
    })
    const result = getProjectConfig(config, 'Family iOS')
    expect(result).toEqual({
      path: 'apps/family-ios',
      packageManager: 'none',
      buildCommand: 'make build',
      testCommand: 'make test',
      validateCommand: 'make build',
    })
  })

  it('falls back to repo-wide defaults when per-project overrides are not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      projectPaths: { Social: 'apps/social' },
    })
    const result = getProjectConfig(config, 'Social')
    expect(result).toEqual({
      path: 'apps/social',
      packageManager: undefined,
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      validateCommand: undefined,
    })
  })

  it('per-project overrides take precedence over repo-wide defaults', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      packageManager: 'pnpm',
      projectPaths: {
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
        },
      },
    })
    const result = getProjectConfig(config, 'Family iOS')
    expect(result).toEqual({
      path: 'apps/family-ios',
      packageManager: 'none',
      buildCommand: 'make build',
      testCommand: 'make test',
      validateCommand: undefined,
    })
  })
})

describe('getProjectPath', () => {
  it('returns path from string shorthand', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    expect(getProjectPath(config, 'Social')).toBe('apps/social')
  })

  it('returns path from object form', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { 'Family iOS': { path: 'apps/family-ios' } },
    })
    expect(getProjectPath(config, 'Family iOS')).toBe('apps/family-ios')
  })

  it('returns undefined for unknown project', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    expect(getProjectPath(config, 'Unknown')).toBeUndefined()
  })

  it('returns undefined when projectPaths is not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getProjectPath(config, 'Social')).toBeUndefined()
  })
})

describe('ProvidersConfigSchema', () => {
  it('validates a complete providers config', () => {
    const result = ProvidersConfigSchema.parse({
      default: 'codex',
      byWorkType: { qa: 'amp', development: 'claude' },
      byProject: { Social: 'codex' },
    })
    expect(result.default).toBe('codex')
    expect(result.byWorkType).toEqual({ qa: 'amp', development: 'claude' })
    expect(result.byProject).toEqual({ Social: 'codex' })
  })

  it('validates an empty object', () => {
    const result = ProvidersConfigSchema.parse({})
    expect(result.default).toBeUndefined()
    expect(result.byWorkType).toBeUndefined()
    expect(result.byProject).toBeUndefined()
  })

  it('rejects invalid provider names', () => {
    expect(() => ProvidersConfigSchema.parse({ default: 'invalid' })).toThrow()
  })

  it('rejects invalid provider names in byWorkType', () => {
    expect(() => ProvidersConfigSchema.parse({ byWorkType: { qa: 'invalid' } })).toThrow()
  })
})

describe('RepositoryConfigSchema with providers', () => {
  it('validates config with providers field', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      providers: {
        default: 'codex',
        byWorkType: { qa: 'amp' },
      },
    })
    expect(result.providers).toEqual({
      default: 'codex',
      byWorkType: { qa: 'amp' },
    })
  })

  it('validates config without providers field', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(result.providers).toBeUndefined()
  })
})

describe('loadRepositoryConfig with providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses config with providers section', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
providers:
  default: codex
  byWorkType:
    qa: amp
  byProject:
    Social: claude
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result?.providers).toEqual({
      default: 'codex',
      byWorkType: { qa: 'amp' },
      byProject: { Social: 'claude' },
    })
  })
})

describe('getProvidersConfig', () => {
  it('returns providers config when present', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      providers: { default: 'codex' },
    })
    expect(getProvidersConfig(config)).toEqual({ default: 'codex' })
  })

  it('returns undefined when providers not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getProvidersConfig(config)).toBeUndefined()
  })
})

describe('RoutingConfigSectionSchema', () => {
  it('validates a complete routing config', () => {
    const result = RoutingConfigSectionSchema.parse({
      enabled: true,
      explorationRate: 0.2,
      windowSize: 200,
      discountFactor: 0.95,
      minObservationsForExploit: 10,
      changeDetectionThreshold: 0.3,
    })
    expect(result.enabled).toBe(true)
    expect(result.explorationRate).toBe(0.2)
    expect(result.windowSize).toBe(200)
    expect(result.discountFactor).toBe(0.95)
    expect(result.minObservationsForExploit).toBe(10)
    expect(result.changeDetectionThreshold).toBe(0.3)
  })

  it('applies defaults when only enabled is provided', () => {
    const result = RoutingConfigSectionSchema.parse({ enabled: true })
    expect(result.enabled).toBe(true)
    expect(result.explorationRate).toBe(0.1)
    expect(result.windowSize).toBe(100)
    expect(result.discountFactor).toBe(0.99)
    expect(result.minObservationsForExploit).toBe(5)
    expect(result.changeDetectionThreshold).toBe(0.2)
  })

  it('applies defaults for an empty object (enabled defaults to false)', () => {
    const result = RoutingConfigSectionSchema.parse({})
    expect(result.enabled).toBe(false)
    expect(result.explorationRate).toBe(0.1)
  })

  it('rejects explorationRate outside 0-1 range', () => {
    expect(() => RoutingConfigSectionSchema.parse({ enabled: true, explorationRate: 1.5 })).toThrow()
    expect(() => RoutingConfigSectionSchema.parse({ enabled: true, explorationRate: -0.1 })).toThrow()
  })

  it('rejects non-positive windowSize', () => {
    expect(() => RoutingConfigSectionSchema.parse({ enabled: true, windowSize: 0 })).toThrow()
    expect(() => RoutingConfigSectionSchema.parse({ enabled: true, windowSize: -1 })).toThrow()
  })

  it('rejects discountFactor outside 0-1 range', () => {
    expect(() => RoutingConfigSectionSchema.parse({ enabled: true, discountFactor: 1.1 })).toThrow()
  })

  it('rejects negative minObservationsForExploit', () => {
    expect(() => RoutingConfigSectionSchema.parse({ enabled: true, minObservationsForExploit: -1 })).toThrow()
  })

  it('rejects negative changeDetectionThreshold', () => {
    expect(() => RoutingConfigSectionSchema.parse({ enabled: true, changeDetectionThreshold: -0.1 })).toThrow()
  })
})

describe('RepositoryConfigSchema with routing', () => {
  it('validates config with routing field', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      routing: {
        enabled: true,
        explorationRate: 0.05,
      },
    })
    expect(result.routing).toBeDefined()
    expect(result.routing!.enabled).toBe(true)
    expect(result.routing!.explorationRate).toBe(0.05)
    // Defaults should be applied
    expect(result.routing!.windowSize).toBe(100)
  })

  it('validates config without routing field', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(result.routing).toBeUndefined()
  })

  it('validates config with both providers and routing', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      providers: { default: 'codex' },
      routing: { enabled: true },
    })
    expect(result.providers).toEqual({ default: 'codex' })
    expect(result.routing!.enabled).toBe(true)
  })
})

describe('loadRepositoryConfig with routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses config with routing section', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
routing:
  enabled: true
  explorationRate: 0.05
  windowSize: 50
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result?.routing).toBeDefined()
    expect(result?.routing?.enabled).toBe(true)
    expect(result?.routing?.explorationRate).toBe(0.05)
    expect(result?.routing?.windowSize).toBe(50)
    // Defaults applied for unspecified fields
    expect(result?.routing?.discountFactor).toBe(0.99)
    expect(result?.routing?.minObservationsForExploit).toBe(5)
    expect(result?.routing?.changeDetectionThreshold).toBe(0.2)
  })

  it('parses config with routing disabled (default)', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
routing:
  enabled: false
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result?.routing?.enabled).toBe(false)
  })
})

describe('getRoutingConfig', () => {
  it('returns routing config when present', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      routing: { enabled: true },
    })
    const routing = getRoutingConfig(config)
    expect(routing).toBeDefined()
    expect(routing!.enabled).toBe(true)
  })

  it('returns undefined when routing not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getRoutingConfig(config)).toBeUndefined()
  })
})

describe('RepositoryConfigSchema mergeQueue — Refinery fields', () => {
  const base = { apiVersion: 'v1', kind: 'RepositoryConfig' } as const

  it('applies default values when new fields are absent (backward compat)', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      mergeQueue: { enabled: true },
    })
    expect(result.mergeQueue).toBeDefined()
    expect(result.mergeQueue!.provider).toBe('local')
    expect(result.mergeQueue!.enabled).toBe(true)
    expect(result.mergeQueue!.autoMerge).toBe(true)
    expect(result.mergeQueue!.requiredChecks).toBeUndefined()
    expect(result.mergeQueue!.strategy).toBe('rebase')
    expect(result.mergeQueue!.testCommand).toBe('pnpm test')
    expect(result.mergeQueue!.testTimeout).toBe(300_000)
    expect(result.mergeQueue!.lockFileRegenerate).toBe(true)
    expect(result.mergeQueue!.mergiraf).toBe(true)
    expect(result.mergeQueue!.pollInterval).toBe(10_000)
    expect(result.mergeQueue!.maxRetries).toBe(2)
    expect(result.mergeQueue!.escalation).toBeUndefined()
    expect(result.mergeQueue!.deleteBranchOnMerge).toBe(true)
  })

  it('accepts an empty mergeQueue object and applies all defaults', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      mergeQueue: {},
    })
    expect(result.mergeQueue!.enabled).toBe(false)
    expect(result.mergeQueue!.strategy).toBe('rebase')
    expect(result.mergeQueue!.testCommand).toBe('pnpm test')
    expect(result.mergeQueue!.testTimeout).toBe(300_000)
    expect(result.mergeQueue!.lockFileRegenerate).toBe(true)
    expect(result.mergeQueue!.mergiraf).toBe(true)
    expect(result.mergeQueue!.pollInterval).toBe(10_000)
    expect(result.mergeQueue!.maxRetries).toBe(2)
    expect(result.mergeQueue!.deleteBranchOnMerge).toBe(true)
  })

  it('validates strategy enum values', () => {
    for (const strategy of ['rebase', 'merge', 'squash'] as const) {
      const result = RepositoryConfigSchema.parse({
        ...base,
        mergeQueue: { strategy },
      })
      expect(result.mergeQueue!.strategy).toBe(strategy)
    }
  })

  it('rejects invalid strategy enum value', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        ...base,
        mergeQueue: { strategy: 'cherry-pick' },
      })
    ).toThrow()
  })

  it('validates escalation onConflict enum values', () => {
    for (const onConflict of ['reassign', 'notify', 'park'] as const) {
      const result = RepositoryConfigSchema.parse({
        ...base,
        mergeQueue: { escalation: { onConflict } },
      })
      expect(result.mergeQueue!.escalation!.onConflict).toBe(onConflict)
    }
  })

  it('validates escalation onTestFailure enum values', () => {
    for (const onTestFailure of ['notify', 'park', 'retry'] as const) {
      const result = RepositoryConfigSchema.parse({
        ...base,
        mergeQueue: { escalation: { onTestFailure } },
      })
      expect(result.mergeQueue!.escalation!.onTestFailure).toBe(onTestFailure)
    }
  })

  it('rejects invalid escalation onConflict value', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        ...base,
        mergeQueue: { escalation: { onConflict: 'ignore' } },
      })
    ).toThrow()
  })

  it('rejects invalid escalation onTestFailure value', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        ...base,
        mergeQueue: { escalation: { onTestFailure: 'ignore' } },
      })
    ).toThrow()
  })

  it('applies escalation defaults when escalation is provided as empty object', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      mergeQueue: { escalation: {} },
    })
    expect(result.mergeQueue!.escalation!.onConflict).toBe('reassign')
    expect(result.mergeQueue!.escalation!.onTestFailure).toBe('notify')
  })

  it('validates full config with all new fields', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      mergeQueue: {
        provider: 'mergify',
        enabled: true,
        autoMerge: false,
        requiredChecks: ['ci/build', 'ci/test'],
        strategy: 'squash',
        testCommand: 'npm run test:ci',
        testTimeout: 600_000,
        lockFileRegenerate: false,
        mergiraf: false,
        pollInterval: 30_000,
        maxRetries: 5,
        escalation: {
          onConflict: 'park',
          onTestFailure: 'retry',
        },
        deleteBranchOnMerge: false,
      },
    })
    expect(result.mergeQueue!.provider).toBe('mergify')
    expect(result.mergeQueue!.enabled).toBe(true)
    expect(result.mergeQueue!.autoMerge).toBe(false)
    expect(result.mergeQueue!.requiredChecks).toEqual(['ci/build', 'ci/test'])
    expect(result.mergeQueue!.strategy).toBe('squash')
    expect(result.mergeQueue!.testCommand).toBe('npm run test:ci')
    expect(result.mergeQueue!.testTimeout).toBe(600_000)
    expect(result.mergeQueue!.lockFileRegenerate).toBe(false)
    expect(result.mergeQueue!.mergiraf).toBe(false)
    expect(result.mergeQueue!.pollInterval).toBe(30_000)
    expect(result.mergeQueue!.maxRetries).toBe(5)
    expect(result.mergeQueue!.escalation).toEqual({
      onConflict: 'park',
      onTestFailure: 'retry',
    })
    expect(result.mergeQueue!.deleteBranchOnMerge).toBe(false)
  })

  it('mergeQueue remains optional on the top-level schema', () => {
    const result = RepositoryConfigSchema.parse(base)
    expect(result.mergeQueue).toBeUndefined()
  })
})

describe('loadRepositoryConfig with mergeQueue Refinery fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses YAML with all mergeQueue Refinery fields', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
mergeQueue:
  provider: trunk
  enabled: true
  autoMerge: true
  requiredChecks:
    - ci/build
  strategy: merge
  testCommand: "yarn test"
  testTimeout: 120000
  lockFileRegenerate: false
  mergiraf: false
  pollInterval: 5000
  maxRetries: 3
  escalation:
    onConflict: notify
    onTestFailure: park
  deleteBranchOnMerge: false
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result?.mergeQueue).toBeDefined()
    expect(result!.mergeQueue!.provider).toBe('trunk')
    expect(result!.mergeQueue!.strategy).toBe('merge')
    expect(result!.mergeQueue!.testCommand).toBe('yarn test')
    expect(result!.mergeQueue!.testTimeout).toBe(120_000)
    expect(result!.mergeQueue!.lockFileRegenerate).toBe(false)
    expect(result!.mergeQueue!.mergiraf).toBe(false)
    expect(result!.mergeQueue!.pollInterval).toBe(5_000)
    expect(result!.mergeQueue!.maxRetries).toBe(3)
    expect(result!.mergeQueue!.escalation).toEqual({
      onConflict: 'notify',
      onTestFailure: 'park',
    })
    expect(result!.mergeQueue!.deleteBranchOnMerge).toBe(false)
  })

  it('parses YAML with only existing mergeQueue fields — new fields get defaults', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
mergeQueue:
  enabled: true
  provider: github-native
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result?.mergeQueue).toBeDefined()
    expect(result!.mergeQueue!.enabled).toBe(true)
    expect(result!.mergeQueue!.provider).toBe('github-native')
    expect(result!.mergeQueue!.strategy).toBe('rebase')
    expect(result!.mergeQueue!.testCommand).toBe('pnpm test')
    expect(result!.mergeQueue!.testTimeout).toBe(300_000)
    expect(result!.mergeQueue!.lockFileRegenerate).toBe(true)
    expect(result!.mergeQueue!.mergiraf).toBe(true)
    expect(result!.mergeQueue!.pollInterval).toBe(10_000)
    expect(result!.mergeQueue!.maxRetries).toBe(2)
    expect(result!.mergeQueue!.escalation).toBeUndefined()
    expect(result!.mergeQueue!.deleteBranchOnMerge).toBe(true)
  })
})

describe('GitConfigSchema', () => {
  it('validates git config with both fields', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      git: {
        authorName: 'Rensei Agent',
        authorEmail: 'agent@example.com',
      },
    })
    expect(result.git).toEqual({
      authorName: 'Rensei Agent',
      authorEmail: 'agent@example.com',
    })
  })

  it('validates git config with only authorName', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      git: { authorName: 'Custom Agent' },
    })
    expect(result.git?.authorName).toBe('Custom Agent')
    expect(result.git?.authorEmail).toBeUndefined()
  })

  it('validates git config with only authorEmail', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      git: { authorEmail: 'custom@example.com' },
    })
    expect(result.git?.authorEmail).toBe('custom@example.com')
    expect(result.git?.authorName).toBeUndefined()
  })

  it('rejects invalid email format', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        apiVersion: 'v1',
        kind: 'RepositoryConfig',
        git: { authorEmail: 'not-an-email' },
      })
    ).toThrow()
  })

  it('allows omitting git section entirely', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(result.git).toBeUndefined()
  })
})

describe('loadRepositoryConfig with git config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses config with git identity section', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
git:
  authorName: "Rensei Agent"
  authorEmail: "agent@example.com"
`)
    const result = loadRepositoryConfig('/some/repo')
    expect(result?.git).toEqual({
      authorName: 'Rensei Agent',
      authorEmail: 'agent@example.com',
    })
  })
})

// ---------------------------------------------------------------------------
// systemPrompt config
// ---------------------------------------------------------------------------

describe('RepositoryConfigSchema systemPrompt', () => {
  const base = { apiVersion: 'v1', kind: 'RepositoryConfig' as const }

  it('accepts systemPrompt with append only', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      systemPrompt: {
        append: 'Always run pnpm verify before pushing.',
      },
    })
    expect(result.systemPrompt!.append).toBe('Always run pnpm verify before pushing.')
    expect(result.systemPrompt!.byWorkType).toBeUndefined()
  })

  it('accepts systemPrompt with byWorkType only', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      systemPrompt: {
        byWorkType: {
          'refinement-coordination': 'Triage sub-issues individually.',
          development: 'Follow TDD workflow.',
        },
      },
    })
    expect(result.systemPrompt!.append).toBeUndefined()
    expect(result.systemPrompt!.byWorkType!['refinement-coordination']).toBe('Triage sub-issues individually.')
    expect(result.systemPrompt!.byWorkType!['development']).toBe('Follow TDD workflow.')
  })

  it('accepts systemPrompt with both append and byWorkType', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      systemPrompt: {
        append: '# Global rules',
        byWorkType: {
          qa: '# QA rules',
        },
      },
    })
    expect(result.systemPrompt!.append).toBe('# Global rules')
    expect(result.systemPrompt!.byWorkType!['qa']).toBe('# QA rules')
  })

  it('accepts empty systemPrompt object', () => {
    const result = RepositoryConfigSchema.parse({
      ...base,
      systemPrompt: {},
    })
    expect(result.systemPrompt).toBeDefined()
    expect(result.systemPrompt!.append).toBeUndefined()
    expect(result.systemPrompt!.byWorkType).toBeUndefined()
  })

  it('omits systemPrompt when not provided', () => {
    const result = RepositoryConfigSchema.parse(base)
    expect(result.systemPrompt).toBeUndefined()
  })

  it('accepts multiline append strings', () => {
    const multiline = '# Rules\n- Always verify\n- Never skip tests'
    const result = RepositoryConfigSchema.parse({
      ...base,
      systemPrompt: { append: multiline },
    })
    expect(result.systemPrompt!.append).toBe(multiline)
  })

  it('parses systemPrompt from YAML via loadRepositoryConfig', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
systemPrompt:
  append: |
    Always run verify.
  byWorkType:
    qa: |
      Check all sub-issues.
`)
    const result = loadRepositoryConfig('/some/repo')
    expect(result).not.toBeNull()
    expect(result!.systemPrompt!.append).toContain('Always run verify.')
    expect(result!.systemPrompt!.byWorkType!['qa']).toContain('Check all sub-issues.')
  })
})
