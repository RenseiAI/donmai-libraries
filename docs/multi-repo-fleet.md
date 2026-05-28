# Multi-Repo Fleet Pattern

Run a shared Donmai governor with per-repo workers across multiple repositories.

## Architecture

```
                          ┌──────────────┐
                          │    Linear    │
                          │  (webhooks)  │
                          └──────┬───────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Shared Governor       │
                    │   agent.example.dev     │
                    │                         │
                    │  GOVERNOR_PROJECTS=     │
                    │    Agent,Social,Family  │
                    └────────────┬────────────┘
                                 │
                          ┌──────▼──────┐
                          │    Redis    │
                          │  (shared)   │
                          └──┬───┬───┬──┘
                             │   │   │
               ┌─────────────┘   │   └──────────────┐
               │                 │                   │
    ┌──────────▼──────────┐  ┌──▼────────────┐  ┌───▼──────────────┐
    │  Worker: renseiai   │  │  Worker:      │  │  Worker:         │
    │  (TypeScript)       │  │  agentfactory │  │  RecoilEngine    │
    │                     │  │  (TypeScript) │  │  (C++)           │
    │  WORKER_PROJECTS=   │  │              │  │                  │
    │    Social,Family    │  │  WORKER_     │  │  WORKER_         │
    │                     │  │  PROJECTS=   │  │  PROJECTS=       │
    │  5 apps monorepo    │  │    Agent     │  │    Recoil        │
    └─────────────────────┘  └─────────────┘  └──────────────────┘
```

Each repo has its own worker process(es) scoped to specific Linear projects. All workers share a single Redis instance and governor deployment. The governor dispatches work; workers in each repo claim only their own projects.

## Prerequisites

Before adding a new repo to the fleet, ensure:

- A shared governor is deployed (e.g., `agent.example.dev`) with Redis
- The governor's `GOVERNOR_PROJECTS` includes your project name
- You have the shared `REDIS_URL` and `WORKER_API_URL` / `WORKER_API_KEY`
- A Linear API key with access to your project

## Step-by-Step: Add a New Project

### 1. Create `.donmai/config.yaml`

In your repository root, create the config file that identifies the repo and scopes which Linear projects it handles.

**Single-project repo:**

```yaml
apiVersion: v1
kind: RepositoryConfig
repository: github.com/your-org/your-repo
allowedProjects:
  - YourProject
```

**Monorepo with multiple projects:**

```yaml
apiVersion: v1
kind: RepositoryConfig
repository: github.com/your-org/your-monorepo
projectPaths:
  Social: apps/social
  Family: apps/family
  Extension: apps/social-capture-extension
sharedPaths:
  - packages/ui
  - packages/shared
```

Key fields:

| Field | Purpose |
|-------|---------|
| `repository` | Git remote URL pattern — validated against `git remote get-url origin` at startup |
| `allowedProjects` | Linear project names this repo handles (simple list) |
| `projectPaths` | Maps project names to directories (monorepo — mutually exclusive with `allowedProjects`) |
| `sharedPaths` | Directories any project's agent may modify (only with `projectPaths`) |

### 2. Create `.env.local`

Create a `.env.local` in your repository root with the shared fleet credentials and project-specific settings.

```bash
# ── Shared across the fleet ──

# Linear API key (used by CLI tools: af-linear, orchestrator, worker)
LINEAR_API_KEY=lin_api_...

# Redis — same instance as the governor
REDIS_URL=redis://your-shared-redis:6379

# Governor webhook server URL and API key
WORKER_API_URL=https://agent.example.dev
WORKER_API_KEY=your-shared-api-key

# ── Project-specific ──

# Only accept work for this repo's projects
WORKER_PROJECTS=YourProject

# Agent provider (default: claude)
AGENT_PROVIDER=claude

# Optional: per-project provider override
# AGENT_PROVIDER_YOURPROJECT=codex
```

### 3. Add your project to the governor

On the shared governor deployment (e.g., `agent.example.dev`), add your project to `GOVERNOR_PROJECTS`:

