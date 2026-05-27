# Agent Definitions

Agent definitions tell coding agents **how to behave** for each work type in the AgentFactory pipeline. They are markdown files with YAML frontmatter that the orchestrator uses to configure agent behavior.

## How It Works

When AgentFactory spawns an agent for an issue, it selects an agent definition based on the **work type** (development, QA, acceptance, coordination). The definition is injected as system instructions that guide the agent's behavior.

```
Issue enters pipeline
  -> Orchestrator determines work type from issue status
  -> Selects agent definition for that work type
  -> Spawns coding agent with definition as instructions
  -> Agent follows the workflow defined in the markdown
```

## Included Definitions

| Definition | Work Type | Purpose |
|-----------|-----------|---------|
| [developer.md](./developer.md) | `development` | Implements features, fixes bugs, creates PRs |
| [qa-reviewer.md](./qa-reviewer.md) | `qa` | Validates implementation, runs tests, checks regressions |
| [qa-reviewer-native.md](./qa-reviewer-native.md) | `qa` (native) | QA for C++, Rust, Go — build verification, memory safety checks |
| [coordinator.md](./coordinator.md) | `coordination` | Orchestrates parallel sub-issues via Task sub-agents |
| [acceptance-handler.md](./acceptance-handler.md) | `acceptance` | Validates completion, merges PRs, cleans up |
| [backlog-writer.md](./backlog-writer.md) | `planning` | Transforms plans into structured Linear issues |

## Definition Format

```markdown
---
name: agent-name
description: When to use this agent and what it does.
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
---

# Agent Title

Brief description of the agent's role.

## Workflow

1. Step 1
2. Step 2
3. ...

## [Domain-Specific Sections]

Instructions, checklists, commands, and patterns.

## Structured Result Marker (REQUIRED)

- On success: `<!-- WORK_RESULT:passed -->`
- On failure: `<!-- WORK_RESULT:failed -->`
```

### Frontmatter Fields

| Field | Description |
|-------|-------------|
| `name` | Unique identifier for the agent |
| `description` | When the orchestrator should select this agent |
| `tools` | Comma-separated list of allowed tools |
| `model` | Which model to use (`opus`, `sonnet`, `haiku`) |
| `build_commands` | Named build commands (map of name → command string) |
| `test_commands` | Named test commands (map of name → command string) |
| `af_linear` | Custom Linear CLI command override |

### Configurable Build/Test Commands

For projects with non-standard build systems (C++, Rust, Go, etc.), you can declare
build and test commands in the frontmatter and reference them in the body:

```markdown
---
name: developer
description: C++ game engine developer
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
build_commands:
  verify: "cmake --build build-arm64/ --target engine-headless -j$(sysctl -n hw.ncpu)"
  full: "cmake --build build-arm64/ --target engine-legacy -j$(sysctl -n hw.ncpu)"
test_commands:
  unit: "ctest --test-dir build-arm64/ --output-on-failure"
af_linear: "bash tools/af-linear.sh"
---

# Developer Agent

## Build Verification

Run the verify build: `{{build_commands.verify}}`
Run the full build: `{{build_commands.full}}`

## Testing

Run unit tests: `{{test_commands.unit}}`

## Linear Updates

Use `{{af_linear}}` instead of the default `rensei linear` for all Linear operations.
```

The body uses Handlebars interpolation — `{{build_commands.verify}}` is replaced with the
actual command string from frontmatter. This lets you share agent logic across projects
by only changing the frontmatter.

### The Result Marker

The orchestrator parses agent output for `<!-- WORK_RESULT:passed -->` or `<!-- WORK_RESULT:failed -->` to determine whether to promote the issue to the next status. Without this marker, the issue status won't be updated automatically.

## Customizing for Your Project

These definitions are starting points. You should customize them for your stack:

1. **Add project-specific commands** — replace generic `pnpm turbo run test` with your actual test commands
2. **Add framework-specific agents** — create `nextjs-developer.md`, `rails-developer.md`, etc. for specialized knowledge
3. **Add deployment checks** — if using Vercel/Netlify/etc., add deployment verification to QA
4. **Add database validation** — if using migrations, add schema drift checks
5. **Tune the review checklist** — add checks specific to your codebase (e.g., i18n, accessibility)
6. **Add shared package impact checks** — if your monorepo has shared packages, require testing consumers when shared code changes

### QA for Native/Compiled Projects

For C++, Rust, Go, and other compiled languages, the QA workflow differs from TypeScript projects:

- **Build = type check** — the compiler IS the type checker, so build verification replaces `pnpm typecheck`
- **No Vercel deployment** — skip deployment validation
- **Different test runners** — `cargo test`, `ctest`, `go test`, `make test` instead of `pnpm test`
- **Domain-specific audits** — memory safety, thread safety, resource cleanup instead of linting

Use the `qa-native` strategy template or the `qa-reviewer-native.md` agent definition as your starting point.

**Option 1: Use the built-in `qa-native` strategy template**

Override `.donmai/templates/qa-native.yaml` in your project to customize commands:

```yaml
apiVersion: v1
kind: WorkflowTemplate
metadata:
  name: qa-native
  description: QA for my Rust project
  workType: qa
tools:
  allow:
    - shell: "cargo *"
    - shell: "gh pr *"
    - shell: "rensei linear *"
  disallow:
    - user-input
prompt: |
  QA {{identifier}} (Rust project).
  Build: `cargo build --release`
  Test: `cargo test`
  Lint: `cargo clippy -- -D warnings`
  ...
```

**Option 2: Use configurable build/test commands via `.donmai/config.yaml`**

The base `qa.yaml` template supports `buildCommand`, `testCommand`, and `validateCommand` context variables. Set these in `.donmai/config.yaml` to customize QA for your project without creating a separate template:

```yaml
apiVersion: v1
kind: RepositoryConfig
repository: github.com/myorg/myproject
buildCommand: "cargo build --release"
testCommand: "cargo test"
validateCommand: "cargo clippy -- -D warnings"
```

These values are injected into workflow templates as `{{buildCommand}}`, `{{testCommand}}`, and `{{validateCommand}}`.

### Creating Specialized Developer Agents

For larger projects, create multiple developer agents specialized by domain:

```markdown
---
name: frontend-developer
description: Use for issues touching React components, pages, and UI.
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
---

# Frontend Developer

Expert in React/Next.js development for this project.

## Key Patterns
- [Your component patterns]
- [Your state management approach]
- [Your styling conventions]
```

The orchestrator can select the right developer agent based on issue labels, project, or file paths affected.

## Placement

Place your agent definitions in `.claude/agents/` at the root of your repository. AgentFactory looks for them there by default, or you can configure a custom path in the orchestrator config.
