/**
 * Setup Mergiraf Runner — Programmatic API for configuring mergiraf as git merge driver.
 *
 * Exports `setupMergiraf()` so mergiraf configuration can be invoked from code
 * without going through process.argv / process.env / process.exit.
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SetupMergirafConfig {
  /** Show what would be done without making changes (default: false) */
  dryRun?: boolean
  /** Only configure for agent worktrees, not the whole repo (default: false) */
  worktreeOnly?: boolean
  /** Skip mergiraf binary check (default: false) */
  skipCheck?: boolean
  /** Git root directory (default: auto-detect) */
  gitRoot?: string
  /** Worktree path for per-worktree configuration (used with worktreeOnly) */
  worktreePath?: string
}

export interface SetupMergirafResult {
  mergirafFound: boolean
  mergirafVersion: string
  configuredFileTypes: string[]
  gitattributesWritten: boolean
  mergeDriverConfigured: boolean
  worktreeMode: boolean
  repoConfigUpdated: boolean
  errors: string[]
  /** Process exit code: 0 = success, 1 = error, 2 = mergiraf not found */
  exitCode: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

// ---------------------------------------------------------------------------
// Step functions
// ---------------------------------------------------------------------------

/**
 * Detect mergiraf binary and return version info.
 * Uses `which` to find the binary and `mergiraf --version` for the version string.
 */
export function detectMergiraf(): { found: boolean; version: string } {
  try {
    execSync('which mergiraf', { stdio: 'pipe', encoding: 'utf-8' })
  } catch {
    console.log('mergiraf binary not found on PATH.\n')
    console.log('Install mergiraf:')
    console.log('  macOS:  brew install mergiraf')
    console.log('  Linux:  cargo install mergiraf  (or download from Codeberg releases)')
    console.log('  Any:    cargo install mergiraf  (requires Rust toolchain)\n')
    return { found: false, version: '' }
  }

  let version = ''
  try {
    version = execSync('mergiraf --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    version = '(unknown)'
  }

  return { found: true, version }
}

/** File types that mergiraf supports for AST-aware merging. */
const MERGIRAF_FILE_TYPES = [
  '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.json',
  '*.yaml', '*.yml', '*.py', '*.go', '*.rs',
  '*.java', '*.css', '*.html',
]

/** Lock files that should use merge=ours strategy. */
const LOCK_FILE_ENTRIES = [
  'pnpm-lock.yaml merge=ours',
  'package-lock.json merge=ours',
  'yarn.lock merge=ours',
]

/**
 * Configure .gitattributes with mergiraf merge driver entries.
 * Idempotent — skips entries that already exist.
 */
export function configureGitattributes(
  gitRoot: string,
  config: SetupMergirafConfig,
): { written: boolean; fileTypes: string[] } {
  const gitattributesPath = resolve(gitRoot, '.gitattributes')

  let existing = ''
  if (existsSync(gitattributesPath)) {
    existing = readFileSync(gitattributesPath, 'utf-8')
  }

  const lines: string[] = []
  const addedTypes: string[] = []

  // Add mergiraf merge driver entries
  for (const ft of MERGIRAF_FILE_TYPES) {
    const entry = `${ft} merge=mergiraf`
    if (!existing.includes(entry)) {
      lines.push(entry)
      addedTypes.push(ft)
    }
  }

  // Add lock file entries
  for (const entry of LOCK_FILE_ENTRIES) {
    if (!existing.includes(entry)) {
      lines.push(entry)
    }
  }

  if (lines.length === 0) {
    console.log('  .gitattributes already configured — no changes needed')
    return { written: true, fileTypes: MERGIRAF_FILE_TYPES }
  }

  if (config.dryRun) {
    console.log('[DRY RUN] Would add to .gitattributes:')
    for (const line of lines) {
      console.log(`  ${line}`)
    }
    return { written: false, fileTypes: MERGIRAF_FILE_TYPES }
  }

  // Append new entries with a header comment
  const newContent = existing.trimEnd() +
    (existing.length > 0 ? '\n\n' : '') +
    '# AST-aware merge driver (mergiraf)\n' +
    lines.join('\n') + '\n'

  writeFileSync(gitattributesPath, newContent, 'utf-8')
  console.log(`  .gitattributes updated: ${addedTypes.length} file type(s) added`)

  return { written: true, fileTypes: MERGIRAF_FILE_TYPES }
}

/**
 * Configure git merge driver for mergiraf via `git config`.
 * In worktree-only mode, uses `--worktree` flag for worktree-local config.
 */
export function configureMergeDriver(
  targetPath: string,
  config: SetupMergirafConfig,
): boolean {
  const scope = config.worktreeOnly ? ' --worktree' : ''
  const label = config.worktreeOnly ? 'worktree-local config' : '.git/config'

  if (config.dryRun) {
    console.log('[DRY RUN] Would configure git merge driver:')
    console.log(`  git config${scope} merge.mergiraf.name "mergiraf"`)
    console.log(`  git config${scope} merge.mergiraf.driver "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P"`)
    return false
  }

  try {
    // Enable worktree config extension if using worktree-only mode
    if (config.worktreeOnly) {
      execSync('git config extensions.worktreeConfig true', {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: targetPath,
      })
    }

    execSync(`git config${scope} merge.mergiraf.name "mergiraf"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: targetPath,
    })
    execSync(
      `git config${scope} merge.mergiraf.driver "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P"`,
      { stdio: 'pipe', encoding: 'utf-8', cwd: targetPath },
    )
    console.log(`  Merge driver configured in ${label}`)
    return true
  } catch (error) {
    console.error(`  Failed to configure merge driver: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Update .donmai/config.yaml with mergeDriver: mergiraf.
 */
export function updateRepoConfig(
  gitRoot: string,
  config: SetupMergirafConfig,
): boolean {
  const configDir = resolve(gitRoot, '.donmai')
  const configPath = resolve(configDir, 'config.yaml')

  if (config.dryRun) {
    console.log('[DRY RUN] Would set mergeDriver: mergiraf in .donmai/config.yaml')
    return false
  }

  if (!existsSync(configPath)) {
    // Config file doesn't exist — skip (don't create one from scratch)
    console.log('  .donmai/config.yaml not found — skipping repo config update')
    return false
  }

  try {
    let content = readFileSync(configPath, 'utf-8')

    if (content.includes('mergeDriver: mergiraf')) {
      console.log('  .donmai/config.yaml already has mergeDriver: mergiraf')
      return true
    }

    if (content.includes('mergeDriver:')) {
      // Replace existing mergeDriver value
      content = content.replace(/mergeDriver:\s*\S+/, 'mergeDriver: mergiraf')
    } else {
      // Append mergeDriver setting
      content = content.trimEnd() + '\nmergeDriver: mergiraf\n'
    }

    writeFileSync(configPath, content, 'utf-8')
    console.log('  .donmai/config.yaml updated: mergeDriver: mergiraf')
    return true
  } catch (error) {
    console.error(`  Failed to update repo config: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function setupMergiraf(config?: SetupMergirafConfig): SetupMergirafResult {
  const gitRoot = config?.gitRoot ?? getGitRoot()
  const isWorktreeMode = config?.worktreeOnly ?? false
  // In worktree-only mode, use the worktree path for .gitattributes and git config
  const targetPath = isWorktreeMode && config?.worktreePath
    ? config.worktreePath
    : gitRoot

  const result: SetupMergirafResult = {
    mergirafFound: false,
    mergirafVersion: '',
    configuredFileTypes: [],
    gitattributesWritten: false,
    mergeDriverConfigured: false,
    worktreeMode: isWorktreeMode,
    repoConfigUpdated: false,
    errors: [],
    exitCode: 0,
  }

  // Step 1: Detect mergiraf binary
  if (!config?.skipCheck) {
    const detection = detectMergiraf()
    result.mergirafFound = detection.found
    result.mergirafVersion = detection.version

    if (!detection.found) {
      result.errors.push(
        'mergiraf binary not found on PATH. Install with: brew install mergiraf (macOS) or cargo install mergiraf',
      )
      result.exitCode = 2
      return result
    }
  } else {
    result.mergirafFound = true
    result.mergirafVersion = '(check skipped)'
  }

  if (config?.dryRun) {
    console.log('[DRY RUN] Would configure mergiraf in:', targetPath)
    console.log('[DRY RUN] Worktree-only mode:', isWorktreeMode)
    return result
  }

  // Step 2: Configure .gitattributes (in worktree root or repo root)
  const gitattributes = configureGitattributes(targetPath, config ?? {})
  result.gitattributesWritten = gitattributes.written
  result.configuredFileTypes = gitattributes.fileTypes

  // Step 3: Configure git merge driver (worktree-local or repo-wide)
  result.mergeDriverConfigured = configureMergeDriver(targetPath, config ?? {})

  // Step 4: Update repo config (always in git root, not worktree)
  if (!isWorktreeMode) {
    result.repoConfigUpdated = updateRepoConfig(gitRoot, config ?? {})
  }

  return result
}
