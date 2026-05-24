/**
 * Sync Routes Runner -- Programmatic API for the af-sync-routes CLI.
 *
 * Exports `runSyncRoutes()` so route syncing can be invoked from code
 * without going through process.argv / process.env / process.exit.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import {
  ROUTE_MANIFEST,
  generateRouteContent,
  generatePageContent,
} from '@donmai/core'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SyncRoutesConfig {
  /** Preview what would be created without writing (default: false) */
  dryRun?: boolean
  /** Also sync dashboard page.tsx files (default: false) */
  pages?: boolean
  /** Custom app directory (default: "src/app") */
  appDir?: string
  /** Project root directory (default: process.cwd()) */
  projectRoot?: string
}

export interface SyncRoutesResult {
  checked: number
  created: number
  skipped: number
  errors: Array<{ path: string; error: string }>
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runSyncRoutes(config?: SyncRoutesConfig): SyncRoutesResult {
  const projectRoot = config?.projectRoot ?? process.cwd()
  const appDir = config?.appDir ?? 'src/app'
  const dryRun = config?.dryRun ?? false
  const syncPages = config?.pages ?? false

  const result: SyncRoutesResult = {
    checked: 0,
    created: 0,
    skipped: 0,
    errors: [],
    warnings: [],
  }

  // Validate project structure
  const srcDir = resolve(projectRoot, 'src')
  if (!existsSync(srcDir)) {
    result.errors.push({ path: srcDir, error: 'src/ directory not found — is this a Next.js project?' })
    return result
  }

  const configFile = resolve(projectRoot, 'src/lib/config.ts')
  if (!existsSync(configFile)) {
    result.warnings.push('src/lib/config.ts not found — route files import { routes } from this file')
  }

  // Check for dashboard dependency when syncing pages
  if (syncPages) {
    const pkgJsonPath = resolve(projectRoot, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (!allDeps['@donmai/dashboard']) {
          result.warnings.push('@donmai/dashboard not found in dependencies — page files require this package')
        }
      } catch {
        // Ignore JSON parse errors
      }
    }
  }

  // Sync route files
  for (const entry of ROUTE_MANIFEST.routes) {
    result.checked++
    const filePath = resolve(projectRoot, entry.path)

    if (existsSync(filePath)) {
      result.skipped++
      if (dryRun) {
        console.log(`  exists  ${entry.path}`)
      }
      continue
    }

    const content = generateRouteContent(entry)

    if (dryRun) {
      console.log(`  create  ${entry.path}`)
      result.created++
      continue
    }

    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content, 'utf-8')
      console.log(`  created ${entry.path}`)
      result.created++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push({ path: entry.path, error: message })
    }
  }

  // Sync page files (opt-in)
  if (syncPages) {
    for (const entry of ROUTE_MANIFEST.pages) {
      result.checked++
      const filePath = resolve(projectRoot, entry.path)

      if (existsSync(filePath)) {
        result.skipped++
        if (dryRun) {
          console.log(`  exists  ${entry.path}`)
        }
        continue
      }

      const content = generatePageContent(entry)

      if (dryRun) {
        console.log(`  create  ${entry.path}`)
        result.created++
        continue
      }

      try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, content, 'utf-8')
        console.log(`  created ${entry.path}`)
        result.created++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push({ path: entry.path, error: message })
      }
    }
  }

  return result
}
