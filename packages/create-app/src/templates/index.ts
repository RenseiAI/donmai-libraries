/**
 * Template generator for create-donmai-app
 *
 * Returns a map of file paths → file contents.
 */

export interface TemplateOptions {
  projectName: string
  teamKey: string
  includeDashboard: boolean
  includeCli: boolean
  useRedis: boolean
}

export function getTemplates(opts: TemplateOptions): Record<string, string> {
  const files: Record<string, string> = {}

  // ── Root config files ──────────────────────────────────────────

  files['package.json'] = packageJson(opts)
  files['tsconfig.json'] = tsconfig()
  files['next.config.ts'] = nextConfig(opts)
  files['.env.example'] = envExample(opts)
  files['.gitignore'] = gitignore()

  // ── Core app files ─────────────────────────────────────────────

  files['src/lib/config.ts'] = configTs()
  files['src/middleware.ts'] = middlewareTs()

  // ── Route re-exports ───────────────────────────────────────────

  files['src/app/webhook/route.ts'] = routeReexport('routes.webhook.POST', 'routes.webhook.GET')
  files['src/app/callback/route.ts'] = routeReexport(null, 'routes.oauth.callback.GET')

  // Worker routes
  files['src/app/api/workers/register/route.ts'] = routeReexport('routes.workers.register.POST')
  files['src/app/api/workers/route.ts'] = routeReexport(null, 'routes.workers.list.GET')
  files['src/app/api/workers/[id]/route.ts'] = routeReexport(null, 'routes.workers.detail.GET', 'routes.workers.detail.DELETE')
  files['src/app/api/workers/[id]/heartbeat/route.ts'] = routeReexport('routes.workers.heartbeat.POST')
  files['src/app/api/workers/[id]/poll/route.ts'] = routeReexport(null, 'routes.workers.poll.GET')

  // Session routes
  files['src/app/api/sessions/route.ts'] = routeReexport(null, 'routes.sessions.list.GET')
  files['src/app/api/sessions/[id]/route.ts'] = routeReexport(null, 'routes.sessions.detail.GET')
  files['src/app/api/sessions/[id]/claim/route.ts'] = routeReexport('routes.sessions.claim.POST')
  files['src/app/api/sessions/[id]/status/route.ts'] = routeReexport('routes.sessions.status.POST', 'routes.sessions.status.GET')
  files['src/app/api/sessions/[id]/lock-refresh/route.ts'] = routeReexport('routes.sessions.lockRefresh.POST')
  files['src/app/api/sessions/[id]/prompts/route.ts'] = routeReexport('routes.sessions.prompts.POST', 'routes.sessions.prompts.GET')
  files['src/app/api/sessions/[id]/transfer-ownership/route.ts'] = routeReexport('routes.sessions.transferOwnership.POST')
  files['src/app/api/sessions/[id]/activity/route.ts'] = routeReexport('routes.sessions.activity.POST')
  files['src/app/api/sessions/[id]/completion/route.ts'] = routeReexport('routes.sessions.completion.POST')
  files['src/app/api/sessions/[id]/external-urls/route.ts'] = routeReexport('routes.sessions.externalUrls.POST')
  files['src/app/api/sessions/[id]/progress/route.ts'] = routeReexport('routes.sessions.progress.POST')
  files['src/app/api/sessions/[id]/tool-error/route.ts'] = routeReexport('routes.sessions.toolError.POST')

  // Public routes
  files['src/app/api/public/stats/route.ts'] = routeReexport(null, 'routes.public.stats.GET')
  files['src/app/api/public/sessions/route.ts'] = routeReexport(null, 'routes.public.sessions.GET')
  files['src/app/api/public/sessions/[id]/route.ts'] = routeReexport(null, 'routes.public.sessionDetail.GET')
  files['src/app/api/public/phase-metrics/route.ts'] = routeReexport(null, 'routes.public.phaseMetrics.GET')

  // Config route
  files['src/app/api/config/route.ts'] = routeReexport(null, 'routes.config.GET')

  // Cleanup route
  files['src/app/api/cleanup/route.ts'] = routeReexport('routes.cleanup.POST', 'routes.cleanup.GET')

  // Issue tracker proxy (centralized API gateway for agents/governors)
  files['src/app/api/issue-tracker-proxy/route.ts'] = routeReexport('routes.issueTrackerProxy.POST', 'routes.issueTrackerProxy.GET')

  // ── Dashboard ──────────────────────────────────────────────────

  if (opts.includeDashboard) {
    files['src/app/layout.tsx'] = layoutTsx(opts)
    files['src/app/page.tsx'] = dashboardPageTsx()
    files['src/app/globals.css'] = globalsCss()
    files['src/app/pipeline/page.tsx'] = pipelinePageTsx()
    files['src/app/sessions/page.tsx'] = sessionsPageTsx()
    files['src/app/sessions/[id]/page.tsx'] = sessionDetailPageTsx()
    files['src/app/settings/page.tsx'] = settingsPageTsx()
    files['postcss.config.mjs'] = postcssConfig()
  } else {
    files['src/app/layout.tsx'] = layoutTsx(opts)
    files['src/app/page.tsx'] = minimalPageTsx()
    files['src/app/globals.css'] = globalsCss()
  }

  // ── CLI tools ──────────────────────────────────────────────────

  if (opts.includeCli) {
    files['cli/worker.ts'] = cliWorker()
    files['cli/orchestrator.ts'] = cliOrchestrator()
    files['cli/worker-fleet.ts'] = cliWorkerFleet()
    files['cli/cleanup.ts'] = cliCleanup()
  }

  // ── Agent definitions ──────────────────────────────────────────

  files['.claude/CLAUDE.md'] = claudeMd(opts)
  files['AGENTS.md'] = agentsMd(opts)
  files['.claude/agents/developer.md'] = agentDefinitionDeveloper()

  return files
}

