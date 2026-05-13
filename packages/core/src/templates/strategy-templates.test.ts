import { describe, it, expect, beforeEach } from 'vitest'
import { TemplateRegistry } from './registry.js'
import type { WorkflowTemplate, TemplateContext } from './types.js'

describe('Strategy-Aware Template Selection', () => {
  describe('strategy-specific template loading', () => {
    it('loads strategy-specific templates from built-in defaults', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const workTypes = registry.getRegisteredWorkTypes()

      // Should include strategy-specific compound keys
      expect(workTypes).toContain('refinement-context-enriched')
      expect(workTypes).toContain('refinement-decompose')
      expect(workTypes).toContain('development-retry')
      expect(workTypes).toContain('qa-retry')
      expect(workTypes).toContain('qa-native')

      // Should still include base work types
      expect(workTypes).toContain('development')
      expect(workTypes).toContain('qa')
      expect(workTypes).toContain('refinement')
    })
  })

  describe('getTemplate with strategy parameter', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('returns strategy-specific template when strategy is provided', () => {
      const template = registry.getTemplate('refinement', 'context-enriched')
      expect(template).toBeDefined()
      expect(template!.metadata.name).toBe('refinement-context-enriched')
      expect(template!.metadata.workType).toBe('refinement')
    })

    it('returns decompose strategy template', () => {
      const template = registry.getTemplate('refinement', 'decompose')
      expect(template).toBeDefined()
      expect(template!.metadata.name).toBe('refinement-decompose')
    })

    it('returns development-retry strategy template', () => {
      const template = registry.getTemplate('development', 'retry')
      expect(template).toBeDefined()
      expect(template!.metadata.name).toBe('development-retry')
    })

    it('returns qa-retry strategy template', () => {
      const template = registry.getTemplate('qa', 'retry')
      expect(template).toBeDefined()
      expect(template!.metadata.name).toBe('qa-retry')
    })

    it('falls back to base template when strategy template does not exist', () => {
      const template = registry.getTemplate('refinement', 'nonexistent-strategy')
      expect(template).toBeDefined()
      expect(template!.metadata.name).toBe('refinement')
      expect(template!.metadata.workType).toBe('refinement')
    })

    it('falls back to base template when strategy is undefined', () => {
      const template = registry.getTemplate('refinement')
      expect(template).toBeDefined()
      expect(template!.metadata.name).toBe('refinement')
    })

    it('returns undefined when neither strategy nor base template exists', () => {
      const emptyRegistry = TemplateRegistry.create({ useBuiltinDefaults: false })
      expect(emptyRegistry.getTemplate('refinement', 'context-enriched')).toBeUndefined()
    })
  })

  describe('hasTemplate with strategy parameter', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('returns true for existing strategy template', () => {
      expect(registry.hasTemplate('refinement', 'context-enriched')).toBe(true)
    })

    it('returns true when strategy template does not exist but base does', () => {
      expect(registry.hasTemplate('refinement', 'nonexistent')).toBe(true)
    })

    it('returns false when no templates exist for work type', () => {
      const emptyRegistry = TemplateRegistry.create({ useBuiltinDefaults: false })
      expect(emptyRegistry.hasTemplate('refinement', 'context-enriched')).toBe(false)
    })
  })

  describe('renderPrompt with strategy', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('renders strategy-specific template with WorkflowState context variables', () => {
      const context: TemplateContext = {
        identifier: 'SUP-100',
        cycleCount: 3,
        strategy: 'context-enriched',
        failureSummary: 'Tests failed: missing null check in handler',
      }

      const result = registry.renderPrompt('refinement', context, 'context-enriched')
      expect(result).toContain('SUP-100')
      expect(result).toContain('FAILED QA 3 times')
      expect(result).toContain('context-enriched retry')
      expect(result).toContain('missing null check in handler')
      expect(result).toContain('ROOT CAUSE')
    })

    it('renders decompose template with failure history', () => {
      const context: TemplateContext = {
        identifier: 'SUP-200',
        cycleCount: 4,
        failureSummary: 'Multiple subsystems failing independently',
        team: 'Engineering',
        linearCli: 'rensei linear',
        packageManager: 'pnpm',
      }

      const result = registry.renderPrompt('refinement', context, 'decompose')
      expect(result).toContain('SUP-200')
      expect(result).toContain('FAILED QA 4 times')
      expect(result).toContain('DECOMPOSE')
      expect(result).toContain('Multiple subsystems failing independently')
      expect(result).toContain('rensei linear create-issue')
    })

    it('renders development-retry template with previous failure reasons', () => {
      const context: TemplateContext = {
        identifier: 'SUP-300',
        attemptNumber: 3,
        previousFailureReasons: [
          'TypeScript error in utils.ts',
          'Missing import statement',
        ],
        failureSummary: 'Two previous attempts failed due to type errors',
      }

      const result = registry.renderPrompt('development', context, 'retry')
      expect(result).toContain('SUP-300')
      expect(result).toContain('attempt 3')
      expect(result).toContain('DO NOT REPEAT THESE MISTAKES')
      expect(result).toContain('TypeScript error in utils.ts')
      expect(result).toContain('Missing import statement')
      expect(result).toContain('Two previous attempts failed')
    })

    it('renders qa-retry template with previous QA failures', () => {
      const context: TemplateContext = {
        identifier: 'SUP-400',
        attemptNumber: 2,
        previousFailureReasons: [
          'Test suite timeout on large fixture',
        ],
      }

      const result = registry.renderPrompt('qa', context, 'retry')
      expect(result).toContain('SUP-400')
      expect(result).toContain('QA attempt 2')
      expect(result).toContain('Test suite timeout on large fixture')
      expect(result).toContain('WORK_RESULT')
    })

    it('falls back to base template when strategy template not found', () => {
      const context: TemplateContext = {
        identifier: 'SUP-500',
        cycleCount: 1,
      }

      const result = registry.renderPrompt('refinement', context, 'unknown-strategy')
      expect(result).toContain('SUP-500')
      // Should render the base refinement template, which has "Refine" in the prompt
      expect(result).toContain('Refine')
    })

    it('returns null when no template found for work type or strategy', () => {
      const emptyRegistry = TemplateRegistry.create({ useBuiltinDefaults: false })
      const result = emptyRegistry.renderPrompt('refinement', { identifier: 'SUP-1' }, 'context-enriched')
      expect(result).toBeNull()
    })

    it('renders template without failureSummary showing fallback text', () => {
      const context: TemplateContext = {
        identifier: 'SUP-600',
        cycleCount: 2,
      }

      const result = registry.renderPrompt('refinement', context, 'context-enriched')
      expect(result).toContain('No failure details available.')
    })

    it('renders development-retry without previousFailureReasons', () => {
      const context: TemplateContext = {
        identifier: 'SUP-700',
        attemptNumber: 2,
      }

      const result = registry.renderPrompt('development', context, 'retry')
      expect(result).toContain('SUP-700')
      expect(result).toContain('attempt 2')
      // Should not contain the "Previous Failures" section
      expect(result).not.toContain('DO NOT REPEAT THESE MISTAKES')
    })
  })

  describe('getToolPermissions with strategy', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('returns strategy-specific tool permissions', () => {
      const perms = registry.getToolPermissions('refinement', 'context-enriched')
      expect(perms).toBeDefined()
      // Strategy template allows pnpm, git commit, git diff, git log
      expect(perms!.length).toBeGreaterThanOrEqual(4)
    })

    it('falls back to base template tool permissions when strategy not found', () => {
      const perms = registry.getToolPermissions('refinement', 'nonexistent')
      expect(perms).toBeDefined()
      // Base refinement template allows `rensei linear *`
      expect(perms!.some(p => p.includes('rensei linear'))).toBe(true)
    })
  })

  describe('getDisallowedTools with strategy', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('returns strategy-specific disallowed tools', () => {
      const disallowed = registry.getDisallowedTools('refinement', 'context-enriched')
      expect(disallowed).toBeDefined()
      expect(disallowed).toContain('user-input')
    })

    it('falls back to base template disallowed tools when strategy not found', () => {
      const disallowed = registry.getDisallowedTools('refinement', 'nonexistent')
      expect(disallowed).toBeDefined()
      expect(disallowed).toContain('user-input')
    })
  })

  describe('inline strategy template override', () => {
    it('supports strategy templates via inline config', () => {
      const customStrategyTemplate: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'development-retry', workType: 'development' },
        prompt: 'Custom retry for {{identifier}} attempt {{attemptNumber}}.',
      }

      const registry = TemplateRegistry.create({
        useBuiltinDefaults: false,
        templates: { 'development-retry': customStrategyTemplate } as Record<string, WorkflowTemplate>,
      })

      const result = registry.renderPrompt('development', {
        identifier: 'SUP-1',
        attemptNumber: 3,
      }, 'retry')
      expect(result).toBe('Custom retry for SUP-1 attempt 3.')
    })

    it('inline strategy template overrides built-in strategy template', () => {
      const customTemplate: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'refinement-context-enriched', workType: 'refinement' },
        prompt: 'Overridden: {{identifier}} cycle {{cycleCount}}.',
      }

      const registry = TemplateRegistry.create({
        useBuiltinDefaults: true,
        templates: { 'refinement-context-enriched': customTemplate } as Record<string, WorkflowTemplate>,
      })

      const result = registry.renderPrompt('refinement', {
        identifier: 'SUP-1',
        cycleCount: 5,
      }, 'context-enriched')
      expect(result).toBe('Overridden: SUP-1 cycle 5.')
    })
  })

  describe('new TemplateContext variables', () => {
    it('cycleCount is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Cycle: {{cycleCount}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', { identifier: 'X', cycleCount: 3 })
      expect(result).toBe('Cycle: 3')
    })

    it('strategy is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Strategy: {{strategy}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', { identifier: 'X', strategy: 'context-enriched' })
      expect(result).toBe('Strategy: context-enriched')
    })

    it('failureSummary with triple-stache renders unescaped HTML', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: '{{{failureSummary}}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', {
        identifier: 'X',
        failureSummary: '**Bold** and <code>inline</code>',
      })
      expect(result).toBe('**Bold** and <code>inline</code>')
    })

    it('attemptNumber is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Attempt {{attemptNumber}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', { identifier: 'X', attemptNumber: 2 })
      expect(result).toBe('Attempt 2')
    })

    it('previousFailureReasons are iterable via #each', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: '{{#each previousFailureReasons}}{{this}};{{/each}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', {
        identifier: 'X',
        previousFailureReasons: ['reason1', 'reason2'],
      })
      expect(result).toBe('reason1;reason2;')
    })

    it('totalCostUsd is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Cost: ${{totalCostUsd}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', { identifier: 'X', totalCostUsd: 1.5 })
      expect(result).toBe('Cost: $1.5')
    })

    it('blockerIdentifier is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Blocker: {{blockerIdentifier}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', { identifier: 'X', blockerIdentifier: 'SUP-999' })
      expect(result).toBe('Blocker: SUP-999')
    })

    it('team is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Team: {{team}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', { identifier: 'X', team: 'Engineering' })
      expect(result).toBe('Team: Engineering')
    })
  })

  describe('governor notification partials', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('renders review-request partial', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test-gov', workType: 'development' },
        prompt: '{{> partials/governor/review-request}}',
      }
      registry.initialize({ useBuiltinDefaults: true, templates: { development: template } })

      const result = registry.renderPrompt('development', {
        identifier: 'SUP-1',
        cycleCount: 3,
        failureSummary: 'Tests keep failing on auth module',
        totalCostUsd: 2.50,
      })

      expect(result).toContain('Review Requested: Repeated QA Failure')
      expect(result).toContain('3 development cycles')
      expect(result).toContain('Tests keep failing on auth module')
      expect(result).toContain('$2.5')
      expect(result).toContain('HOLD')
      expect(result).toContain('DECOMPOSE')
    })

    it('renders review-request partial without failure summary', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test-gov', workType: 'development' },
        prompt: '{{> partials/governor/review-request}}',
      }
      registry.initialize({ useBuiltinDefaults: true, templates: { development: template } })

      const result = registry.renderPrompt('development', {
        identifier: 'SUP-1',
        cycleCount: 2,
      })

      expect(result).toContain('No failure details available.')
    })

    it('renders decomposition-proposal partial', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test-gov', workType: 'development' },
        prompt: '{{> partials/governor/decomposition-proposal}}',
      }
      registry.initialize({ useBuiltinDefaults: true, templates: { development: template } })

      const result = registry.renderPrompt('development', {
        identifier: 'SUP-1',
        cycleCount: 4,
        totalCostUsd: 5.00,
      })

      expect(result).toContain('Decomposition Proposed')
      expect(result).toContain('failed QA 4 times')
      expect(result).toContain('$5')
      expect(result).toContain('HOLD')
    })

    it('renders escalation-alert partial', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test-gov', workType: 'development' },
        prompt: '{{> partials/governor/escalation-alert}}',
      }
      registry.initialize({ useBuiltinDefaults: true, templates: { development: template } })

      const result = registry.renderPrompt('development', {
        identifier: 'SUP-1',
        cycleCount: 5,
        totalCostUsd: 10.00,
        blockerIdentifier: 'SUP-999',
        failureSummary: 'All automated retries exhausted',
      })

      expect(result).toContain('Human Intervention Required')
      expect(result).toContain('5 cycles')
      expect(result).toContain('$10')
      expect(result).toContain('SUP-999')
      expect(result).toContain('All automated retries exhausted')
    })

    it('renders escalation-alert without blocker identifier', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test-gov', workType: 'development' },
        prompt: '{{> partials/governor/escalation-alert}}',
      }
      registry.initialize({ useBuiltinDefaults: true, templates: { development: template } })

      const result = registry.renderPrompt('development', {
        identifier: 'SUP-1',
        cycleCount: 5,
      })

      expect(result).toContain('Human Intervention Required')
      expect(result).not.toContain('blocker has been created')
      expect(result).toContain('No failure details recorded.')
    })
  })

  describe('qa-native strategy template', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('loads qa-native as a strategy template', () => {
      const template = registry.getTemplate('qa', 'native')
      expect(template).toBeDefined()
      expect(template!.metadata.name).toBe('qa-native')
      expect(template!.metadata.workType).toBe('qa')
    })

    it('renders qa-native template with identifier', () => {
      const context: TemplateContext = {
        identifier: 'SUP-800',
      }

      const result = registry.renderPrompt('qa', context, 'native')
      expect(result).toContain('SUP-800')
      expect(result).toContain('native/compiled project')
      expect(result).toContain('WORK_RESULT')
      expect(result).toContain('Build verification')
      expect(result).toContain('memory safety')
    })

    it('renders qa-native with custom build commands', () => {
      const context: TemplateContext = {
        identifier: 'SUP-801',
        buildCommand: 'cargo build --release',
        testCommand: 'cargo test',
        validateCommand: 'cargo clippy -- -D warnings',
      }

      const result = registry.renderPrompt('qa', context, 'native')
      expect(result).toContain('cargo build --release')
      expect(result).toContain('cargo test')
      expect(result).toContain('cargo clippy -- -D warnings')
    })

    it('renders qa-native with auto-detect fallback when no commands provided', () => {
      const context: TemplateContext = {
        identifier: 'SUP-802',
      }

      const result = registry.renderPrompt('qa', context, 'native')
      expect(result).toContain('Detect the build system')
      expect(result).toContain('Detect the test framework')
    })

    it('includes native-specific tool permissions', () => {
      const perms = registry.getToolPermissions('qa', 'native')
      expect(perms).toBeDefined()
      expect(perms!.some(p => p.includes('cargo') || p.includes('make') || p.includes('cmake'))).toBe(true)
    })

    it('disallows user-input in native QA template', () => {
      const disallowed = registry.getDisallowedTools('qa', 'native')
      expect(disallowed).toBeDefined()
      expect(disallowed).toContain('user-input')
    })
  })

  describe('configurable build/test commands in base qa template', () => {
    let registry: TemplateRegistry

    beforeEach(() => {
      registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    })

    it('renders base qa template with custom buildCommand', () => {
      const context: TemplateContext = {
        identifier: 'SUP-900',
        buildCommand: 'make -j8',
      }

      const result = registry.renderPrompt('qa', context)
      expect(result).toContain('`make -j8`')
      expect(result).toContain('WORK_RESULT')
    })

    it('renders base qa template with custom testCommand', () => {
      const context: TemplateContext = {
        identifier: 'SUP-901',
        testCommand: 'go test ./...',
      }

      const result = registry.renderPrompt('qa', context)
      expect(result).toContain('`go test ./...`')
    })

    it('renders base qa template with custom validateCommand', () => {
      const context: TemplateContext = {
        identifier: 'SUP-902',
        validateCommand: 'cargo clippy',
      }

      const result = registry.renderPrompt('qa', context)
      expect(result).toContain('`cargo clippy`')
    })

    it('uses pnpm defaults when no custom commands provided', () => {
      const context: TemplateContext = {
        identifier: 'SUP-903',
        packageManager: 'pnpm',
      }

      const result = registry.renderPrompt('qa', context)
      expect(result).toContain('`pnpm typecheck` or `pnpm build`')
      // Should NOT contain custom command sections
      expect(result).not.toContain('Build: `')
    })

    it('uses custom buildCommand in HARD FAIL RULE when provided', () => {
      const context: TemplateContext = {
        identifier: 'SUP-904',
        buildCommand: 'cmake --build build',
      }

      const result = registry.renderPrompt('qa', context)
      expect(result).toContain('`cmake --build build`')
      // Should NOT contain the pnpm default in the hard fail rule
      expect(result).not.toContain('`pnpm typecheck` or `pnpm build`')
    })
  })

  describe('build/test command context variables', () => {
    it('buildCommand is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Build: {{buildCommand}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', {
        identifier: 'X',
        buildCommand: 'cargo build',
      })
      expect(result).toBe('Build: cargo build')
    })

    it('testCommand is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Test: {{testCommand}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', {
        identifier: 'X',
        testCommand: 'go test ./...',
      })
      expect(result).toBe('Test: go test ./...')
    })

    it('validateCommand is available in templates', () => {
      const registry = new TemplateRegistry()
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test', workType: 'development' },
        prompt: 'Validate: {{validateCommand}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      const result = registry.renderPrompt('development', {
        identifier: 'X',
        validateCommand: 'cargo clippy',
      })
      expect(result).toBe('Validate: cargo clippy')
    })
  })

  describe('native-build-validation partial', () => {
    it('renders native-build-validation partial', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'test-native', workType: 'development' },
        prompt: '{{> partials/native-build-validation}}',
      }
      registry.initialize({ useBuiltinDefaults: true, templates: { development: template } })

      const result = registry.renderPrompt('development', { identifier: 'SUP-1' })
      expect(result).toContain('NATIVE BUILD VALIDATION')
      expect(result).toContain('Cargo.toml')
      expect(result).toContain('CMakeLists.txt')
      expect(result).toContain('go.mod')
      expect(result).toContain('Memory safety')
    })
  })
})
