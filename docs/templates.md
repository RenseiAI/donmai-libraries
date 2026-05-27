# Templates

AgentFactory uses a Handlebars-based template system to generate agent prompts. Each work type has a workflow template that defines the prompt and tool permissions. Templates are composable through partials and customizable through layered resolution.

## Template Structure

Templates are YAML files with Handlebars interpolation:

```yaml
apiVersion: v1
kind: WorkflowTemplate
metadata:
  name: development
  description: Implement features and fixes
  workType: development
tools:
  allow:
    - { shell: "pnpm *" }
    - { shell: "git *" }
  disallow:
    - { shell: "rm -rf *" }
prompt: |
  You are a development agent working on {{identifier}}.
  {{#if mentionContext}}
  Additional context: {{mentionContext}}
  {{/if}}

  {{> partials/commit-push-pr}}
  {{> partials/quality-baseline}}
```

### WorkflowTemplate Fields

| Field | Type | Description |
|-------|------|-------------|
| `apiVersion` | `v1` | Schema version |
| `kind` | `WorkflowTemplate` | Template type discriminator |
| `metadata.name` | string | Template name |
| `metadata.description` | string | Optional description |
| `metadata.workType` | AgentWorkType | Associated work type |
| `tools.allow` | ToolPermission[] | Allowed tool patterns |
| `tools.disallow` | ToolPermission[] | Forbidden tool patterns |
| `prompt` | string | Handlebars template for the agent prompt |

### PartialTemplate Fields

Partials are reusable instruction blocks composed into templates via `{{> partials/name}}`:

```yaml
apiVersion: v1
kind: PartialTemplate
metadata:
  name: commit-push-pr
  description: Git commit, push, and PR creation instructions
  frontend: linear    # Optional: frontend-specific
content: |
  When your work is complete:
  1. Commit changes with a descriptive message
  2. Push the branch
  3. Create a pull request
```

## Built-in Templates

### Workflow Templates

| Template | Work Type | Description |
|----------|-----------|-------------|
| `development.yaml` | `development` | Feature implementation |
| `development-retry.yaml` | `development` | Retry strategy for failed development |
| `inflight.yaml` | `inflight` | Continue in-progress work |
| `inflight-coordination.yaml` | `inflight-coordination` | Coordinate inflight sub-issues |
| `qa.yaml` | `qa` | Quality assurance testing |
| `qa-native.yaml` | `qa` | QA for native/compiled projects |
| `qa-retry.yaml` | `qa` | QA retry strategy |
| `qa-coordination.yaml` | `qa-coordination` | Multi-issue QA coordination |
| `acceptance.yaml` | `acceptance` | Final acceptance testing |
| `acceptance-coordination.yaml` | `acceptance-coordination` | Multi-issue acceptance |
| `refinement.yaml` | `refinement` | Feedback-based refinement |
| `refinement-context-enriched.yaml` | `refinement` | Enriched refinement with extra context |
| `refinement-decompose.yaml` | `refinement` | Decompose complex issue into sub-issues |
| `refinement-coordination.yaml` | `refinement-coordination` | Multi-issue refinement |
| `coordination.yaml` | `coordination` | Sub-issue orchestration |
| `research.yaml` | `research` | Discovery and analysis |
| `backlog-creation.yaml` | `backlog-creation` | Create issues from research |
| `merge.yaml` | `merge` | PR merge operations |
| `security.yaml` | `security` | Security scanning |

### Built-in Partials

| Partial | Description |
|---------|-------------|
| `quality-baseline` | Quality metrics validation (baseline-diff checks) |
| `commit-push-pr` | Git commit, push, and PR creation workflow |
| `cli-instructions` | Linear CLI usage instructions |
| `code-intelligence-instructions` | Code search and indexing tool instructions |
| `path-scoping` | Monorepo path restrictions |
| `repo-validation` | Git repository URL validation |
| `ios-build-validation` | iOS-specific build validation |
| `native-build-validation` | Native/compiled project build validation |
| `dependency-instructions` | Dependency management instructions |
| `human-blocker-instructions` | Human escalation handling |
| `large-file-instructions` | Large file handling instructions |
| `shared-worktree-safety` | Cross-project safety constraints |
| `task-lifecycle` | Task management lifecycle |
| `work-result-marker` | Result marker detection |
| `pr-selection` | PR selection logic |
| `agent-bug-backlog` | Instructions for logging agent issues |

**Governor partials** (escalation workflows):

| Partial | Description |
|---------|-------------|
| `governor/decomposition-proposal` | Sub-issue decomposition template |
| `governor/escalation-alert` | Alert for escalation events |
| `governor/review-request` | Request for human review |

## Template Context Variables

Variables available for interpolation in templates (`{{variableName}}`):

### Core Variables

| Variable | Type | Description |
|----------|------|-------------|
| `identifier` | string | Issue ID, e.g., "SUP-123" |
| `mentionContext` | string | User mention text providing additional context |
| `startStatus` | string | Status when agent starts (e.g., "Started") |
| `completeStatus` | string | Status when agent completes (e.g., "Finished") |

### Parent Issue Context (Coordination)

| Variable | Type | Description |
|----------|------|-------------|
| `parentContext` | string | Enriched prompt for parent issues with sub-issues |
| `subIssueList` | string | Formatted list of sub-issues with statuses |