// ── Template helpers ───────────────────────────────────────────────

function routeReexport(post: string | null, get?: string, del?: string): string {
  const lines = [`import { routes } from '@/lib/config'`]
  if (post) lines.push(`export const POST = ${post}`)
  if (get) lines.push(`export const GET = ${get}`)
  if (del) lines.push(`export const DELETE = ${del}`)
  return lines.join('\n') + '\n'
}

// ── Individual templates ───────────────────────────────────────────

function packageJson(opts: TemplateOptions): string {
  const deps: Record<string, string> = {
    '@donmai/core': '^0.8.4',
    '@renseiai/agentfactory-cli': '^0.8.4',
    '@donmai/plugin-linear': '^0.8.4',
    '@renseiai/agentfactory-nextjs': '^0.8.4',
    '@donmai/server': '^0.8.4',
    'next': '^16.1.0',
    'react': '^19.0.0',
    'react-dom': '^19.0.0',
  }

  const devDeps: Record<string, string> = {
    '@types/node': '^22',
    '@types/react': '^19',
    'typescript': '^5',
  }

  const scripts: Record<string, string> = {
    'dev': 'next dev',
    'build': 'next build',
    'start': 'next start',
    'typecheck': 'tsc --noEmit',
    'linear': 'af-linear',
  }

  if (opts.includeDashboard) {
    deps['@donmai/dashboard'] = '^0.8.4'
    devDeps['@tailwindcss/postcss'] = '^4'
    devDeps['tailwindcss'] = '^4'
  }

  if (opts.includeCli) {
    scripts['worker'] = 'tsx cli/worker.ts'
    scripts['orchestrator'] = 'tsx cli/orchestrator.ts'
    scripts['worker-fleet'] = 'tsx cli/worker-fleet.ts'
    scripts['cleanup'] = 'tsx cli/cleanup.ts'
    devDeps['tsx'] = '^4'
    devDeps['dotenv'] = '^16'
  }

  const pkg = {
    name: opts.projectName,
    version: '0.1.0',
    private: true,
    scripts,
    dependencies: deps,
    devDependencies: devDeps,
  }

  return JSON.stringify(pkg, null, 2) + '\n'
}

function tsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2017',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      incremental: true,
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] },
      plugins: [{ name: 'next' }],
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  }, null, 2) + '\n'
}

function nextConfig(opts: TemplateOptions): string {
  if (opts.includeDashboard) {
    return `import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@donmai/dashboard'],
}

export default nextConfig
`
  }
  return `import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
`
}

function envExample(opts: TemplateOptions): string {
  const lines = [
    '# Linear API Access',
    '# Create at: Settings > API > Personal API Keys',
    'LINEAR_ACCESS_TOKEN=lin_api_...',
    '',
    '# Linear Webhook Verification',
    '# Create at: Settings > API > Webhooks',
    'LINEAR_WEBHOOK_SECRET=',
    '',
    '# Linear OAuth App (optional — for multi-workspace)',
    '# LINEAR_CLIENT_ID=',
    '# LINEAR_CLIENT_SECRET=',
    '',
    '# App URL (for OAuth redirect)',
    `NEXT_PUBLIC_APP_URL=http://localhost:3000`,
    '',
  ]

  if (opts.useRedis) {
    lines.push(
      '# Redis (required for distributed workers)',
      '# Format: redis://[:password@]host[:port][/db]',
      'REDIS_URL=redis://localhost:6379',
      '',
    )
  }

  if (opts.includeCli) {
    lines.push(
      '# Worker Configuration',
      '# WORKER_API_URL=https://your-app.vercel.app',
      '# WORKER_API_KEY=',
      '',
    )
  }

  lines.push(
    '# Agent Provider (default: claude)',
    '# Options: claude, codex, amp',
    '# AGENT_PROVIDER=claude',
    '',
    '# Auto-trigger Configuration',
    '# ENABLE_AUTO_QA=false',
    '# ENABLE_AUTO_ACCEPTANCE=false',
  )

  return lines.join('\n') + '\n'
}

function gitignore(): string {
  return `node_modules/
.next/
dist/
.env.local
.env*.local
.worktrees/
.agent/
*.tsbuildinfo
`
}

function configTs(): string {
  return `/**
 * AgentFactory Configuration
 *
 * Central route wiring — connects your callbacks to the route factories.
 * Customize generatePrompt and other hooks to match your workflow.
 */

import { createAllRoutes, createDefaultLinearClientResolver } from '@renseiai/agentfactory-nextjs'

export const routes = createAllRoutes({
  linearClient: createDefaultLinearClientResolver(),
  // Uncomment and customize as needed:
  // projects: ['MyProject'],  // Only handle webhooks for these Linear projects
  // generatePrompt: (identifier, workType, mentionContext) => {
  //   return \`Work on issue \${identifier} (type: \${workType})\`
  // },
  // autoTrigger: {
  //   enableAutoQA: true,
  //   enableAutoAcceptance: false,
  //   autoQARequireAgentWorked: true,
  //   autoAcceptanceRequireAgentWorked: true,
  //   autoQAProjects: [],
  //   autoAcceptanceProjects: [],
  //   autoQAExcludeLabels: [],
  //   autoAcceptanceExcludeLabels: [],
  // },
})
`
}

function middlewareTs(): string {
  return `/**
 * Next.js Middleware — Edge Runtime Compatible
 *
 * Uses the /middleware subpath export which only loads Edge-compatible
 * modules. Do NOT import from the main barrel ('@renseiai/agentfactory-nextjs')
 * — it pulls in Node.js-only dependencies via re-exports.
 */

import { createAgentFactoryMiddleware } from '@renseiai/agentfactory-nextjs/middleware'

const { middleware } = createAgentFactoryMiddleware()

export { middleware }

// Must be a static object literal for Next.js build analysis
export const config = {
  matcher: [
    '/api/:path*',
    '/webhook',
    '/pipeline',
    '/settings',
    '/sessions/:path*',
    '/',
  ],
}
`
}

