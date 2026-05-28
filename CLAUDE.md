# AgentFactory Monorepo

Multi-agent fleet management for coding agents. This is a pnpm monorepo using Turborepo.

> **Migrating from the legacy Node CLI?** See [`docs/migration-from-legacy-cli.md`](./docs/migration-from-legacy-cli.md) for the full `@donmai/cli` → Go `af` binary mapping.

## Architecture

Authoritative architecture lives in `../donmai-architecture/` (remote: https://github.com/RenseiAI/donmai-architecture). Read in this order:

1. `001-layered-execution-model.md` — canonical synthesis. Always first.
2. The reference doc(s) for whichever layer you are working on (`002`–`008`, `011`, `013`–`016`).
3. Any open ADRs that touch your work (`ADR-*.md`).

If this project's docs conflict with `../donmai-architecture/`, the corpus wins. Either update this project's docs to align, or open an ADR to amend the corpus (do NOT amend the corpus during implementation — post a `migration:needs-spec-decision` comment on the issue and continue with adjacent work).

## Project Structure

| Package | Path | Purpose |
|---------|------|---------|
| `@renseiai/agentfactory` | `packages/core` | Orchestrator, providers, crash recovery, deployment checker |
| `@renseiai/plugin-linear` | `packages/linear` | Linear SDK client, agent sessions, webhook types |
| `@renseiai/agentfactory-server` | `packages/server` | Work queue server for webhook-driven execution |
| `@donmai/nextjs` | `packages/nextjs` | Next.js webhook handlers and middleware |
| `@renseiai/agentfactory-dashboard` | `packages/dashboard` | Fleet management dashboard UI |
| `@renseiai/agentfactory-mcp-server` | `packages/mcp-server` | MCP server exposing fleet capabilities to external clients |
| `@donmai/code-intelligence` | `packages/code-intelligence` | Tree-sitter AST parsing, BM25 search, incremental indexing |
| `@donmai/create-app` | `packages/create-app` | Project scaffolding CLI |
| `@donmai/cli` | `packages/cli` | Orchestrator, worker, Linear CLI, and admin entry points |

## Code Intelligence (Optional)

`@donmai/code-intelligence` is an **optional dependency** of the CLI. When installed, agents running via the Claude provider receive 6 in-process MCP tools:

| Tool | Purpose |
|------|---------|
| `af_code_get_repo_map` | PageRank-ranked map of the most important files |
| `af_code_search_symbols` | Find function/class/type definitions by name |
| `af_code_search_code` | BM25 keyword search with code-aware tokenization |
| `af_code_check_duplicate` | Exact + near-duplicate detection before writing code |
| `af_code_find_type_usages` | Find all switch/case, mapping objects, and usage sites for a type |
| `af_code_validate_cross_deps` | Check cross-package imports have package.json dependency entries |

**Graceful degradation:** If the package is not installed, the CLI starts normally — agents simply won't have `af_code_*` tools available. The `{{> partials/code-intelligence-instructions}}` partial provides in-process tool instructions when `useToolPlugins` is true, and CLI fallback instructions otherwise.

### Code Intelligence CLI

The same functionality is also available as CLI commands via `pnpm af-code`, enabling Task sub-agents and non-MCP contexts to use code intelligence:

```bash
# Get PageRank-ranked repository map
pnpm af-code get-repo-map [--max-files 50] [--file-patterns "*.ts,src/**"]

# Search for symbol definitions (functions, classes, types)
pnpm af-code search-symbols "<query>" [--max-results 20] [--kinds "function,class"] [--file-pattern "*.ts"]

# BM25 keyword search with code-aware tokenization
pnpm af-code search-code "<query>" [--max-results 20] [--language typescript]

# Check for duplicate code before writing
pnpm af-code check-duplicate --content "<code>"
pnpm af-code check-duplicate --content-file /tmp/snippet.ts

# Find all switch/case, mapping objects, and usage sites for a type
# Use before adding new members to a union type to identify all files needing updates
pnpm af-code find-type-usages "AgentWorkType" [--max-results 50]

# Validate cross-package imports have package.json dependency declarations
pnpm af-code validate-cross-deps [packages/linear]
```

All commands output JSON. First invocation builds the index (~5-10s); subsequent calls reuse the persisted index.

**Optional env vars for enhanced search:**
- `VOYAGE_AI_API_KEY` — Enables semantic vector embeddings (hybrid BM25 + vector mode)
- `COHERE_API_KEY` — Enables cross-encoder reranking for more precise result ordering

Without these keys, agents still get full BM25 keyword search, symbol search, repo maps, and dedup.

**Index cache:** The incremental indexer persists to `.donmai/code-index/` (add to `.gitignore`). First run builds the index; subsequent runs re-index only changed files via Merkle tree diffing.

## Linear CLI (CRITICAL)

**Use `rensei linear` for ALL Linear operations. Do NOT use Linear MCP tools.**

The Linear CLI is the Go port of the legacy `rensei linear` surface — same subcommands, same flags, same JSON-on-stdout contract — now wired through the rensei platform's CLI proxy so the org's connected Linear OAuth credential is used automatically. All agents must use this CLI instead of MCP tools for Linear interactions.

> **Binary choice:**
> - On the Rensei platform (rensei-tui installed): `rensei linear …`
> - OSS / agentfactory-tui only: `af linear …` (identical subcommand surface)
>
> Agent runtimes typically have `rensei` in PATH. The legacy `rensei linear` script has been removed.

> **Required env vars (agents do NOT rely on interactive `rensei project activate`):** seed the agent environment with the explicit values you need — `LINEAR_TEAM_NAME` for `create-issue`, plus per-invocation flags (`--team`, `--project`, `--state`, `--labels`). Defaults set by interactive `activate` are not present in agent shells.

> **Tool plugins (Claude provider only):** When agents run via the orchestrator with the Claude provider, they receive typed `af_linear_*` tools (e.g., `af_linear_get_issue`, `af_linear_create_comment`) as in-process MCP tools instead of using the CLI via Bash. These tools call the same `runLinear()` function — same behavior, no subprocess overhead. Non-Claude providers and human users use `rensei linear` as documented above. See `docs/providers.md` for details.

### Commands

```bash
# Issue operations
rensei linear get-issue <id>
rensei linear create-issue --title "Title" --team "TeamName" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]
rensei linear update-issue <id> [--title "..."] [--description "..."] [--state "..."] [--labels "..."]

# Comments
rensei linear list-comments <issue-id>
rensei linear create-comment <issue-id> --body "Comment text"

# File-based flags (for long content that exceeds CLI arg limits)
# Write content to a temp file, then pass the path:
rensei linear update-issue <id> --description-file /tmp/description.md
rensei linear create-issue --title "Title" --team "Team" --description-file /tmp/description.md
rensei linear create-comment <issue-id> --body-file /tmp/comment.md

# Relations
rensei linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>
rensei linear list-relations <issue-id>
rensei linear remove-relation <relation-id>

# Sub-issues (for coordination)
rensei linear list-sub-issues <parent-issue-id>
rensei linear list-sub-issue-statuses <parent-issue-id>
rensei linear update-sub-issue <id> [--state "Finished"] [--comment "Done"]

# Issue listing (flexible filters)
rensei linear list-issues [--project "..."] [--status "..."] [--label "..."] [--priority 2] [--assignee "me"] [--team "..."] [--limit 50] [--order-by "createdAt"] [--query "search text"]

# Blocking checks
rensei linear check-blocked <issue-id>
rensei linear list-backlog-issues --project "ProjectName"
rensei linear list-unblocked-backlog --project "ProjectName"

# Deployment
rensei linear check-deployment <pr-number> [--format json|markdown]

# Blocker creation
rensei linear create-blocker <source-issue-id> --title "Title" [--description "..."] [--team "..."] [--project "..."] [--assignee "user@email.com"]
```

### Key Rules

- `--team` is **required** for `create-issue` unless `LINEAR_TEAM_NAME` env var is set (auto-set by orchestrator)
- Use `--state` not `--status` (e.g., `--state "Backlog"`)
- Use label **names** not UUIDs (e.g., `--labels "Feature"`)
- `--labels` accepts comma-separated values: `--labels "Bug,Feature"`
- All commands return JSON to stdout — capture the `id` field for subsequent operations
- Use `--parentId` when creating sub-issues to enable coordinator orchestration

## Route Sync CLI

After upgrading `@renseiai` packages, new routes may be missing from `src/app/`. Use `af-sync-routes` to generate missing route files from the manifest.

```bash
# Preview what would be created
pnpm af-sync-routes --dry-run

# Create missing API route files
pnpm af-sync-routes

# Also sync dashboard page files
pnpm af-sync-routes --pages
```

- Never overwrites existing files
- Pages are opt-in via `--pages` (API routes sync by default)
- Use `--app-dir <path>` for non-standard app directory

## Autonomous Operation Mode

When running as an automated agent (via webhook or orchestrator), Claude operates in headless mode.

### Detection

```typescript
const isAutonomous = !!process.env.LINEAR_SESSION_ID
```

### Autonomous Behavior Rules

**When `LINEAR_SESSION_ID` is set, you are running autonomously:**

1. **Never ask for user input** — `AskUserQuestion` is disabled. Make autonomous decisions based on issue description, existing code patterns, and best practices.
2. **Make reasonable assumptions** — choose the simplest solution, follow existing patterns, document assumptions in code comments or PR description.
3. **Complete the full workflow** — implement, test (`pnpm test`, `pnpm typecheck`), create PR, report status.
4. **Handle errors gracefully** — try alternatives; if blocked, post a Linear comment and mark as failed.
5. **Never delete your own worktree** — see Worktree Lifecycle Rules below.
6. Spawn `Task` agents with `subagent_type=Explore` for research tasks

## Session Exit Gate

The orchestrator wraps every agent session with deterministic post-session validation. This ensures that paid token work actually lands — agents can't silently exit without producing expected outputs.

### How It Works

1. **Completion contracts** define what each work type must produce
2. **Output tracking** monitors tool calls during the session (comments, issue updates, sub-issues)
3. **Post-session backstop** validates the contract and auto-recovers missing outputs
4. **Diagnostic comments** are posted when gaps remain

### Completion Contracts by Work Type

| Work Type | Required Outputs |
|-----------|-----------------|
| `development`, `inflight` | Commits on branch, branch pushed, PR created |
| `qa` | Work result (passed/failed), comment posted |
| `acceptance` | Work result (passed/failed) |
| `refinement` | Comment posted |
| `refinement-coordination` | Comment posted |
| `research` | Issue description updated |
| `backlog-creation` | Sub-issues created |
| `merge` | PR merged |

### Backstop Recovery

When an agent exits without producing required outputs, the backstop can automatically:
- **Push unpushed branches** to the remote
- **Create PRs** from pushed branches that lack a PR
- **Detect existing PRs** that were created but not captured in output

Fields that require agent judgment (e.g., `work_result`, `comment_posted`) cannot be backstopped — the orchestrator posts a diagnostic comment and blocks status promotion.

### Provider Capabilities

The exit gate strategy adapts to provider capabilities:

| Provider | Message Injection | Session Resume | Exit Gate Strategy |
|----------|------------------|----------------|-------------------|
| Claude | Yes | Yes | Mid-session steering (future) + backstop |
| A2A | Yes | Yes | Mid-session steering (future) + backstop |
| Codex | No | Yes | Backstop + stop/resume fallback |
| Spring AI | No | Yes | Backstop + stop/resume fallback |

The backstop is provider-agnostic (operates on git/GitHub). Mid-session steering via `injectMessage()` is planned for providers that support it.

### Key Files

- `packages/core/src/orchestrator/completion-contracts.ts` — Contract definitions and validation
- `packages/core/src/orchestrator/session-backstop.ts` — Backstop execution and recovery
- `packages/core/src/providers/types.ts` — `AgentProviderCapabilities` interface

## File Operations Best Practices

### Read Before Write Rule

**Always read existing files before writing to them.** Claude Code enforces this — writing to an existing file without reading it first will fail.

**Correct workflow:**
1. Use Read tool to view the current file content
2. Analyze what needs to change
3. Use Edit tool for targeted changes, or Write tool for complete rewrites

### Working with Large Files

When you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with `offset`/`limit` parameters to paginate through large files
- Avoid reading auto-generated files (use Grep instead)

## Worktree Lifecycle Rules

### Worktree Directory

By default, worktrees are created in a **sibling directory** next to the repository:

```
../donmai-libraries.wt/SUP-123/   # ../{repoName}.wt/{branch}
```

This avoids filesystem watcher storms in VSCode/Cursor that occurred with the previous `.worktrees/` (in-repo) layout. The path is configurable via `worktree.directory` in `.donmai/config.yaml` using `{repoName}` and `{branch}` template variables.

**Migrating existing setups:** Run `pnpm af-migrate-worktrees` to move worktrees from `.worktrees/` to the new sibling directory layout.

### Never Delete Your Own Worktree

The orchestrator manages worktree creation and cleanup. Agents must:

1. **NEVER run**: `git worktree remove`, `git worktree prune`
2. **NEVER run**: `git checkout`, `git switch` (to a different branch)
3. **NEVER run**: `git reset --hard`, `git clean -fd`, `git restore .`
4. **NEVER delete** or modify the `.git` file in the worktree root
5. Only the orchestrator manages worktree lifecycle

### Shared Worktree Rules (Coordination)

When multiple sub-agents run concurrently in the same worktree:
- Work only on files relevant to your sub-issue
- Commit changes with descriptive messages before reporting completion
- Prefix every sub-agent prompt with: "SHARED WORKTREE — DO NOT MODIFY GIT STATE"

### Auto-Refresh Hook

`.claude/settings.json` registers a `SessionStart` hook running `scripts/refresh-worktree.sh` — active only on linked worktrees, it auto-rebases onto upstream and reinstalls deps when stale.

## Dependency Installation

Dependencies are pre-installed by the orchestrator. Do NOT run `pnpm install` unless you encounter a specific missing module error. If you must run it, run it **synchronously** (never with `run_in_background`). Never use sleep or polling loops.

## Orchestrator Usage

```bash
# Process backlog issues from a specific project
pnpm orchestrator --project ProjectName

# Process a single issue
pnpm orchestrator --single ISSUE-123

# Preview without executing
pnpm orchestrator --project ProjectName --dry-run

# Custom concurrency
pnpm orchestrator --project ProjectName --max 2

# Restrict to a specific git repository
pnpm orchestrator --project ProjectName --repo github.com/renseiai/agentfactory
```

## Repository-Scoped Orchestration

The orchestrator validates that agents only push to the correct repository. Configure via:

### .donmai/config.yaml

Checked into each repository to define allowed projects and repository identity:

```yaml
# Single-project repo
apiVersion: v1
kind: RepositoryConfig
repository: github.com/renseiai/agentfactory
allowedProjects:
  - Agent

# Monorepo with path scoping
apiVersion: v1
kind: RepositoryConfig
repository: github.com/renseiai/renseiai
projectPaths:
  Social: apps/social
  Family: apps/family
  Extension: apps/social-capture-extension
sharedPaths:
  - packages/ui
  - packages/lexical

# Monorepo with per-project build overrides (mixed platforms)
apiVersion: v1
kind: RepositoryConfig
repository: github.com/renseiai/renseiai
projectPaths:
  Social: apps/social                    # string shorthand (Node.js default)
  Family iOS:                            # object form with per-project overrides
    path: apps/family-ios
    packageManager: none
    buildCommand: "make build"
    testCommand: "make test"
    validateCommand: "make build"
sharedPaths:
  - packages/ui
```

- `repository`: Git remote URL pattern validated at startup against `git remote get-url origin`
- `allowedProjects`: Only issues from these Linear projects are processed
- `projectPaths`: Maps project names to their root directory or a full config object (mutually exclusive with `allowedProjects`). String shorthand: `ProjectName: path`. Object form: `ProjectName: { path, packageManager?, buildCommand?, testCommand?, validateCommand? }`. Per-project overrides take precedence over repo-wide defaults. When set, allowed projects are auto-derived from keys.
- `sharedPaths`: Directories any project's agent may modify (only used with `projectPaths`)

### Validation layers

1. **OrchestratorConfig.repository** — validates git remote at constructor time and before spawning agents
2. **CLI `--repo` flag** — passes repository to OrchestratorConfig from the command line
3. **.donmai/config.yaml** — auto-loaded at startup, filters issues by `allowedProjects` or `projectPaths` keys
4. **Template partial `{{> partials/repo-validation}}`** — agents verify git remote before any push
5. **Template partial `{{> partials/path-scoping}}`** — agents verify file changes are within project scope
6. **Linear project metadata** — cross-references project repo link with config

## Workflow Template System

Agent prompts are driven by YAML templates with Handlebars interpolation. Templates live in `packages/core/src/templates/defaults/` and can be overridden per project.

### Template Structure

```yaml
apiVersion: v1
kind: WorkflowTemplate
metadata:
  name: development
  description: Standard development workflow
  workType: development
tools:
  allow:
    - shell: "pnpm *"
    - shell: "git commit *"
  disallow:
    - user-input
prompt: |
  Start work on {{identifier}}.
  {{> partials/dependency-instructions}}
  {{> partials/cli-instructions}}
  {{#if mentionContext}}
  Additional context: {{mentionContext}}
  {{/if}}
```

### Customizing Templates

Override built-in templates by creating `.donmai/templates/` in your project root:

```
.donmai/
  templates/
    development.yaml      # Override development workflow
    qa.yaml               # Override QA workflow
    partials/
      custom-partial.yaml # Custom partial for {{> partials/custom-partial}}
```

Templates are resolved in layers (later overrides earlier):
1. Built-in defaults (`packages/core/src/templates/defaults/`)
2. Project-level overrides (`.donmai/templates/`)
3. Programmatic overrides (`WebhookConfig.generatePrompt` still works)

### CLI Flag

```bash
pnpm orchestrator --project MyProject --templates /path/to/templates
```

### Template Variables

| Variable | Description |
|----------|-------------|
| `{{identifier}}` | Issue ID (e.g., "SUP-123") |
| `{{mentionContext}}` | Optional user mention text |
| `{{startStatus}}` | Frontend-resolved start status |
| `{{completeStatus}}` | Frontend-resolved complete status |
| `{{parentContext}}` | Parent issue context for coordination |
| `{{subIssueList}}` | Formatted sub-issue list |
| `{{repository}}` | Git repository URL pattern for pre-push validation |
| `{{projectPath}}` | Root directory for this project in a monorepo (e.g., `apps/family`) |
| `{{sharedPaths}}` | Shared directories any project may modify (array) |
| `{{useToolPlugins}}` | When true, agents use in-process `af_linear_*` tools instead of CLI |
| `{{buildCommand}}` | Build command override for native projects (e.g., `cargo build`) |
| `{{testCommand}}` | Test command override for native projects (e.g., `cargo test`) |
| `{{validateCommand}}` | Validation command override — replaces typecheck (e.g., `cargo clippy`) |
| `{{packageManager}}` | Package manager (e.g., `pnpm`, `npm`, `none`) |
| `{{team}}` | Linear team name |
| `{{attemptNumber}}` | Retry attempt number (retry templates only) |
| `{{failureSummary}}` | Summary of previous failure (retry templates only) |
| `{{cycleCount}}` | Refinement cycle count (refinement templates only) |

### Available Partials

| Partial | Description |
|---------|-------------|
| `{{> partials/cli-instructions}}` | Linear CLI + human blocker instructions |
| `{{> partials/commit-push-pr}}` | Commit, push, and PR creation instructions |
| `{{> partials/dependency-instructions}}` | Dependency installation rules |
| `{{> partials/human-blocker-instructions}}` | Instructions for creating human-needed blocker issues |
| `{{> partials/large-file-instructions}}` | Token limit handling |
| `{{> partials/work-result-marker}}` | QA/acceptance WORK_RESULT marker |
| `{{> partials/shared-worktree-safety}}` | Shared worktree safety rules |
| `{{> partials/pr-selection}}` | PR selection guidance |
| `{{> partials/repo-validation}}` | Pre-push git remote URL validation |
| `{{> partials/path-scoping}}` | Monorepo directory scoping instructions |
| `{{> partials/native-build-validation}}` | Build system detection and safety checks for native projects |
| `{{> partials/ios-build-validation}}` | iOS/Xcode build validation for native mobile projects |
| `{{> partials/code-intelligence-instructions}}` | Code intelligence tool instructions (af_code_* tools, conditional on useToolPlugins) |
| `{{> partials/task-lifecycle}}` | Task spawning and waiting rules for coordination workflows |
| `{{> partials/scope-completion-audit}}` | Mandatory scope self-audit — prevents agents from deferring in-scope work to follow-ups |

### Tool Permissions

Templates express tool permissions in a provider-agnostic format:

```yaml
tools:
  allow:
    - shell: "pnpm *"      # → Claude: Bash(pnpm:*)
    - shell: "git commit *" # → Claude: Bash(git commit:*)
  disallow:
    - user-input            # → Claude: AskUserQuestion
```

Provider adapters translate these to native format at runtime.

## Build & Test

```bash
pnpm build        # Build all packages
pnpm test         # Run all tests
pnpm typecheck    # Type-check all packages
pnpm clean        # Clean all dist directories
```

## Publishing Hygiene

Every package under `packages/*` ships to **public** npm (and GitHub Packages). Anything in a file listed under that package's `files` array — `README.md`, `LICENSE`, `dist/**`, etc. — becomes world-readable the moment a release tag is cut.

**Before editing any `packages/*/README.md` or other file that ships in the published tarball, strip:**

- **Linear ticket IDs** — `REN-XXXX`, `REN2-XX`, `SUP-XXXX`, etc. Linear is private.
- **Private repo links** — anything under `RenseiAI/*-architecture`, `RenseiAI/rensei`, etc. returns 404 for public readers and signals the existence of private artifacts.
- **Internal Slack / Notion / GDoc links**
- **Commit SHAs that point to private branches**
- **Internal email or org-only contact info**

Some past releases shipped READMEs that leaked Linear IDs and private-repo links, requiring a re-publish patch version. The bad README still sits in npm's version-history view for those versions.

When in doubt, grep before commit:

```bash
grep -nE 'REN-[0-9]|REN2-[0-9]|SUP-[0-9]|rensei-architecture|rensei-ops|RenseiAI/rensei' packages/*/README.md
```

The same rule applies to any other public-registry assets (PyPI sdist, crates.io, Homebrew formulas, etc.) and to release notes that auto-attach to GitHub Releases when they're cut from a public repo.
