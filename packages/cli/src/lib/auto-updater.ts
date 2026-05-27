/**
 * Auto-Updater for AgentFactory CLI.
 *
 * When enabled, checks for new versions and can automatically update
 * the CLI package. For long-running processes (fleet, governor), it
 * waits until there are no active workers before restarting.
 *
 * Configuration (in order of precedence):
 *   1. CLI flag: --auto-update / --no-auto-update
 *   2. .env.local: AF_AUTO_UPDATE=true
 *   3. .donmai/config.yaml: autoUpdate: true
 */

import { execSync } from 'child_process'
import type { UpdateCheckResult } from './version.js'

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface AutoUpdateConfig {
  /** CLI flag override (highest precedence) */
  cliFlag?: boolean
  /** Whether there are active workers/agents to wait for */
  hasActiveWorkers?: () => boolean | Promise<boolean>
  /** Callback invoked right before the process exits for restart */
  onBeforeRestart?: () => void | Promise<void>
}

/**
 * Resolve whether auto-update is enabled from all config sources.
 */
export function isAutoUpdateEnabled(cliFlag?: boolean): boolean {
  // CLI flag takes highest precedence
  if (cliFlag !== undefined) return cliFlag

  // Environment variable
  const envVal = process.env.AF_AUTO_UPDATE
  if (envVal === '1' || envVal === 'true') return true
  if (envVal === '0' || envVal === 'false') return false

  // Default: disabled
  return false
}

// ---------------------------------------------------------------------------
// Update execution
// ---------------------------------------------------------------------------

/**
 * Attempt to install the latest version of the CLI package.
 * Returns true if the update succeeded.
 */
function installUpdate(targetVersion: string): boolean {
  const pkg = `@renseiai/agentfactory-cli@${targetVersion}`
  console.log(`${c.cyan}Updating to ${pkg}...${c.reset}`)

  try {
    // Detect package manager used for global install
    execSync(`npm ls -g @renseiai/agentfactory-cli --depth=0 2>/dev/null`, { stdio: 'ignore' })
    execSync(`npm install -g ${pkg}`, { stdio: 'inherit' })
    return true
  } catch {
    // npm global didn't work — try pnpm
    try {
      execSync(`pnpm add -g ${pkg}`, { stdio: 'inherit' })
      return true
    } catch {
      console.log(`${c.yellow}Auto-update failed. Update manually: npm i -g ${pkg}${c.reset}`)
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform auto-update if enabled and an update is available.
 *
 * For long-running processes (fleet, governor), this should be called
 * periodically. It will:
 *   1. Check if auto-update is enabled
 *   2. Verify an update is available
 *   3. Wait for active workers to finish (if hasActiveWorkers provided)
 *   4. Install the update
 *   5. Exit the process so the service manager can restart with the new version
 *
 * Returns true if an update was applied (process will exit shortly after).
 */
export async function maybeAutoUpdate(
  updateCheck: UpdateCheckResult | null,
  config: AutoUpdateConfig,
): Promise<boolean> {
  if (!isAutoUpdateEnabled(config.cliFlag)) return false
  if (!updateCheck?.updateAvailable) return false

  // If there are active workers, skip this cycle
  if (config.hasActiveWorkers) {
    const active = await config.hasActiveWorkers()
    if (active) {
      console.log(
        `${c.dim}Update v${updateCheck.latestVersion} available but workers are active — deferring${c.reset}`,
      )
      return false
    }
  }

  console.log(
    `\n${c.green}${c.bold}Auto-updating:${c.reset} v${updateCheck.currentVersion} → v${updateCheck.latestVersion}`,
  )

  const success = installUpdate(updateCheck.latestVersion)
  if (!success) return false

  // Call pre-restart hook
  if (config.onBeforeRestart) {
    await config.onBeforeRestart()
  }

  console.log(`${c.green}Update complete. Restarting...${c.reset}\n`)

  // Exit with code 0 — service managers (systemd, pm2, etc.) will restart
  process.exit(0)
}
