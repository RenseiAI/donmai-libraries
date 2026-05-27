import { readFile, readdir, stat } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'

// ── Supported extensions (mirrors SymbolExtractor's EXTENSION_MAP) ──────────

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs',
])

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', '.turbo',
  'build', 'coverage', '__pycache__', '.donmai',
  '.worktrees', 'vendor', 'target',
])

// ── Types ───────────────────────────────────────────────────────────────────

export interface CodeIntelligenceRunnerConfig {
  command: string
  args: Record<string, string | string[] | boolean>
  positionalArgs: string[]
  cwd: string
}

export interface CodeIntelligenceRunnerResult {
  output: unknown
}

// ── Arg parsing ─────────────────────────────────────────────────────────────

export function parseCodeArgs(argv: string[]): {
  command: string | undefined
  args: Record<string, string | string[] | boolean>
  positionalArgs: string[]
} {
  const args: Record<string, string | string[] | boolean> = {}
  const positionalArgs: string[] = []
  let command: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else if (!command) {
      command = arg
    } else {
      positionalArgs.push(arg)
    }
  }

  return { command, args, positionalArgs }
}

// ── File discovery ──────────────────────────────────────────────────────────

async function discoverSourceFiles(cwd: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && IGNORE_DIRS.has(entry.name)) continue
      if (IGNORE_DIRS.has(entry.name)) continue

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name))) {
        // Skip files larger than 512KB (likely generated)
        try {
          const s = await stat(fullPath)
          if (s.size > 512 * 1024) continue
        } catch {
          continue
        }

        try {
          const content = await readFile(fullPath, 'utf-8')
          const relPath = relative(cwd, fullPath)
          files.set(relPath, content)
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(cwd)
  return files
}

// ── Index initialization ────────────────────────────────────────────────────

async function initializeIndex(cwd: string) {
  const {
    SymbolExtractor,
    IncrementalIndexer,
    SearchEngine,
    HybridSearchEngine,
    RepoMapGenerator,
    DedupPipeline,
    InMemoryStore,
  } = await import('@renseiai/agentfactory-code-intelligence')

  const extractor = new SymbolExtractor()
  const indexer = new IncrementalIndexer(extractor, { indexDir: '.donmai/code-index' })
  const searchEngine = new SearchEngine()
  const hybridEngine = new HybridSearchEngine(searchEngine, null, null)
  const repoMapGen = new RepoMapGenerator()
  const dedupStore = new InMemoryStore()
  const dedupPipeline = new DedupPipeline(dedupStore)

  // Try loading persisted index
  const loaded = await indexer.load(cwd)

  if (loaded) {
    const symbols = indexer.getAllSymbols()
    searchEngine.buildIndex(symbols)
  } else {
    // No persisted index — discover files and build fresh
    const files = await discoverSourceFiles(cwd)
    await indexer.index(files)
    await indexer.save(cwd)
    const symbols = indexer.getAllSymbols()
    searchEngine.buildIndex(symbols)
  }

  return { indexer, searchEngine, hybridEngine, repoMapGen, dedupPipeline, extractor }
}

// ── Command handlers ────────────────────────────────────────────────────────

async function searchSymbols(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  const query = config.positionalArgs[0]
  if (!query) throw new Error('Usage: af-code search-symbols <query> [--max-results N] [--kinds "function,class"] [--file-pattern "*.ts"]')

  const maxResults = config.args['max-results'] ? Number(config.args['max-results']) : 20
  const kinds = config.args['kinds']
    ? (typeof config.args['kinds'] === 'string' ? config.args['kinds'].split(',').map(s => s.trim()) : config.args['kinds'])
    : undefined
  const filePattern = typeof config.args['file-pattern'] === 'string' ? config.args['file-pattern'] : undefined

  const results = engines.searchEngine.search({
    query,
    maxResults,
    symbolKinds: kinds as any,
    filePattern,
  })

  return results
}

async function getRepoMap(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  const maxFiles = config.args['max-files'] ? Number(config.args['max-files']) : 50
  const rawPatterns = config.args['file-patterns']
  const filePatterns = typeof rawPatterns === 'string'
    ? rawPatterns.split(',').map(s => s.trim())
    : Array.isArray(rawPatterns) ? rawPatterns : undefined

  // Rebuild ASTs from the file index for PageRank computation
  const fileIndex = engines.indexer.getFileIndex()
  const asts = [...fileIndex.values()].map(fi => ({
    filePath: fi.filePath,
    language: fi.symbols[0]?.language ?? 'unknown',
    symbols: fi.symbols,
    imports: [] as string[],
    exports: fi.symbols.filter(s => s.exported).map(s => s.name),
  }))

  const entries = engines.repoMapGen.generate(asts, { maxFiles, filePatterns })
  const formatted = engines.repoMapGen.format(entries)

  return { entries, formatted }
}

async function searchCode(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  const query = config.positionalArgs[0]
  if (!query) throw new Error('Usage: af-code search-code <query> [--max-results N] [--language ts]')

  const maxResults = config.args['max-results'] ? Number(config.args['max-results']) : 20
  const language = typeof config.args['language'] === 'string' ? config.args['language'] : undefined

  const results = await engines.hybridEngine.search({
    query,
    maxResults,
    language,
  })

  return results
}

async function checkDuplicate(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  let content: string

  if (typeof config.args['content-file'] === 'string') {
    content = await readFile(config.args['content-file'], 'utf-8')
  } else if (typeof config.args['content'] === 'string') {
    content = config.args['content']
  } else {
    throw new Error('Usage: af-code check-duplicate --content "<code>" or --content-file /path/to/file')
  }

  const result = await engines.dedupPipeline.check(content)
  return result
}

// ── Type usage finder (P3a) ─────────────────────────────────────────────────

interface TypeUsage {
  filePath: string
  line: number
  context: string
  kind: 'switch_case' | 'mapping_object' | 'import' | 'type_reference' | 'exhaustive_check'
}

async function findTypeUsages(
  config: CodeIntelligenceRunnerConfig,
): Promise<unknown> {
  const typeName = config.positionalArgs[0]
  if (!typeName) throw new Error('Usage: af-code find-type-usages <TypeName>')

  const maxResults = config.args['max-results'] ? Number(config.args['max-results']) : 50
  const files = await discoverSourceFiles(config.cwd)
  const usages: TypeUsage[] = []

  // Patterns that indicate exhaustive switch/case, mapping objects, or type references
  const switchPattern = new RegExp(`switch\\s*\\(`, 'g')
  const casePattern = new RegExp(`case\\s+['"]`, 'g')
  const importPattern = new RegExp(`\\b${escapeRegex(typeName)}\\b`, 'g')
  const mappingPattern = new RegExp(
    `(?:Record<\\s*${escapeRegex(typeName)}|:\\s*\\{\\s*\\[\\w+\\s+in\\s+${escapeRegex(typeName)}\\]|satisfies\\s+Record<\\s*${escapeRegex(typeName)})`,
    'g',
  )

  for (const [filePath, content] of files) {
    if (!content.includes(typeName)) continue

    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Check for import of the type
      if (line.match(/\bimport\b/) && line.includes(typeName)) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'import' })
        continue
      }

      // Check for switch statements — look for switch keyword near the type name usage
      if (switchPattern.test(line)) {
        // Scan surrounding lines for the type name
        const windowStart = Math.max(0, i - 2)
        const windowEnd = Math.min(lines.length - 1, i + 5)
        const window = lines.slice(windowStart, windowEnd + 1).join('\n')
        if (window.includes(typeName) || hasRelatedCases(lines, i, typeName)) {
          usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'switch_case' })
        }
        switchPattern.lastIndex = 0
      }

      // Check for Record<TypeName, ...> or mapping objects
      if (mappingPattern.test(line)) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'mapping_object' })
        mappingPattern.lastIndex = 0
      }

      // Check for exhaustive checks (assertNever, default: throw, etc.)
      if (
        (line.includes('assertNever') || line.includes('exhaustive')) &&
        content.includes(typeName)
      ) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'exhaustive_check' })
      }

      // Check for type definition/reference (union type definitions, extends, etc.)
      if (
        (line.includes(`type ${typeName}`) ||
          line.includes(`interface ${typeName}`) ||
          line.match(new RegExp(`:\\s*${escapeRegex(typeName)}\\b`))) &&
        !line.match(/\bimport\b/)
      ) {
        usages.push({ filePath, line: i + 1, context: line.trim(), kind: 'type_reference' })
      }
    }
  }

  // Deduplicate and sort: switch_case and mapping_object first (most actionable)
  const kindPriority: Record<string, number> = {
    switch_case: 0,
    mapping_object: 1,
    exhaustive_check: 2,
    type_reference: 3,
    import: 4,
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

/** Check if a switch block's case statements relate to a union type */
function hasRelatedCases(lines: string[], switchLine: number, _typeName: string): boolean {
  // Scan forward from the switch line looking for string literal cases
  for (let j = switchLine; j < Math.min(lines.length, switchLine + 50); j++) {
    if (lines[j].includes('case \'') || lines[j].includes('case "')) {
      return true // Has string literal cases, likely a discriminated union switch
    }
    if (lines[j].match(/^\s*\}/)) break // End of block
  }
  return false
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Import line classification ──────────────────────────────────────────────

/**
 * Parsing state tracked across lines for import classification.
 */
interface ImportParseState {
  inBlockComment: boolean
  inTemplateLiteral: boolean
}

/**
 * Determine whether a line contains a real import statement (not one inside
 * a comment, string literal, template literal, or test assertion).
 *
 * The caller must maintain the parse state across lines.
 */
function isRealImportLine(
  line: string,
  state: ImportParseState,
): { real: boolean; state: ImportParseState } {
  const trimmed = line.trim()

  // Track block comment boundaries
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

  // Track template literal boundaries (backtick strings spanning multiple lines)
  // Count unescaped backticks to toggle state
  if (state.inTemplateLiteral) {
    const backtickCount = countUnescapedBackticks(line)
    if (backtickCount % 2 === 1) {
      // Odd number of backticks — template literal ends on this line
      return { real: false, state: { ...state, inTemplateLiteral: false } }
    }
    return { real: false, state }
  }

  // Single-line comments and JSDoc continuation lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return { real: false, state }

  // Check if this line opens a template literal that doesn't close on the same line
  const backticks = countUnescapedBackticks(line)
  if (backticks % 2 === 1) {
    // Odd backticks — a template literal opens and doesn't close on this line.
    // The import on this line (if any) could be before or after the backtick.
    // If the import keyword appears after a backtick, it's template content.
    const importIdx = line.search(/\b(import|export)\s/)
    const firstBacktick = line.indexOf('`')
    if (importIdx >= 0 && firstBacktick >= 0 && importIdx > firstBacktick) {
      // Import appears inside the template literal
      return { real: false, state: { ...state, inTemplateLiteral: true } }
    }
    // Import appears before the backtick — real import, but template opens
    if (importIdx >= 0 && (firstBacktick < 0 || importIdx < firstBacktick)) {
      return { real: true, state: { ...state, inTemplateLiteral: true } }
    }
    return { real: false, state: { ...state, inTemplateLiteral: true } }
  }

  // Real import/export/require statements start at the beginning of the line
  if (/^\s*(import|export)\s/.test(line)) return { real: true, state }

  // Dynamic require: `const x = require('pkg')`
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

/** Count unescaped backticks in a line */
function countUnescapedBackticks(line: string): number {
  let count = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`' && (i === 0 || line[i - 1] !== '\\')) {
      count++
    }
  }
  return count
}

// ── Cross-package dependency validator (P3b) ────────────────────────────────

interface DepValidationResult {
  valid: boolean
  missingDeps: Array<{
    importingFile: string
    importedPackage: string
    packageJsonPath: string
    line: number
  }>
}

async function validateCrossDeps(
  config: CodeIntelligenceRunnerConfig,
): Promise<unknown> {
  const targetPath = config.positionalArgs[0] // Optional: specific file or directory
  const files = await discoverSourceFiles(config.cwd)

  // 1. Build a map of workspace packages by reading all package.json files
  const workspacePackages = new Map<string, { name: string; dir: string; deps: Set<string> }>()
  await discoverWorkspacePackages(config.cwd, workspacePackages)

  // 2. Map file paths to their owning workspace package
  function findOwningPackage(filePath: string): typeof workspacePackages extends Map<string, infer V> ? V : never {
    let bestMatch: { key: string; pkg: (typeof workspacePackages extends Map<string, infer V> ? V : never) } | null = null
    for (const [dir, pkg] of workspacePackages) {
      if (filePath.startsWith(dir + '/') || filePath === dir) {
        if (!bestMatch || dir.length > bestMatch.key.length) {
          bestMatch = { key: dir, pkg }
        }
      }
    }
    return bestMatch?.pkg as any
  }

  const missingDeps: DepValidationResult['missingDeps'] = []

  // 3. Check each file for cross-package imports
  for (const [filePath, content] of files) {
    if (targetPath && !filePath.startsWith(targetPath)) continue

    const owningPkg = findOwningPackage(filePath)
    if (!owningPkg) continue

    const lines = content.split('\n')
    let parseState: ImportParseState = { inBlockComment: false, inTemplateLiteral: false }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Skip comments, string literals, and template content
      const classification = isRealImportLine(line, parseState)
      parseState = classification.state
      if (!classification.real) continue

      // Match import/require of workspace packages
      const importMatch = line.match(
        /(?:from\s+['"]|require\s*\(\s*['"]|import\s+['"])(@[^'"\/]+\/[^'"\/]+|[^.'"\/@][^'"\/]*)/,
      )
      if (!importMatch) continue

      const importedPkg = importMatch[1]
      // Check if this is a workspace package
      const isWorkspacePkg = [...workspacePackages.values()].some(wp => wp.name === importedPkg)
      if (!isWorkspacePkg) continue

      // Check if it's declared in package.json
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

  // Deduplicate by (packageJsonPath, importedPackage)
  const seen = new Set<string>()
  const uniqueMissing = missingDeps.filter(d => {
    const key = `${d.packageJsonPath}:${d.importedPackage}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    valid: uniqueMissing.length === 0,
    missingDeps: uniqueMissing,
    packagesChecked: workspacePackages.size,
    filesChecked: targetPath
      ? [...files.keys()].filter(f => f.startsWith(targetPath)).length
      : files.size,
  }
}

async function discoverWorkspacePackages(
  cwd: string,
  result: Map<string, { name: string; dir: string; deps: Set<string> }>,
): Promise<void> {
  // Find all package.json files in the workspace (skip node_modules, dist)
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5) return
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
        await walk(fullPath, depth + 1)
      } else if (entry.name === 'package.json') {
        try {
          const content = JSON.parse(await readFile(fullPath, 'utf-8'))
          if (content.name) {
            const allDeps = new Set<string>([
              ...Object.keys(content.dependencies ?? {}),
              ...Object.keys(content.devDependencies ?? {}),
              ...Object.keys(content.peerDependencies ?? {}),
            ])
            result.set(relative(cwd, dir), {
              name: content.name,
              dir: relative(cwd, dir),
              deps: allDeps,
            })
          }
        } catch {
          // Skip malformed package.json
        }
      }
    }
  }

  await walk(cwd, 0)
}

// ── Main runner ─────────────────────────────────────────────────────────────

export async function runCodeIntelligence(
  config: CodeIntelligenceRunnerConfig,
): Promise<CodeIntelligenceRunnerResult> {
  // Commands that don't need the full index
  switch (config.command) {
    case 'find-type-usages':
      return { output: await findTypeUsages(config) }
    case 'validate-cross-deps':
      return { output: await validateCrossDeps(config) }
  }

  const engines = await initializeIndex(config.cwd)

  switch (config.command) {
    case 'search-symbols':
      return { output: await searchSymbols(config, engines) }
    case 'get-repo-map':
      return { output: await getRepoMap(config, engines) }
    case 'search-code':
      return { output: await searchCode(config, engines) }
    case 'check-duplicate':
      return { output: await checkDuplicate(config, engines) }
    default:
      throw new Error(`Unknown command: ${config.command}. Available: search-symbols, get-repo-map, search-code, check-duplicate, find-type-usages, validate-cross-deps`)
  }
}
