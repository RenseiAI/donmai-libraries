/**
 * Add-dep runner — safely adds dependencies in agent worktrees.
 *
 * Detects worktree vs main repo, resolves the package manager from
 * .agentfactory/config.yaml, cleans symlinked node_modules, and runs
 * the correct add command with ORCHESTRATOR_INSTALL=1 to bypass
 * preinstall guards.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type PackageManager,
  getAddCommand,
} from '@donmai/core'
import { loadRepositoryConfig } from '@donmai/core'

export interface AddDepOptions {
  packages: string[]
  filter?: string
  cwd: string
}

/** Detect if we're inside a git worktree (not the main repo). */
function isWorktree(cwd: string): boolean {
  const gitPath = resolve(cwd, '.git')
  if (!existsSync(gitPath)) return false
  try {
    const stat = statSync(gitPath)
    // Worktrees have a .git *file* pointing to the main repo's .git/worktrees/<name>
    return stat.isFile()
  } catch {
    return false
  }
}

/** Resolve the git root (works for both worktrees and main repos). */
function findGitRoot(cwd: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return cwd
  }
}

/** Resolve the main repo root from a worktree .git file. */
function resolveMainRepo(cwd: string): string | null {
  const gitPath = resolve(cwd, '.git')
  try {
    const content = readFileSync(gitPath, 'utf-8').trim()
    // Format: "gitdir: /path/to/main/.git/worktrees/<name>"
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (!match) return null
    const gitdir = match[1]
    // Walk up from .git/worktrees/<name> to .git, then to repo root
    const mainGitDir = resolve(gitdir, '..', '..')
    return resolve(mainGitDir, '..')
  } catch {
    return null
  }
}

/** Remove symlinked node_modules from the worktree. */
function cleanNodeModules(worktreePath: string): void {
  // Root node_modules
  const rootNm = resolve(worktreePath, 'node_modules')
  if (existsSync(rootNm)) {
    rmSync(rootNm, { recursive: true, force: true })
  }

  // Per-workspace node_modules
  for (const subdir of ['apps', 'packages']) {
    const dir = resolve(worktreePath, subdir)
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        const nm = resolve(dir, entry, 'node_modules')
        if (existsSync(nm)) {
          rmSync(nm, { recursive: true, force: true })
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
}

/** Resolve the package manager from repo config or default to 'pnpm'. */
function resolvePackageManager(repoRoot: string): PackageManager {
  try {
    const config = loadRepositoryConfig(repoRoot)
    if (config?.packageManager) {
      return config.packageManager as PackageManager
    }
  } catch {
    // Config not found or invalid — fall through to default
  }
  return 'pnpm'
}

export function runAddDep(options: AddDepOptions): void {
  const { packages, filter, cwd } = options

  if (packages.length === 0) {
    console.error('Error: No packages specified')
    process.exit(1)
  }

  const gitRoot = findGitRoot(cwd)
  const inWorktree = isWorktree(cwd)

  // Resolve package manager from the main repo's config
  const configRoot = inWorktree ? (resolveMainRepo(cwd) ?? gitRoot) : gitRoot
  const pm = resolvePackageManager(configRoot)

  if (pm === 'none') {
    console.error('Error: packageManager is "none" — cannot add dependencies')
    process.exit(1)
  }

  const addCmd = getAddCommand(pm)
  if (!addCmd) {
    console.error(`Error: No add command for package manager "${pm}"`)
    process.exit(1)
  }

  // Build the full command
  let cmd = `${addCmd} ${packages.join(' ')}`
  if (filter) {
    // Package manager specific workspace filter
    switch (pm) {
      case 'pnpm':
        cmd += ` --filter ${filter}`
        break
      case 'yarn':
        cmd += ` --workspace ${filter}`
        break
      case 'npm':
        cmd += ` --workspace=${filter}`
        break
      case 'bun':
        cmd += ` --filter ${filter}`
        break
    }
  }

  // If in a worktree, clean symlinked node_modules first
  if (inWorktree) {
    console.log('Detected worktree — cleaning symlinked node_modules...')
    cleanNodeModules(cwd)
  }

  console.log(`Running: ${cmd}`)

  try {
    execSync(cmd, {
      cwd,
      stdio: 'inherit',
      timeout: 120_000,
      env: { ...process.env, ORCHESTRATOR_INSTALL: '1' },
    })
    console.log('Dependencies added successfully')
  } catch (error) {
    console.error(
      'Failed to add dependencies:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  }
}