### Escalation / Workflow State

| Variable | Type | Description |
|----------|------|-------------|
| `cycleCount` | number | Current escalation cycle count |
| `strategy` | string | Current strategy: `normal`, `context-enriched`, `decompose`, `escalate-human` |
| `failureSummary` | string | Accumulated failure summary across cycles |
| `attemptNumber` | number | Attempt number within current phase |
| `previousFailureReasons` | string[] | List of previous failure reasons |
| `totalCostUsd` | number | Total cost in USD across all attempts |

### Governor Notification

| Variable | Type | Description |
|----------|------|-------------|
| `blockerIdentifier` | string | Blocker issue identifier |
| `team` | string | Team name for sub-issue creation |

### Repository / Project

| Variable | Type | Description |
|----------|------|-------------|
| `repository` | string | Git repo URL pattern for validation |
| `projectPath` | string | Root directory for this project (monorepo) |
| `sharedPaths` | string[] | Shared directories any project agent may modify |

### Tool / Runtime

| Variable | Type | Description |
|----------|------|-------------|
| `useToolPlugins` | boolean | When true, use in-process `af_linear_*` tools instead of CLI |
| `hasCodeIntelligence` | boolean | Whether code intelligence tools (`af_code_*`) are available |
| `linearCli` | string | Command to invoke the Linear CLI (default: "pnpm af-linear") |
| `packageManager` | string | Package manager: pnpm, npm, yarn, bun, none |
| `model` | string | Resolved model ID for the agent (e.g., "claude-sonnet-4-20250514") |
| `subAgentModel` | string | Model ID for sub-agents spawned via the Task tool |

### Build / Test Commands

| Variable | Type | Description |
|----------|------|-------------|
| `buildCommand` | string | Build command (e.g., "cargo build", "make") |
| `testCommand` | string | Test command (e.g., "cargo test", "pnpm test") |
| `validateCommand` | string | Validation command (e.g., "cargo clippy", "go vet") |

### Data / State

| Variable | Type | Description |
|----------|------|-------------|
| `phaseOutputs` | Record | Outputs from upstream phases, keyed by phase then output key |
| `agentBugBacklog` | string | Linear project for agent-improvement issues |
| `mergeQueueEnabled` | boolean | Whether a merge queue handles rebase/merge |
| `conflictWarning` | string | File conflict prediction warning (set when reserved files overlap) |
| `qualityBaseline` | object | Quality metrics baseline: `{ tests: { total, passed, failed }, typecheckErrors, lintErrors }` |

## Customizing Templates

### Creating Custom Templates

Place custom templates in `.donmai/templates/` at the root of your repo:

```
.donmai/
  config.yaml
  templates/
    development.yaml       # Override the development template
    my-custom-qa.yaml      # Custom QA template
    partials/
      my-instructions.yaml # Custom partial
```

### Overriding Built-in Partials

To override a built-in partial, create a file with the same name in your `.donmai/templates/partials/` directory:

```yaml
# .donmai/templates/partials/commit-push-pr.yaml
apiVersion: v1
kind: PartialTemplate
metadata:
  name: commit-push-pr
  description: Custom git workflow for our team
content: |
  When your work is complete:
  1. Run our custom pre-commit hooks: pnpm lint:fix
  2. Commit with conventional commit format
  3. Push and create PR with our template
```

### Template Resolution Layers

Templates are resolved in order (later layers override earlier):

1. **Built-in defaults** — shipped with AgentFactory (`packages/core/src/templates/defaults/`)
2. **Project-level overrides** — each directory in `templateDirs` (in order)
3. **Inline config overrides** — passed via `TemplateRegistryConfig.templates` (highest priority)

For partials, the same layering applies. A partial in your project's `partials/` directory overrides the built-in partial with the same name.

### Strategy-Aware Resolution

Templates support strategy-aware lookup. Given a `(workType, strategy)` tuple, the registry:

1. Looks for `{workType}-{strategy}` (e.g., `refinement-context-enriched`)
2. Falls back to `{workType}` (e.g., `refinement`)

This enables the escalation governor to select different templates as retry strategies evolve.

### Programmatic Configuration

```typescript
import { TemplateRegistry } from '@renseiai/agentfactory'

const registry = TemplateRegistry.create({
  // Directories to scan (searched in order)
  templateDirs: ['.donmai/templates'],

  // Inline overrides (highest priority)
  templates: {
    development: myCustomDevTemplate,
  },

  // Load built-in defaults (default: true)
  useBuiltinDefaults: true,

  // Frontend discriminator for partial resolution
  frontend: 'linear',
})

// Render a prompt
const prompt = registry.renderPrompt('development', {
  identifier: 'SUP-123',
  mentionContext: 'Implement the login page',
  useToolPlugins: true,
})
```

## Tool Permissions

Templates define tool permissions using a provider-agnostic format:

```yaml
tools:
  allow:
    - { shell: "pnpm *" }      # Shell command pattern
    - { shell: "git *" }
    - user-input                 # Allow user input prompts
  disallow:
    - { shell: "rm -rf *" }
```

The `ToolPermissionAdapter` translates these to provider-native format:
- **Claude:** `{ shell: "pnpm *" }` → `"Bash(pnpm:*)"`
- Other providers use their own translation layer.