function layoutTsx(opts: TemplateOptions): string {
  if (opts.includeDashboard) {
    return `import type { Metadata } from 'next'
import '@donmai/dashboard/styles'
import './globals.css'

export const metadata: Metadata = {
  title: '${opts.projectName} — AgentFactory',
  description: 'AI agent fleet management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  )
}
`
  }
  return `import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '${opts.projectName} — AgentFactory',
  description: 'AI agent fleet management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`
}

function globalsCss(): string {
  return `@import "tailwindcss";
@source "../../node_modules/@donmai/dashboard/src";
`
}

function dashboardPageTsx(): string {
  return `'use client'

import { DashboardShell, DashboardPage as FleetPage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function DashboardPage() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <FleetPage />
    </DashboardShell>
  )
}
`
}

function pipelinePageTsx(): string {
  return `'use client'

import { DashboardShell, PipelinePage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function Pipeline() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <PipelinePage />
    </DashboardShell>
  )
}
`
}

function sessionsPageTsx(): string {
  return `'use client'

import { DashboardShell, SessionPage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function Sessions() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage />
    </DashboardShell>
  )
}
`
}

function sessionDetailPageTsx(): string {
  return `'use client'

import { DashboardShell, SessionPage } from '@donmai/dashboard'
import { usePathname, useParams } from 'next/navigation'

export default function SessionDetailPage() {
  const pathname = usePathname()
  const params = useParams<{ id: string }>()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage sessionId={params.id} />
    </DashboardShell>
  )
}
`
}

function settingsPageTsx(): string {
  return `'use client'

import { DashboardShell, SettingsPage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function Settings() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SettingsPage />
    </DashboardShell>
  )
}
`
}

function postcssConfig(): string {
  return `export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
}
`
}

function minimalPageTsx(): string {
  return `export default function HomePage() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>AgentFactory</h1>
      <p>Webhook server is running. Configure your Linear webhook to point to <code>/webhook</code>.</p>
    </main>
  )
}
`
}

function cliWorker(): string {
  return `#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(import.meta.dirname, '..', '.env.local'), quiet: true })

import { runWorker } from '@renseiai/agentfactory-cli/worker'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--capacity' && args[i + 1]) opts.capacity = args[++i]
    else if (arg === '--hostname' && args[i + 1]) opts.hostname = args[++i]
    else if (arg === '--api-url' && args[i + 1]) opts.apiUrl = args[++i]
    else if (arg === '--projects' && args[i + 1]) opts.projects = args[++i]
    else if (arg === '--dry-run') opts.dryRun = true
  }
  return opts
}

const args = parseArgs()

const apiUrl = (args.apiUrl as string) || process.env.WORKER_API_URL
const apiKey = process.env.WORKER_API_KEY

if (!apiUrl) {
  console.error('Error: WORKER_API_URL not set (use --api-url or env)')
  process.exit(1)
}
if (!apiKey) {
  console.error('Error: WORKER_API_KEY not set')
  process.exit(1)
}

const controller = new AbortController()
process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())

const capacity = args.capacity
  ? Number(args.capacity)
  : process.env.WORKER_CAPACITY
    ? Number(process.env.WORKER_CAPACITY)
    : undefined

const projects = (args.projects as string)
  ? (args.projects as string).split(',').map(s => s.trim()).filter(Boolean)
  : process.env.WORKER_PROJECTS
    ? process.env.WORKER_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
    : undefined

runWorker(
  {
    apiUrl,
    apiKey,
    hostname: args.hostname as string | undefined,
    capacity,
    dryRun: !!args.dryRun,
    projects,
  },
  controller.signal,
).catch((err) => {
  if (err?.name !== 'AbortError') {
    console.error('Worker failed:', err)
    process.exit(1)
  }
})
`
}

