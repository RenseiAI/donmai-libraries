import { describe, it, expect } from 'vitest'
import {
  ROUTE_MANIFEST,
  generateRouteContent,
  generatePageContent,
} from '../index.js'

describe('ROUTE_MANIFEST', () => {
  it('has the expected number of route entries', () => {
    expect(ROUTE_MANIFEST.routes.length).toBe(26)
  })

  it('has the expected number of page entries', () => {
    expect(ROUTE_MANIFEST.pages.length).toBe(5)
  })

  it('all route paths start with src/app/ and end with route.ts', () => {
    for (const entry of ROUTE_MANIFEST.routes) {
      expect(entry.path).toMatch(/^src\/app\/.*route\.ts$/)
    }
  })

  it('all page paths start with src/app/ and end with page.tsx', () => {
    for (const entry of ROUTE_MANIFEST.pages) {
      expect(entry.path).toMatch(/^src\/app\/.*page\.tsx$/)
    }
  })

  it('all route method accessors match routes.* pattern', () => {
    for (const entry of ROUTE_MANIFEST.routes) {
      for (const accessor of Object.values(entry.methods)) {
        expect(accessor).toMatch(/^routes\.\w+/)
      }
    }
  })

  it('has no duplicate route paths', () => {
    const paths = ROUTE_MANIFEST.routes.map((r) => r.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('has no duplicate page paths', () => {
    const paths = ROUTE_MANIFEST.pages.map((p) => p.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('every route has at least one method', () => {
    for (const entry of ROUTE_MANIFEST.routes) {
      expect(Object.keys(entry.methods).length).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('generateRouteContent', () => {
  it('generates a single-method route', () => {
    const content = generateRouteContent({
      path: 'src/app/api/test/route.ts',
      methods: { POST: 'routes.test.POST' },
    })
    expect(content).toBe(
      `import { routes } from '@/lib/config'\nexport const POST = routes.test.POST\n`,
    )
  })

  it('generates a multi-method route with correct order', () => {
    const content = generateRouteContent({
      path: 'src/app/api/test/route.ts',
      methods: { GET: 'routes.test.GET', POST: 'routes.test.POST', DELETE: 'routes.test.DELETE' },
    })
    expect(content).toBe(
      `import { routes } from '@/lib/config'\nexport const POST = routes.test.POST\nexport const GET = routes.test.GET\nexport const DELETE = routes.test.DELETE\n`,
    )
  })

  it('generates a GET-only route (no POST)', () => {
    const content = generateRouteContent({
      path: 'src/app/callback/route.ts',
      methods: { GET: 'routes.oauth.callback.GET' },
    })
    expect(content).toBe(
      `import { routes } from '@/lib/config'\nexport const GET = routes.oauth.callback.GET\n`,
    )
  })
})

describe('generatePageContent', () => {
  it('generates a simple dashboard page', () => {
    const content = generatePageContent({
      path: 'src/app/pipeline/page.tsx',
      component: 'PipelinePage',
      exportName: 'Pipeline',
    })
    expect(content).toContain(`'use client'`)
    expect(content).toContain(`import { DashboardShell, PipelinePage } from '@donmai/dashboard'`)
    expect(content).toContain(`import { usePathname } from 'next/navigation'`)
    expect(content).toContain(`export default function Pipeline()`)
    expect(content).toContain(`<PipelinePage />`)
    expect(content).not.toContain('useParams')
  })

  it('generates a page with import alias', () => {
    const content = generatePageContent({
      path: 'src/app/page.tsx',
      component: 'DashboardPage',
      exportName: 'DashboardPage',
      importAlias: 'DashboardPage as FleetPage',
    })
    expect(content).toContain(`import { DashboardShell, DashboardPage as FleetPage } from '@donmai/dashboard'`)
    expect(content).toContain(`<FleetPage />`)
  })

  it('generates a page with params and prop mapping', () => {
    const content = generatePageContent({
      path: 'src/app/sessions/[id]/page.tsx',
      component: 'SessionPage',
      exportName: 'SessionDetailPage',
      params: ['id'],
      propMapping: { id: 'sessionId' },
    })
    expect(content).toContain(`import { usePathname, useParams } from 'next/navigation'`)
    expect(content).toContain(`useParams<{ id: string }>()`)
    expect(content).toContain(`<SessionPage sessionId={params.id} />`)
    expect(content).toContain(`export default function SessionDetailPage()`)
  })
})