```bash
# Before
GOVERNOR_PROJECTS=Agent,Social,Family

# After
GOVERNOR_PROJECTS=Agent,Social,Family,YourProject
```

Redeploy the governor for the change to take effect.

### 4. Install Donmai packages

**TypeScript projects:**

```bash
npm install @donmai/core @donmai/plugin-linear @donmai/cli @donmai/server
```

Or scaffold a full project with the CLI:

```bash
npx @donmai/create-app my-agent
```

**Non-TypeScript projects:** See [Non-TypeScript Projects](#non-typescript-projects) below.

### 5. Start the worker

Run the worker process in your repo. It connects to the shared Redis queue and claims work only for its `WORKER_PROJECTS`.

**Single worker:**

```bash
af-worker \
  --api-url $WORKER_API_URL \
  --api-key $WORKER_API_KEY \
  --projects YourProject \
  --capacity 3
```

**Worker fleet (multiple processes):**

```bash
af-worker-fleet \
  -w 4 \       # 4 worker processes
  -c 3 \       # 3 agents per worker = 12 concurrent agents
  --projects YourProject
```

When `WORKER_API_URL`, `WORKER_API_KEY`, and `WORKER_PROJECTS` are set in `.env.local`, you can simply run:

```bash
af-worker
# or
af-worker-fleet
```

### 6. Configure the Linear webhook

If you're using the shared governor's webhook server, no additional webhook setup is needed — the governor already receives events for all projects listed in `GOVERNOR_PROJECTS`.

If your repo has its own Next.js webhook server, configure it in Linear:

1. Go to **Settings > API > Webhooks**
2. Create a webhook pointing to your server's `/webhook` endpoint
3. Enable `AgentSession` and `Issue` events
4. Set `LINEAR_WEBHOOK_SECRET` in your `.env.local`

### 7. Verify the setup

```bash
# Confirm the worker connects and registers
af-worker --api-url $WORKER_API_URL --api-key $WORKER_API_KEY --projects YourProject

# Test the Linear CLI
af-linear list-backlog-issues --project YourProject

# Dry-run the orchestrator to see what would be processed
af-orchestrator --project YourProject --dry-run
```

## Environment Variable Reference

### Shared Fleet Variables

These are the same across all repos in the fleet:

| Variable | Description |
|----------|-------------|
| `LINEAR_API_KEY` | Linear API key for CLI tools |
| `REDIS_URL` | Shared Redis connection URL |
| `WORKER_API_URL` | Governor webhook server URL |
| `WORKER_API_KEY` | API key for worker authentication |

### Per-Repo Variables

These differ per repository:

| Variable | Description | Example |
|----------|-------------|---------|
| `WORKER_PROJECTS` | Comma-separated project names to accept | `Social,Family` |
| `AGENT_PROVIDER` | Default agent provider | `claude` |
| `AGENT_PROVIDER_{PROJECT}` | Per-project provider override | `AGENT_PROVIDER_RECOIL=claude` |
| `WORKER_FLEET_SIZE` | Number of worker processes | `4` |
| `WORKER_CAPACITY` | Agents per worker process | `3` |

### Governor Variables

Set on the shared governor deployment only:

| Variable | Default | Description |
|----------|---------|-------------|
| `GOVERNOR_PROJECTS` | — | All projects across the fleet (comma-separated) |
| `GOVERNOR_MODE` | `direct` | `direct`, `event-bridge`, or `governor-only` |
| `GOVERNOR_POLL_INTERVAL_MS` | `300000` | Safety-net poll sweep interval (5 min) |

## Non-TypeScript Projects

Donmai's worker and governor are Node.js processes, but the agents they spawn can work on any language. For non-TypeScript repos (C++, Rust, Python, etc.), the setup differs slightly.

### Install Node.js tooling alongside your project

The worker process requires Node.js. Install Donmai's CLI tools either globally or in a dedicated directory:

```bash
# Option A: global install
npm install -g @donmai/cli

# Option B: local tooling directory
mkdir -p .donmai/tools
cd .donmai/tools
npm init -y
npm install @donmai/cli
```

### Create a CLAUDE.md (or equivalent)

Agents receive their instructions from a `CLAUDE.md` file in the repo root. For non-TypeScript projects, this should include language-specific build and test commands:

```markdown
# MyProject (C++)

## Build & Test

\`\`\`bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
\`\`\`

## Linear CLI

Use `af-linear` for all Linear operations:

\`\`\`bash
af-linear get-issue PROJ-123
af-linear update-issue PROJ-123 --state "Finished"
af-linear create-comment PROJ-123 --body "Implementation complete"
\`\`\`
```

### Custom workflow templates

Override the default templates to allow your project's build tools. Create `.donmai/templates/development.yaml`:

```yaml
apiVersion: v1
kind: WorkflowTemplate
metadata:
  name: development
  description: Development workflow for C++ project
  workType: development

tools:
  allow:
    - shell: "cmake *"
    - shell: "make *"
    - shell: "ctest *"
    - shell: "git commit *"
    - shell: "git push *"
    - shell: "gh pr *"
    - shell: "af-linear *"
  disallow:
    - user-input

prompt: |
  Start work on {{identifier}}.
  Implement the feature/fix as specified.

  This is a C++ project. Use cmake for building and ctest for testing.

  {{> partials/repo-validation}}
  {{> partials/cli-instructions}}
```

Templates are resolved in layers — your project-level overrides take precedence over built-in defaults.

### The af-linear shell wrapper

If `af-linear` isn't on your PATH (e.g., installed locally), create a wrapper script at the repo root:

```bash
#!/usr/bin/env bash
# af-linear — wrapper for Donmai Linear CLI
# Place in repo root or add to PATH

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# If installed locally in .donmai/tools
if [ -x "$SCRIPT_DIR/.donmai/tools/node_modules/.bin/af-linear" ]; then
  exec "$SCRIPT_DIR/.donmai/tools/node_modules/.bin/af-linear" "$@"
fi

# If installed globally
if command -v af-linear &>/dev/null; then
  exec af-linear "$@"
fi

echo "Error: af-linear not found. Install with: npm install -g @donmai/cli" >&2
exit 1
```

Make it executable: `chmod +x af-linear`

## Agent Definition Conventions

### Repository config validates scope

The `.donmai/config.yaml` file ensures agents only push to the correct repo. The `{{> partials/repo-validation}}` template partial instructs agents to verify `git remote get-url origin` matches the configured `repository` field before pushing.

### Path scoping for monorepos

When using `projectPaths`, the `{{> partials/path-scoping}}` template partial restricts agents to their project's directory and shared paths. Before committing, agents verify changed files are within scope using `git diff --name-only --cached`.

### Worktree isolation

Each agent runs in its own git worktree (e.g., `../myrepo.wt/PROJ-123-DEV`). This prevents conflicts between concurrent agents. Workers handle worktree creation and cleanup — agents must never modify the worktree lifecycle.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Worker not claiming work | Verify `WORKER_PROJECTS` matches the Linear project name exactly (case-sensitive) |
| Worker can't connect | Check `WORKER_API_URL` and `WORKER_API_KEY` match the governor deployment |
| Redis connection refused | Verify `REDIS_URL` is reachable from the worker machine |
| Agent pushes to wrong repo | Add/fix the `repository` field in `.donmai/config.yaml` |
| Agent modifies wrong files | Use `projectPaths` + `sharedPaths` in config.yaml for monorepos |
| Governor not dispatching | Verify project is in `GOVERNOR_PROJECTS` and governor has been redeployed |
| `af-linear` not found | Install CLI tools: `npm install -g @donmai/cli` |

## Next Steps

- [Getting Started](./getting-started.md) — initial setup guide
- [Architecture](./architecture.md) — system design overview
- [Configuration](./configuration.md) — complete environment variable reference
- [Governor Workflow](./governor-pm-workflow.md) — governor decision engine details
- [Providers](./providers.md) — multi-provider configuration