function cliOrchestrator(): string {
  return `#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(import.meta.dirname, '..', '.env.local'), quiet: true })

import { runOrchestrator } from '@renseiai/agentfactory-cli/orchestrator'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--project' && args[i + 1]) opts.project = args[++i]
    else if (arg === '--max' && args[i + 1]) opts.max = args[++i]
    else if (arg === '--single' && args[i + 1]) opts.single = args[++i]
    else if (arg === '--no-wait') opts.wait = false
    else if (arg === '--dry-run') opts.dryRun = true
  }
  return opts
}

const args = parseArgs()

const linearApiKey = process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN
if (!linearApiKey) {
  console.error('Error: LINEAR_API_KEY or LINEAR_ACCESS_TOKEN not set')
  process.exit(1)
}

runOrchestrator({
  linearApiKey,
  project: args.project as string | undefined,
  max: args.max ? Number(args.max) : undefined,
  single: args.single as string | undefined,
  wait: args.wait !== false,
  dryRun: !!args.dryRun,
}).then((result) => {
  if (result.errors.length > 0) process.exit(1)
}).catch((err) => {
  console.error('Orchestrator failed:', err)
  process.exit(1)
})
`
}

function cliWorkerFleet(): string {
  return `#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(import.meta.dirname, '..', '.env.local'), quiet: true })

import { runWorkerFleet } from '@renseiai/agentfactory-cli/worker-fleet'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--workers' && args[i + 1]) opts.workers = args[++i]
    else if (arg === '--capacity' && args[i + 1]) opts.capacity = args[++i]
    else if (arg === '--projects' && args[i + 1]) opts.projects = args[++i]
    else if (arg === '--dry-run') opts.dryRun = true
  }
  return opts
}

const args = parseArgs()

const apiUrl = process.env.WORKER_API_URL
const apiKey = process.env.WORKER_API_KEY

if (!apiUrl) {
  console.error('Error: WORKER_API_URL not set')
  process.exit(1)
}
if (!apiKey) {
  console.error('Error: WORKER_API_KEY not set')
  process.exit(1)
}

const controller = new AbortController()
process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())

const workers = args.workers
  ? Number(args.workers)
  : process.env.WORKER_FLEET_SIZE
    ? Number(process.env.WORKER_FLEET_SIZE)
    : undefined
const capacity = args.capacity
  ? Number(args.capacity)
  : process.env.WORKER_CAPACITY
    ? Number(process.env.WORKER_CAPACITY)
    : undefined
const projects = (args.projects as string)
  ? (args.projects as string).split(',').map(s => s.trim()).filter(Boolean)
  : process.env.WORKER_PROJECTS
    ? process.env.WORKER_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
    : undefined

runWorkerFleet(
  {
    apiUrl,
    apiKey,
    workers,
    capacity,
    dryRun: !!args.dryRun,
    projects,
  },
  controller.signal,
).catch((err) => {
  if (err?.name !== 'AbortError') {
    console.error('Fleet failed:', err)
    process.exit(1)
  }
})
`
}

function cliCleanup(): string {
  return `#!/usr/bin/env tsx
import { runCleanup, type CleanupRunnerConfig } from '@renseiai/agentfactory-cli/cleanup'

function parseArgs(): CleanupRunnerConfig {
  const args = process.argv.slice(2)
  const opts: CleanupRunnerConfig = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--path' && args[i + 1]) opts.worktreePath = args[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm cleanup [--dry-run] [--force] [--path <dir>]')
      process.exit(0)
    }
  }
  return opts
}

const result = runCleanup(parseArgs())

console.log(\`\\nSummary: scanned=\${result.scanned} orphaned=\${result.orphaned} cleaned=\${result.cleaned}\`)
if (result.errors.length > 0) {
  console.error('Errors:', result.errors)
  process.exit(1)
}
`
}

