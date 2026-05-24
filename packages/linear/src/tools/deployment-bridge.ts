/**
 * Deployment Status Checker
 *
 * Queries GitHub commit status API for Vercel deployment state.
 * Used to verify deployments before QA/acceptance work can proceed.
 *
 * Self-contained — no dependency on @donmai/core core.
 * Originally in packages/core/src/deployment/deployment-checker.ts;
 * duplicated here to keep the linear plugin fully decoupled from core.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface DeploymentStatus {
  app: string
  state: 'success' | 'pending' | 'error' | 'failure'
  description: string
  targetUrl: string | null
  context: string
}

export interface DeploymentCheckResult {
  allSucceeded: boolean
  anyFailed: boolean
  anyPending: boolean
  statuses: DeploymentStatus[]
  commitSha: string
  overallState: string
}

interface DeploymentCheckOptions {
  owner?: string
  repo?: string
  timeout?: number
}

const DEFAULT_OPTIONS: Required<DeploymentCheckOptions> = {
  owner: 'renseiai',
  repo: 'agentfactory',
  timeout: 30000,
}

function parseAppName(context: string): string {
  const match = context.match(/Vercel\s*[–-]\s*(.+)/)
  return match ? match[1].trim() : context
}

function isSuccessfulSkip(description: string): boolean {
  return description.toLowerCase().includes('skipped') &&
         description.toLowerCase().includes('not affected')
}

function normalizeState(
  state: string,
  description: string
): DeploymentStatus['state'] {
  if (isSuccessfulSkip(description)) return 'success'
  switch (state.toLowerCase()) {
    case 'success': return 'success'
    case 'pending': return 'pending'
    case 'failure': return 'failure'
    case 'error': return 'error'
    default: return 'pending'
  }
}

async function getPRHeadSha(
  prNumber: number,
  options: DeploymentCheckOptions = {}
): Promise<string | null> {
  const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...options }
  try {
    const { stdout } = await execAsync(
      `gh api repos/${owner}/${repo}/pulls/${prNumber} --jq '.head.sha'`,
      { timeout }
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function checkDeploymentStatus(
  commitSha: string,
  options: DeploymentCheckOptions = {}
): Promise<DeploymentCheckResult> {
  const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...options }
  const { stdout } = await execAsync(
    `gh api repos/${owner}/${repo}/commits/${commitSha}/status`,
    { timeout }
  )
  const response = JSON.parse(stdout)
  const allStatuses: Array<{
    context: string; state: string; description: string; target_url: string | null
  }> = response.statuses || []

  const vercelStatuses = allStatuses.filter(
    (s) => s.context.toLowerCase().includes('vercel')
  )

  const deploymentStatuses: DeploymentStatus[] = vercelStatuses.map((s) => ({
    app: parseAppName(s.context),
    state: normalizeState(s.state, s.description || ''),
    description: s.description || '',
    targetUrl: s.target_url,
    context: s.context,
  }))

  const allSucceeded = deploymentStatuses.length > 0 &&
    deploymentStatuses.every((s) => s.state === 'success')
  const anyFailed = deploymentStatuses.some(
    (s) => s.state === 'failure' || s.state === 'error'
  )
  const anyPending = deploymentStatuses.some((s) => s.state === 'pending')

  return {
    allSucceeded,
    anyFailed,
    anyPending,
    statuses: deploymentStatuses,
    commitSha,
    overallState: response.state || 'unknown',
  }
}

export async function checkPRDeploymentStatus(
  prNumber: number,
  options: DeploymentCheckOptions = {}
): Promise<DeploymentCheckResult | null> {
  const commitSha = await getPRHeadSha(prNumber, options)
  if (!commitSha) return null
  return checkDeploymentStatus(commitSha, options)
}

export function formatDeploymentStatus(result: DeploymentCheckResult): string {
  const lines: string[] = []

  lines.push(`## Deployment Status Check`)
  lines.push(``)
  lines.push(`**Commit:** \`${result.commitSha.slice(0, 7)}\``)
  lines.push(`**Overall State:** ${result.overallState}`)
  lines.push(``)

  if (result.statuses.length === 0) {
    lines.push(`No Vercel deployments found for this commit.`)
    return lines.join('\n')
  }

  lines.push(`| App | State | Description |`)
  lines.push(`|-----|-------|-------------|`)

  for (const status of result.statuses) {
    const stateEmoji = {
      success: '\u2705',
      pending: '\u23F3',
      failure: '\u274C',
      error: '\u274C',
    }[status.state]

    const url = status.targetUrl
      ? `[${status.app}](${status.targetUrl})`
      : status.app

    lines.push(
      `| ${url} | ${stateEmoji} ${status.state} | ${status.description} |`
    )
  }

  lines.push(``)

  if (result.anyFailed) {
    lines.push(`### \u274C Deployment Failed`)
    lines.push(``)
    lines.push(`One or more Vercel deployments failed. QA/acceptance cannot proceed until deployments succeed.`)
  } else if (result.anyPending) {
    lines.push(`### \u23F3 Deployment Pending`)
    lines.push(``)
    lines.push(`One or more Vercel deployments are still in progress.`)
  } else if (result.allSucceeded) {
    lines.push(`### \u2705 All Deployments Succeeded`)
    lines.push(``)
    lines.push(`All Vercel deployments have completed successfully.`)
  }

  return lines.join('\n')
}
