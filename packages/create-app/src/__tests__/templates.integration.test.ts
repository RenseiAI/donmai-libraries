import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getTemplates, type TemplateOptions } from '../templates/index.js'

// ── Helpers ────────────────────────────────────────────────────────

function opts(overrides: Partial<TemplateOptions> = {}): TemplateOptions {
  return {
    projectName: 'integration-test-project',
    teamKey: 'TEST',
    includeDashboard: false,
    includeCli: false,
    useRedis: false,
    ...overrides,
  }
}

function writeProject(files: Record<string, string>, dir: string) {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
  }
}

// ── Integration test configs ───────────────────────────────────────

const configs = [
  {
    name: 'full default (dashboard + cli + redis)',
    options: opts({ includeDashboard: true, includeCli: true, useRedis: true }),
  },
  {
    name: 'minimal (no dashboard, no cli, no redis)',
    options: opts({ includeDashboard: false, includeCli: false, useRedis: false }),
  },
]

// Track temp dirs for cleanup
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.each(configs)(
  'integration — $name',
  ({ options }) => {
    const files = getTemplates(options)
    const dir = mkdtempSync(join(tmpdir(), 'create-app-integration-'))
    tempDirs.push(dir)

    writeProject(files, dir)

    it('writes all files to disk', () => {
      const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
      function collect(base: string, prefix = ''): string[] {
        const entries: string[] = []
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            entries.push(...collect(join(base, entry.name), rel))
          } else {
            entries.push(rel)
          }
        }
        return entries
      }
      const written = collect(dir)
      expect(written.sort()).toEqual(Object.keys(files).sort())
    })

    it('generates valid JSON in package.json', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const content = readFileSync(join(dir, 'package.json'), 'utf-8')
      const pkg = JSON.parse(content)
      expect(pkg.name).toBe(options.projectName)
      expect(pkg.version).toBe('0.1.0')
      expect(pkg.scripts).toBeDefined()
      expect(pkg.dependencies).toBeDefined()
      expect(pkg.devDependencies).toBeDefined()
    })

    it('generates valid JSON in tsconfig.json', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const content = readFileSync(join(dir, 'tsconfig.json'), 'utf-8')
      const tsconfig = JSON.parse(content)
      expect(tsconfig.compilerOptions).toBeDefined()
      expect(tsconfig.compilerOptions.target).toBe('ES2017')
      expect(tsconfig.compilerOptions.strict).toBe(true)
      expect(tsconfig.compilerOptions.jsx).toBe('react-jsx')
      expect(tsconfig.compilerOptions.module).toBe('esnext')
      expect(tsconfig.compilerOptions.moduleResolution).toBe('bundler')
      expect(tsconfig.compilerOptions.paths).toEqual({ '@/*': ['./src/*'] })
      expect(tsconfig.include).toContain('**/*.ts')
      expect(tsconfig.include).toContain('**/*.tsx')
      expect(tsconfig.exclude).toContain('node_modules')
    })

    it('generates valid next.config.ts', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const content = readFileSync(join(dir, 'next.config.ts'), 'utf-8')
      expect(content).toContain("import type { NextConfig } from 'next'")
      expect(content).toContain('export default nextConfig')
      if (options.includeDashboard) {
        expect(content).toContain('transpilePackages')
        expect(content).toContain('@donmai/dashboard')
      }
    })

    it('generates a .gitignore with standard entries', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const content = readFileSync(join(dir, '.gitignore'), 'utf-8')
      expect(content).toContain('node_modules/')
      expect(content).toContain('.next/')
      expect(content).toContain('dist/')
    })

    it('route re-exports have valid import structure', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const routeFiles = Object.keys(files).filter(f => f.includes('/route.ts'))
      for (const routeFile of routeFiles) {
        const content = readFileSync(join(dir, routeFile), 'utf-8')
        expect(content, `${routeFile} missing config import`).toContain("import { routes } from '@/lib/config'")
        // Each route must export at least one HTTP method
        const hasExport = content.includes('export const POST') ||
          content.includes('export const GET') ||
          content.includes('export const DELETE')
        expect(hasExport, `${routeFile} missing HTTP method export`).toBe(true)
      }
    })

    if (options.includeDashboard) {
      it('dashboard pages use client directive and DashboardShell', () => {
        const { readFileSync } = require('node:fs') as typeof import('node:fs')
        const dashboardPages = [
          'src/app/pipeline/page.tsx',
          'src/app/sessions/page.tsx',
          'src/app/sessions/[id]/page.tsx',
          'src/app/settings/page.tsx',
        ]
        for (const page of dashboardPages) {
          const content = readFileSync(join(dir, page), 'utf-8')
          expect(content, `${page} missing 'use client'`).toContain("'use client'")
          expect(content, `${page} missing DashboardShell`).toContain('DashboardShell')
        }
      })
    }

    if (options.includeCli) {
      it('CLI scripts have shebang and required imports', () => {
        const { readFileSync } = require('node:fs') as typeof import('node:fs')
        const cliFiles = [
          'cli/worker.ts',
          'cli/orchestrator.ts',
          'cli/worker-fleet.ts',
          'cli/cleanup.ts',
        ]
        for (const cliFile of cliFiles) {
          const content = readFileSync(join(dir, cliFile), 'utf-8')
          expect(content, `${cliFile} missing shebang`).toContain('#!/usr/bin/env tsx')
          expect(content, `${cliFile} missing @renseiai import`).toContain('@donmai/cli')
        }
      })
    }
  },
)
