/**
 * Manifest / create-app parity test.
 *
 * Verifies that every route/page entry in the manifest has a corresponding
 * file in the create-app template output, and that generated content matches.
 *
 * Imports create-app via its package subpath export (not a relative path)
 * to avoid tsc emitting stray build artifacts alongside the source files.
 */

import { describe, it, expect } from 'vitest'
import { ROUTE_MANIFEST, generateRouteContent, generatePageContent } from '../index.js'
import { getTemplates } from '@donmai/create-app/templates'

const templateFiles = getTemplates({
  projectName: 'test-project',
  teamKey: 'TEST',
  includeDashboard: true,
  includeCli: false,
  useRedis: false,
})

describe('manifest / create-app parity (routes)', () => {
  it('every manifest route has a corresponding template file', () => {
    const missing: string[] = []
    for (const entry of ROUTE_MANIFEST.routes) {
      if (!(entry.path in templateFiles)) {
        missing.push(entry.path)
      }
    }
    expect(missing).toEqual([])
  })

  it('every template route file has a corresponding manifest entry', () => {
    const manifestPaths = new Set(ROUTE_MANIFEST.routes.map((r) => r.path))
    const extra: string[] = []
    for (const path of Object.keys(templateFiles)) {
      if (path.endsWith('route.ts') && !manifestPaths.has(path)) {
        extra.push(path)
      }
    }
    expect(extra).toEqual([])
  })

  it('generated route content matches template content', () => {
    const mismatches: string[] = []
    for (const entry of ROUTE_MANIFEST.routes) {
      const generated = generateRouteContent(entry)
      const template = templateFiles[entry.path]
      if (template && generated !== template) {
        mismatches.push(
          `${entry.path}:\n  generated: ${JSON.stringify(generated)}\n  template:  ${JSON.stringify(template)}`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('manifest / create-app parity (pages)', () => {
  it('every manifest page has a corresponding template file', () => {
    const missing: string[] = []
    for (const entry of ROUTE_MANIFEST.pages) {
      if (!(entry.path in templateFiles)) {
        missing.push(entry.path)
      }
    }
    expect(missing).toEqual([])
  })

  it('every template dashboard page has a corresponding manifest entry', () => {
    const manifestPaths = new Set(ROUTE_MANIFEST.pages.map((p) => p.path))
    const extra: string[] = []
    for (const path of Object.keys(templateFiles)) {
      if (path.endsWith('page.tsx') && templateFiles[path].includes('DashboardShell') && !manifestPaths.has(path)) {
        extra.push(path)
      }
    }
    expect(extra).toEqual([])
  })

  it('generated page content matches template content', () => {
    const mismatches: string[] = []
    for (const entry of ROUTE_MANIFEST.pages) {
      const generated = generatePageContent(entry)
      const template = templateFiles[entry.path]
      if (template && generated !== template) {
        mismatches.push(
          `${entry.path}:\n  generated: ${JSON.stringify(generated)}\n  template:  ${JSON.stringify(template)}`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })
})
