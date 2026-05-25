import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSyncRoutes } from '../sync-routes-runner.js'

describe('runSyncRoutes', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'af-sync-routes-'))
    // Create minimal project structure
    mkdirSync(join(tmpDir, 'src/lib'), { recursive: true })
    writeFileSync(join(tmpDir, 'src/lib/config.ts'), 'export const routes = {}')
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ dependencies: {} }))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates missing route files', () => {
    const result = runSyncRoutes({ projectRoot: tmpDir })

    expect(result.checked).toBeGreaterThan(0)
    expect(result.created).toBeGreaterThan(0)
    expect(result.errors).toHaveLength(0)

    // Verify a route file was created
    const webhookRoute = join(tmpDir, 'src/app/webhook/route.ts')
    expect(existsSync(webhookRoute)).toBe(true)

    const content = readFileSync(webhookRoute, 'utf-8')
    expect(content).toContain("import { routes } from '@/lib/config'")
    expect(content).toContain('export const POST = routes.webhook.POST')
  })

  it('never overwrites existing files', () => {
    // Pre-create a route file with custom content
    const routeDir = join(tmpDir, 'src/app/webhook')
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(join(routeDir, 'route.ts'), '// custom content\n')

    const result = runSyncRoutes({ projectRoot: tmpDir })

    // The pre-existing file should be skipped
    const content = readFileSync(join(routeDir, 'route.ts'), 'utf-8')
    expect(content).toBe('// custom content\n')
    expect(result.skipped).toBeGreaterThan(0)
  })

  it('dry-run writes nothing', () => {
    const result = runSyncRoutes({ projectRoot: tmpDir, dryRun: true })

    expect(result.created).toBeGreaterThan(0)
    expect(result.errors).toHaveLength(0)

    // No files should actually be created
    const webhookRoute = join(tmpDir, 'src/app/webhook/route.ts')
    expect(existsSync(webhookRoute)).toBe(false)
  })

  it('errors if src/ directory is missing', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'af-sync-empty-'))
    try {
      const result = runSyncRoutes({ projectRoot: emptyDir })
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].error).toContain('src/ directory not found')
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('warns if config.ts is missing', () => {
    // Remove the config file we created in beforeEach
    rmSync(join(tmpDir, 'src/lib/config.ts'))

    const result = runSyncRoutes({ projectRoot: tmpDir })
    expect(result.warnings).toContain('src/lib/config.ts not found — route files import { routes } from this file')
  })

  it('skips pages by default', () => {
    const result = runSyncRoutes({ projectRoot: tmpDir })

    // Page files should not be created without --pages flag
    const pipelinePage = join(tmpDir, 'src/app/pipeline/page.tsx')
    expect(existsSync(pipelinePage)).toBe(false)
  })

  it('syncs pages when --pages is set', () => {
    // Add dashboard dependency to package.json
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { '@donmai/dashboard': '^0.8.4' } }),
    )

    const result = runSyncRoutes({ projectRoot: tmpDir, pages: true })

    const pipelinePage = join(tmpDir, 'src/app/pipeline/page.tsx')
    expect(existsSync(pipelinePage)).toBe(true)

    const content = readFileSync(pipelinePage, 'utf-8')
    expect(content).toContain("'use client'")
    expect(content).toContain('PipelinePage')
  })

  it('warns if dashboard dependency is missing when syncing pages', () => {
    const result = runSyncRoutes({ projectRoot: tmpDir, pages: true })
    expect(result.warnings).toContain(
      '@donmai/dashboard not found in dependencies — page files require this package',
    )
  })
})
