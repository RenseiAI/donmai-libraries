import { describe, it, expect } from 'vitest'
import { getTemplates, type TemplateOptions } from '../templates/index.js'

// ── Helpers ────────────────────────────────────────────────────────

function opts(overrides: Partial<TemplateOptions> = {}): TemplateOptions {
  return {
    projectName: 'test-project',
    teamKey: 'TEST',
    includeDashboard: false,
    includeCli: false,
    useRedis: false,
    ...overrides,
  }
}

// ── Core files present in every configuration ──────────────────────

const ALWAYS_PRESENT_FILES = [
  'package.json',
  'tsconfig.json',
  'next.config.ts',
  '.env.example',
  '.gitignore',
  'src/lib/config.ts',
  'src/middleware.ts',
  // Route re-exports
  'src/app/webhook/route.ts',
  'src/app/callback/route.ts',
  'src/app/api/workers/register/route.ts',
  'src/app/api/workers/route.ts',
  'src/app/api/workers/[id]/route.ts',
  'src/app/api/workers/[id]/heartbeat/route.ts',
  'src/app/api/workers/[id]/poll/route.ts',
  'src/app/api/sessions/route.ts',
  'src/app/api/sessions/[id]/route.ts',
  'src/app/api/sessions/[id]/claim/route.ts',
  'src/app/api/sessions/[id]/status/route.ts',
  'src/app/api/sessions/[id]/lock-refresh/route.ts',
  'src/app/api/sessions/[id]/prompts/route.ts',
  'src/app/api/sessions/[id]/transfer-ownership/route.ts',
  'src/app/api/sessions/[id]/activity/route.ts',
  'src/app/api/sessions/[id]/completion/route.ts',
  'src/app/api/sessions/[id]/external-urls/route.ts',
  'src/app/api/sessions/[id]/progress/route.ts',
  'src/app/api/sessions/[id]/tool-error/route.ts',
  'src/app/api/public/stats/route.ts',
  'src/app/api/public/sessions/route.ts',
  'src/app/api/public/sessions/[id]/route.ts',
  'src/app/api/public/phase-metrics/route.ts',
  'src/app/api/config/route.ts',
  'src/app/api/cleanup/route.ts',
  'src/app/api/issue-tracker-proxy/route.ts',
  // Layout/page/css always present (dashboard or minimal variant)
  'src/app/layout.tsx',
  'src/app/page.tsx',
  'src/app/globals.css',
  // Agent definitions
  '.claude/CLAUDE.md',
  'AGENTS.md',
  '.claude/agents/developer.md',
]

const DASHBOARD_ONLY_FILES = [
  'src/app/pipeline/page.tsx',
  'src/app/sessions/page.tsx',
  'src/app/sessions/[id]/page.tsx',
  'src/app/settings/page.tsx',
  'postcss.config.mjs',
]

const CLI_ONLY_FILES = [
  'cli/worker.ts',
  'cli/orchestrator.ts',
  'cli/worker-fleet.ts',
  'cli/cleanup.ts',
]

// ── Test matrix: all 8 boolean combinations ────────────────────────

const COMBOS: {
  name: string
  dashboard: boolean
  cli: boolean
  redis: boolean
}[] = [
  { name: 'all flags on',          dashboard: true,  cli: true,  redis: true },
  { name: 'all flags off',         dashboard: false, cli: false, redis: false },
  { name: 'dashboard only',        dashboard: true,  cli: false, redis: false },
  { name: 'cli only',              dashboard: false, cli: true,  redis: false },
  { name: 'dashboard + cli',       dashboard: true,  cli: true,  redis: false },
  { name: 'redis only',            dashboard: false, cli: false, redis: true },
  { name: 'dashboard + redis',     dashboard: true,  cli: false, redis: true },
  { name: 'cli + redis',           dashboard: false, cli: true,  redis: true },
]

// ── Smoke test ─────────────────────────────────────────────────────

describe('getTemplates', () => {
  it('returns a non-empty Record<string, string> for the default config', () => {
    const result = getTemplates(opts({ includeDashboard: true, includeCli: true, useRedis: true }))
    expect(Object.keys(result).length).toBeGreaterThan(0)
    for (const [key, value] of Object.entries(result)) {
      expect(typeof key).toBe('string')
      expect(typeof value).toBe('string')
      expect(key.length).toBeGreaterThan(0)
      expect(value.length).toBeGreaterThan(0)
    }
  })
})

// ── File manifest assertions ───────────────────────────────────────

