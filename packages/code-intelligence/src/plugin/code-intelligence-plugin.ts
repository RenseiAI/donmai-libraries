import { readFile, readdir, stat as fsStat } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'
import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { SymbolExtractor } from '../parser/symbol-extractor.js'
import { IncrementalIndexer } from '../indexing/incremental-indexer.js'
import { SearchEngine } from '../search/search-engine.js'
import { HybridSearchEngine } from '../search/hybrid-search.js'
import { RepoMapGenerator } from '../repo-map/repo-map-generator.js'
import { DedupPipeline } from '../memory/dedup-pipeline.js'
import { InMemoryStore } from '../memory/memory-store.js'
import type { FileReservationDelegate } from './file-reservation-delegate.js'

// ---------------------------------------------------------------------------
// Tool plugin types (structurally identical to @renseiai/agentfactory)
// Defined locally to avoid compile-time dependency on core.
// ---------------------------------------------------------------------------

/** A plugin that contributes agent tools from CLI functionality */
export interface ToolPlugin {
  name: string
  description: string
  createTools(context: ToolPluginContext): SdkMcpToolDefinition<any>[]
}

/** Context passed to plugins during tool creation */
export interface ToolPluginContext {
  env: Record<string, string>
  cwd: string
  /** Optional file reservation delegate. When absent, reservation tools are not registered. */
  fileReservation?: FileReservationDelegate
}

// ── Shared constants for file discovery ─────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs',
])

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', '.turbo',
  'build', 'coverage', '__pycache__', '.donmai',
  '.worktrees', 'vendor', 'target',
])

async function discoverFiles(cwd: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name))) {
        try {
          const s = await fsStat(fullPath)
          if (s.size > 512 * 1024) continue
          const content = await readFile(fullPath, 'utf-8')
          files.set(relative(cwd, fullPath), content)
        } catch { /* skip */ }
      }
    }
  }

  await walk(cwd)
  return files
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── In-process type usage finder ────────────────────────────────────────────

interface TypeUsage {
  filePath: string
  line: number
  context: string
  kind: 'switch_case' | 'mapping_object' | 'import' | 'type_reference' | 'exhaustive_check'
}

async function findTypeUsagesInProcess(
  cwd: string,
  typeName: string,
  maxResults: number,
): Promise<{
  typeName: string
  totalUsages: number
  usages: TypeUsage[]
  switchStatements: number
  mappingObjects: number
}> {
  const files = await discoverFiles(cwd)
  const usages: TypeUsage[] = []
  const escaped = escapeRegex(typeName)

  for (const [filePath, content] of files) {
    if (!content.includes(typeName)) continue
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.match(/\bimport\b/) && line.includes(typeName)) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'import' })
        continue
      }

      if (/switch\s*\(/.test(line)) {
        const windowEnd = Math.min(lines.length - 1, i + 50)
        const window = lines.slice(i, windowEnd + 1).join('\n')
        if (window.includes(typeName) || lines.slice(i, windowEnd + 1).some(l => /case\s+['"]/.test(l))) {
          // Check if the switch variable is typed as our target
          const switchWindow = lines.slice(Math.max(0, i - 5), i + 1).join('\n')
          if (switchWindow.includes(typeName) || window.includes(typeName)) {
            usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'switch_case' })
          }
        }
      }

      if (new RegExp(`Record<\\s*${escaped}|satisfies\\s+Record<\\s*${escaped}`).test(line)) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'mapping_object' })
      }

      if ((line.includes('assertNever') || line.includes('exhaustive')) && content.includes(typeName)) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'exhaustive_check' })
      }

      if (
        (line.includes(`type ${typeName}`) || line.includes(`interface ${typeName}`) ||
          new RegExp(`:\\s*${escaped}\\b`).test(line)) &&
        !line.match(/\bimport\b/)
      ) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'type_reference' })
      }
    }
  }

  const kindPriority: Record<string, number> = {
    switch_case: 0, mapping_object: 1, exhaustive_check: 2, type_reference: 3, import: 4,
  }
  usages.sort((a, b) => (kindPriority[a.kind] ?? 5) - (kindPriority[b.kind] ?? 5))

  return {
    typeName,
    totalUsages: usages.length,
    usages: usages.slice(0, maxResults),
    switchStatements: usages.filter(u => u.kind === 'switch_case').length,
    mappingObjects: usages.filter(u => u.kind === 'mapping_object').length,
  }
}

// ── Import line classification ──────────────────────────────────────────────

interface ImportParseState {
  inBlockComment: boolean
  inTemplateLiteral: boolean
}

