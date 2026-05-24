import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Edge Runtime safety tests for the /middleware subpath.
 *
 * Next.js middleware runs in Edge Runtime which cannot load Node.js
 * built-in modules (crypto, ioredis, etc.). The /middleware subpath
 * must NEVER transitively import these modules.
 *
 * These tests inspect the source code of the middleware barrel and
 * its transitive imports to verify no Node.js-only modules are pulled in.
 */

const FORBIDDEN_NODE_MODULES = [
  'crypto',
  'ioredis',
  'fs',
  'child_process',
  'net',
  'tls',
  'dns',
]

const FORBIDDEN_PACKAGE_IMPORTS = [
  '@donmai/server',
]

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf-8')
}

describe('middleware Edge Runtime safety', () => {
  it('middleware barrel (index.ts) only imports from factory and types', () => {
    const source = readSource('middleware/index.ts')
    const importLines = source.split('\n').filter(line =>
      line.match(/^(?:export|import)\s/) && line.includes('from')
    )

    for (const line of importLines) {
      // Allow imports from ./factory.js and ./types.js only
      expect(line).toMatch(/from\s+['"]\.\/(?:factory|types)\.js['"]/)
    }
  })

  it('middleware factory (factory.ts) does not import Node.js modules', () => {
    const source = readSource('middleware/factory.ts')

    for (const mod of FORBIDDEN_NODE_MODULES) {
      expect(source).not.toMatch(new RegExp(`from\\s+['"]${mod}['"]`))
      expect(source).not.toMatch(new RegExp(`require\\s*\\(\\s*['"]${mod}['"]`))
    }
  })

  it('middleware factory (factory.ts) does not import @donmai/server', () => {
    const source = readSource('middleware/factory.ts')

    for (const pkg of FORBIDDEN_PACKAGE_IMPORTS) {
      expect(source).not.toMatch(new RegExp(`from\\s+['"]${pkg}`))
      expect(source).not.toMatch(new RegExp(`require\\s*\\(\\s*['"]${pkg}`))
    }
  })

  it('middleware types (types.ts) has no runtime imports', () => {
    const source = readSource('middleware/types.ts')

    // types.ts should only have type-level imports (import type) or no imports at all
    const runtimeImports = source.split('\n').filter(line =>
      line.match(/^import\s+(?!type\s)/) && !line.includes('import type')
    )
    expect(runtimeImports).toEqual([])
  })

  it('middleware factory only imports from next/server and local types', () => {
    const source = readSource('middleware/factory.ts')
    const importLines = source.split('\n').filter(line =>
      line.match(/^import\s/) && line.includes('from')
    )

    for (const line of importLines) {
      const fromMatch = line.match(/from\s+['"]([^'"]+)['"]/)
      if (!fromMatch) continue
      const specifier = fromMatch[1]

      // Allow: next/server, ./types.js (relative local imports)
      const isAllowed =
        specifier === 'next/server' ||
        specifier.startsWith('./')
      expect(isAllowed, `Unexpected import: ${specifier}`).toBe(true)
    }
  })
})