describe.each(COMBOS)(
  'file manifest — $name (dashboard=$dashboard, cli=$cli, redis=$redis)',
  ({ dashboard, cli, redis }) => {
    const files = getTemplates(opts({ includeDashboard: dashboard, includeCli: cli, useRedis: redis }))
    const filePaths = Object.keys(files)

    it('includes all always-present files', () => {
      for (const f of ALWAYS_PRESENT_FILES) {
        expect(filePaths, `missing: ${f}`).toContain(f)
      }
    })

    it(`${dashboard ? 'includes' : 'excludes'} dashboard-specific files`, () => {
      for (const f of DASHBOARD_ONLY_FILES) {
        if (dashboard) {
          expect(filePaths, `expected dashboard file: ${f}`).toContain(f)
        } else {
          expect(filePaths, `unexpected dashboard file: ${f}`).not.toContain(f)
        }
      }
    })

    it(`${cli ? 'includes' : 'excludes'} CLI-specific files`, () => {
      for (const f of CLI_ONLY_FILES) {
        if (cli) {
          expect(filePaths, `expected CLI file: ${f}`).toContain(f)
        } else {
          expect(filePaths, `unexpected CLI file: ${f}`).not.toContain(f)
        }
      }
    })

    it('contains no unexpected files', () => {
      const expected = new Set([
        ...ALWAYS_PRESENT_FILES,
        ...(dashboard ? DASHBOARD_ONLY_FILES : []),
        ...(cli ? CLI_ONLY_FILES : []),
      ])
      for (const f of filePaths) {
        expect(expected, `unexpected file in output: ${f}`).toContain(f)
      }
    })
  },
)

// ── Dependency version assertions ──────────────────────────────────

describe.each(COMBOS)(
  'generated package.json — $name (dashboard=$dashboard, cli=$cli, redis=$redis)',
  ({ dashboard, cli, redis }) => {
    const files = getTemplates(opts({ includeDashboard: dashboard, includeCli: cli, useRedis: redis }))
    const pkg = JSON.parse(files['package.json'])

    it('has non-stale @donmai/* dependency versions', () => {
      const donmaiDeps = Object.entries(pkg.dependencies as Record<string, string>)
        .filter(([name]) => name.startsWith('@donmai/'))

      expect(donmaiDeps.length).toBeGreaterThan(0)
      for (const [name, version] of donmaiDeps) {
        // Versions must not be the old ^0.7.6
        expect(version, `${name} has stale version ${version}`).not.toBe('^0.7.6')
      }
    })

    it(`${dashboard ? 'includes' : 'excludes'} @donmai/dashboard`, () => {
      if (dashboard) {
        expect(pkg.dependencies).toHaveProperty('@donmai/dashboard')
      } else {
        expect(pkg.dependencies).not.toHaveProperty('@donmai/dashboard')
      }
    })

    it('dashboard dependency version matches other @renseiai/* versions', () => {
      if (!dashboard) return
      const coreVersion = pkg.dependencies['@donmai/core']
      const dashVersion = pkg.dependencies['@donmai/dashboard']
      expect(dashVersion).toBe(coreVersion)
    })

    it(`${dashboard ? 'includes' : 'excludes'} tailwind devDependencies`, () => {
      if (dashboard) {
        expect(pkg.devDependencies).toHaveProperty('@tailwindcss/postcss')
        expect(pkg.devDependencies).toHaveProperty('tailwindcss')
      } else {
        expect(pkg.devDependencies).not.toHaveProperty('@tailwindcss/postcss')
        expect(pkg.devDependencies).not.toHaveProperty('tailwindcss')
      }
    })

    it(`${cli ? 'includes' : 'excludes'} CLI devDependencies (tsx, dotenv)`, () => {
      if (cli) {
        expect(pkg.devDependencies).toHaveProperty('tsx')
        expect(pkg.devDependencies).toHaveProperty('dotenv')
      } else {
        expect(pkg.devDependencies).not.toHaveProperty('tsx')
        expect(pkg.devDependencies).not.toHaveProperty('dotenv')
      }
    })

    it(`${cli ? 'includes' : 'excludes'} CLI scripts`, () => {
      const cliScripts = ['worker', 'orchestrator', 'worker-fleet', 'cleanup']
      for (const s of cliScripts) {
        if (cli) {
          expect(pkg.scripts, `missing script: ${s}`).toHaveProperty(s)
        } else {
          expect(pkg.scripts, `unexpected script: ${s}`).not.toHaveProperty(s)
        }
      }
    })
  },
)

// ── Redis .env.example assertions ──────────────────────────────────

describe.each(COMBOS)(
  '.env.example — $name (dashboard=$dashboard, cli=$cli, redis=$redis)',
  ({ dashboard: _d, cli: _c, redis }) => {
    const files = getTemplates(opts({ includeDashboard: _d, includeCli: _c, useRedis: redis }))
    const envContent = files['.env.example']

    it(`${redis ? 'contains' : 'does not contain'} REDIS_URL`, () => {
      if (redis) {
        expect(envContent).toContain('REDIS_URL')
      } else {
        expect(envContent).not.toContain('REDIS_URL')
      }
    })
  },
)