function isRealImportLine(
  line: string,
  state: ImportParseState,
): { real: boolean; state: ImportParseState } {
  const trimmed = line.trim()

  if (state.inBlockComment) {
    if (trimmed.includes('*/')) {
      return { real: false, state: { ...state, inBlockComment: false } }
    }
    return { real: false, state }
  }
  if (trimmed.startsWith('/*')) {
    const closesOnSameLine = trimmed.includes('*/')
    return { real: false, state: { ...state, inBlockComment: !closesOnSameLine } }
  }

  if (state.inTemplateLiteral) {
    const backtickCount = countUnescapedBackticks(line)
    if (backtickCount % 2 === 1) {
      return { real: false, state: { ...state, inTemplateLiteral: false } }
    }
    return { real: false, state }
  }

  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return { real: false, state }

  const backticks = countUnescapedBackticks(line)
  if (backticks % 2 === 1) {
    const importIdx = line.search(/\b(import|export)\s/)
    const firstBacktick = line.indexOf('`')
    if (importIdx >= 0 && firstBacktick >= 0 && importIdx > firstBacktick) {
      return { real: false, state: { ...state, inTemplateLiteral: true } }
    }
    if (importIdx >= 0 && (firstBacktick < 0 || importIdx < firstBacktick)) {
      return { real: true, state: { ...state, inTemplateLiteral: true } }
    }
    return { real: false, state: { ...state, inTemplateLiteral: true } }
  }

  if (/^\s*(import|export)\s/.test(line)) return { real: true, state }

  if (/\brequire\s*\(/.test(line)) {
    const reqIdx = line.indexOf('require')
    const beforeReq = line.slice(0, reqIdx)
    if (beforeReq.includes('`') || beforeReq.includes("'require") || beforeReq.includes('"require')) {
      return { real: false, state }
    }
    return { real: true, state }
  }

  return { real: false, state }
}

function countUnescapedBackticks(line: string): number {
  let count = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`' && (i === 0 || line[i - 1] !== '\\')) count++
  }
  return count
}

// ── In-process cross-package dep validator ──────────────────────────────────

async function validateCrossDepsInProcess(
  cwd: string,
  targetPath?: string,
): Promise<{
  valid: boolean
  missingDeps: Array<{
    importingFile: string
    importedPackage: string
    packageJsonPath: string
    line: number
  }>
  packagesChecked: number
  filesChecked: number
}> {
  const files = await discoverFiles(cwd)

  // Discover workspace packages
  const workspacePackages = new Map<string, { name: string; dir: string; deps: Set<string> }>()
  async function walkPkgs(dir: string, depth: number): Promise<void> {
    if (depth > 5) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walkPkgs(fullPath, depth + 1)
      } else if (entry.name === 'package.json') {
        try {
          const content = JSON.parse(await readFile(fullPath, 'utf-8'))
          if (content.name) {
            const allDeps = new Set<string>([
              ...Object.keys(content.dependencies ?? {}),
              ...Object.keys(content.devDependencies ?? {}),
              ...Object.keys(content.peerDependencies ?? {}),
            ])
            workspacePackages.set(relative(cwd, dir), { name: content.name, dir: relative(cwd, dir), deps: allDeps })
          }
        } catch { /* skip */ }
      }
    }
  }
  await walkPkgs(cwd, 0)

  function findOwningPkg(filePath: string) {
    let best: { key: string; pkg: (typeof workspacePackages extends Map<string, infer V> ? V : never) } | null = null
    for (const [dir, pkg] of workspacePackages) {
      if (filePath.startsWith(dir + '/') || filePath === dir) {
        if (!best || dir.length > best.key.length) best = { key: dir, pkg }
      }
    }
    return best?.pkg
  }

  const missingDeps: Array<{ importingFile: string; importedPackage: string; packageJsonPath: string; line: number }> = []
  let filesChecked = 0

  for (const [filePath, content] of files) {
    if (targetPath && !filePath.startsWith(targetPath)) continue
    filesChecked++
    const owningPkg = findOwningPkg(filePath)
    if (!owningPkg) continue

    const lines = content.split('\n')
    let parseState: ImportParseState = { inBlockComment: false, inTemplateLiteral: false }
    for (let i = 0; i < lines.length; i++) {
      const classification = isRealImportLine(lines[i], parseState)
      parseState = classification.state
      if (!classification.real) continue

      const importMatch = lines[i].match(
        /(?:from\s+['"]|require\s*\(\s*['"]|import\s+['"])(@[^'"\/]+\/[^'"\/]+|[^.'"\/@][^'"\/]*)/,
      )
      if (!importMatch) continue
      const importedPkg = importMatch[1]
      const isWorkspacePkg = [...workspacePackages.values()].some(wp => wp.name === importedPkg)
      if (!isWorkspacePkg) continue
      if (!owningPkg.deps.has(importedPkg)) {
        missingDeps.push({
          importingFile: filePath,
          importedPackage: importedPkg,
          packageJsonPath: join(owningPkg.dir, 'package.json'),
          line: i + 1,
        })
      }
    }
  }

  const seen = new Set<string>()
  const uniqueMissing = missingDeps.filter(d => {
    const key = `${d.packageJsonPath}:${d.importedPackage}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { valid: uniqueMissing.length === 0, missingDeps: uniqueMissing, packagesChecked: workspacePackages.size, filesChecked }
}

/** Create the code intelligence plugin. */
export const codeIntelligencePlugin: ToolPlugin = {
  name: 'af-code-intelligence',
  description: 'Code intelligence — symbol search, repo maps, code search, and memory deduplication',

  createTools(context) {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor, { indexDir: '.donmai/code-index' })
    const searchEngine = new SearchEngine()
    const hybridEngine = new HybridSearchEngine(searchEngine, null, null)
    const repoMapGen = new RepoMapGenerator()
    const dedupStore = new InMemoryStore()
    const dedupPipeline = new DedupPipeline(dedupStore)

    const tools: SdkMcpToolDefinition<any>[] = [
      tool(
        'af_code_search_symbols',
        'Search for code symbols (functions, classes, types, etc.) by name or query',
        {
          query: z.string().describe('Search query'),
          max_results: z.number().optional().describe('Maximum results (default 20)'),
          symbol_kinds: z.array(z.string()).optional().describe('Filter by symbol kinds'),
          file_pattern: z.string().optional().describe('Filter by file pattern (e.g. "*.ts")'),
        },
        async (args) => {
          try {
            const results = searchEngine.search({
              query: args.query,
              maxResults: args.max_results ?? 20,
              symbolKinds: args.symbol_kinds as any,
              filePattern: args.file_pattern,
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_get_repo_map',
        'Get a PageRank-ranked repository map showing the most important files and their key symbols',
        {
          max_files: z.number().optional().describe('Maximum files to include (default 50)'),
          file_patterns: z.array(z.string()).optional().describe('Filter file patterns'),
        },
        async (args) => {
          try {
            const stats = searchEngine.getStats()
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ totalSymbols: stats.totalSymbols, message: 'Repo map available after indexing' }, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_search_code',
        'Search code using hybrid BM25 + semantic ranking with code-aware tokenization',
        {
          query: z.string().describe('Code search query'),
          max_results: z.number().optional().describe('Maximum results (default 20)'),
          language: z.string().optional().describe('Filter by language'),
        },
        async (args) => {
          try {
            const results = await hybridEngine.search({
              query: args.query,
              maxResults: args.max_results ?? 20,
              language: args.language,
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_check_duplicate',
        'Check if content is a duplicate using xxHash64 exact match and SimHash near-duplicate detection',
        {
          content: z.string().describe('Content to check for duplicates'),
        },
        async (args) => {
          try {
            const result = await dedupPipeline.check(args.content)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_find_type_usages',
        'Find all switch/case statements, mapping objects, and usage sites for a union type or enum. Use this before adding new members to a type to identify all files that need updating.',
        {
          type_name: z.string().describe('The type/enum name to search for (e.g. "AgentWorkType")'),
          max_results: z.number().optional().describe('Maximum results (default 50)'),
        },
        async (args) => {
          try {
            const result = await findTypeUsagesInProcess(context.cwd, args.type_name, args.max_results ?? 50)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_validate_cross_deps',
        'Check that cross-package imports in a monorepo have corresponding package.json dependency declarations. Returns missing dependencies that would cause CI typecheck failures.',
        {
          path: z.string().optional().describe('Optional directory/file to scope the check'),
        },
        async (args) => {
          try {
            const result = await validateCrossDepsInProcess(context.cwd, args.path)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),
    ]

    // Conditionally add file reservation tools when delegate is available
    if (context.fileReservation) {
      const delegate = context.fileReservation
      const sessionId = context.env.LINEAR_SESSION_ID ?? 'unknown'

      tools.push(
        tool(
          'af_code_reserve_files',
          'Reserve files before modifying them to prevent merge conflicts with other agents working in parallel. Call this BEFORE editing files that other agents might also need to modify. Returns which files were successfully reserved and any conflicts.',
          {
            file_paths: z.array(z.string()).describe('Relative file paths to reserve (from repo root)'),
            reason: z.string().optional().describe('Why you are reserving these files'),
          },
          async (args) => {
            try {
              const result = await delegate.reserveFiles(sessionId, args.file_paths, args.reason)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              }
            } catch (err) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              }
            }
          }
        ),

        tool(
          'af_code_check_conflicts',
          'Check if files are currently reserved by other agent sessions. Use this before starting work on files to avoid merge conflicts. Files you already reserved are not reported as conflicts.',
          {
            file_paths: z.array(z.string()).describe('Relative file paths to check'),
          },
          async (args) => {
            try {
              const conflicts = await delegate.checkFileConflicts(sessionId, args.file_paths)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ conflicts, hasConflicts: conflicts.length > 0 }, null, 2) }],
              }
            } catch (err) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              }
            }
          }
        ),

        tool(
          'af_code_release_files',
          'Release file reservations after you are done modifying files. Always release files when your work on them is complete so other agents can modify them.',
          {
            file_paths: z.array(z.string()).describe('Relative file paths to release'),
          },
          async (args) => {
            try {
              const released = await delegate.releaseFiles(sessionId, args.file_paths)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ released, filePaths: args.file_paths }, null, 2) }],
              }
            } catch (err) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              }
            }
          }
        ),
      )
    }

    return tools
  },
}