function claudeMd(opts: TemplateOptions): string {
  return `# ${opts.projectName}

AgentFactory-powered project. Uses Linear for issue tracking.

## Linear CLI

Use \`pnpm af-linear\` (or \`af-linear\`) for ALL Linear operations. All commands return JSON to stdout.

\`\`\`bash
# Issue operations
pnpm af-linear get-issue <id>
pnpm af-linear create-issue --title "Title" --team "${opts.teamKey}" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]
pnpm af-linear update-issue <id> [--title "..."] [--description "..."] [--state "..."] [--labels "..."]

# Comments
pnpm af-linear list-comments <issue-id>
pnpm af-linear create-comment <issue-id> --body "Comment text"

# Relations
pnpm af-linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>
pnpm af-linear list-relations <issue-id>
pnpm af-linear remove-relation <relation-id>

# Sub-issues
pnpm af-linear list-sub-issues <parent-issue-id>
pnpm af-linear list-sub-issue-statuses <parent-issue-id>
pnpm af-linear update-sub-issue <id> [--state "Finished"] [--comment "Done"]

# Backlog
pnpm af-linear check-blocked <issue-id>
pnpm af-linear list-backlog-issues --project "ProjectName"
pnpm af-linear list-unblocked-backlog --project "ProjectName"

# Deployment
pnpm af-linear check-deployment <pr-number> [--format json|markdown]
\`\`\`

### Key Rules

- \`--team\` is always required for \`create-issue\`
- Use \`--state\` not \`--status\`
- Use label names not UUIDs
- \`--labels\` accepts comma-separated values
- All commands return JSON to stdout

## Environment

Requires \`LINEAR_API_KEY\` or \`LINEAR_ACCESS_TOKEN\` in \`.env.local\`.

## Build & Test

\`\`\`bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm typecheck    # Type-check
pnpm test         # Run tests
\`\`\`
`
}

function agentsMd(opts: TemplateOptions): string {
  return `# ${opts.projectName}

AgentFactory-powered project. Uses Linear for issue tracking.
This file is used by OpenAI Codex agents (equivalent to .claude/CLAUDE.md for Claude agents).

## Linear CLI

Use \`pnpm af-linear\` for ALL Linear operations. All commands return JSON to stdout.

\`\`\`bash
pnpm af-linear get-issue <id>
pnpm af-linear create-issue --title "Title" --team "${opts.teamKey}" [--description "..."]
pnpm af-linear update-issue <id> [--title "..."] [--description "..."] [--state "..."]
pnpm af-linear create-comment <issue-id> --body "Comment text"
\`\`\`

### Key Rules

- \`--team\` is always required for \`create-issue\`
- Use \`--state\` not \`--status\`
- Use label names not UUIDs
- All commands return JSON to stdout

## Build & Test

\`\`\`bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm typecheck    # Type-check
pnpm test         # Run tests
\`\`\`
`
}

function agentDefinitionDeveloper(): string {
  return `# Developer Agent

You are a coding agent working on issues from the project backlog.

## Workflow

1. Read the issue requirements carefully
2. Explore the existing codebase to understand patterns
3. Implement the feature or fix
4. Write tests if the project has a test framework
5. Run \`pnpm test\` and \`pnpm typecheck\` to verify
6. Create a PR with a clear description
7. Update the Linear issue status

## Linear Status Updates

\`\`\`bash
# Mark issue as started when you begin work
pnpm af-linear update-issue <id> --state "Started"

# Post progress updates
pnpm af-linear create-comment <issue-id> --body "Implementation complete, running tests"

# Mark as finished when PR is created
pnpm af-linear update-issue <id> --state "Finished"
\`\`\`

## PR Creation

After completing the implementation:

\`\`\`bash
git add <files>
git commit -m "<issue-id>: <description>"
gh pr create --title "<issue-id>: <description>" --body "Resolves <issue-id>"
\`\`\`

## Work Result

End your work with a comment indicating the result:

\`\`\`
<!-- WORK_RESULT:passed -->
\`\`\`

Or if the work failed:

\`\`\`
<!-- WORK_RESULT:failed -->
\`\`\`

## Guidelines

- Follow existing code patterns and conventions
- Keep changes focused on the issue requirements
- Don't refactor unrelated code
- Write clear commit messages
`
}
