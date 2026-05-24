/**
 * Content generators for route and page files.
 *
 * Produces output identical to the create-app templates so that
 * af-sync-routes can fill in missing files without drift.
 */

import type { RouteEntry, PageEntry } from './route-manifest.js'

/**
 * Generate the content for a route.ts re-export file.
 *
 * Output matches the `routeReexport()` helper in create-app templates.
 */
export function generateRouteContent(entry: RouteEntry): string {
  const lines = [`import { routes } from '@/lib/config'`]
  // Maintain consistent ordering: POST, GET, DELETE
  if (entry.methods.POST) lines.push(`export const POST = ${entry.methods.POST}`)
  if (entry.methods.GET) lines.push(`export const GET = ${entry.methods.GET}`)
  if (entry.methods.DELETE) lines.push(`export const DELETE = ${entry.methods.DELETE}`)
  return lines.join('\n') + '\n'
}

/**
 * Generate the content for a dashboard page.tsx file.
 *
 * Output matches the dashboard page helpers in create-app templates.
 */
export function generatePageContent(entry: PageEntry): string {
  const hasParams = entry.params && entry.params.length > 0

  // Build import statement
  const importName = entry.importAlias ?? entry.component
  const imports = [`import { DashboardShell, ${importName} } from '@donmai/dashboard'`]
  imports.push(`import { usePathname${hasParams ? ', useParams' : ''} } from 'next/navigation'`)

  // Build component body
  const bodyLines: string[] = []
  bodyLines.push(`  const pathname = usePathname()`)

  if (hasParams) {
    const paramType = entry.params!.map((p) => `${p}: string`).join('; ')
    bodyLines.push(`  const params = useParams<{ ${paramType} }>()`)
  }

  // Build the inner component JSX
  const componentName = entry.importAlias
    ? entry.importAlias.split(' as ')[1].trim()
    : entry.component

  let propsStr = ''
  if (hasParams && entry.propMapping) {
    const props = Object.entries(entry.propMapping)
      .map(([param, prop]) => `${prop}={params.${param}}`)
      .join(' ')
    propsStr = ` ${props}`
  }

  return `'use client'

${imports.join('\n')}

export default function ${entry.exportName}() {
${bodyLines.join('\n')}
  return (
    <DashboardShell currentPath={pathname}>
      <${componentName}${propsStr} />
    </DashboardShell>
  )
}
`
}
