# Quality Gates

Quality gates prevent agents from degrading codebase health. They address the "diffusion of responsibility" problem where every agent assumes test/typecheck/lint failures are pre-existing and ignores them, leading to cumulative quality drift.

The system has three layers:

1. **Baseline-Diff Gate** — captures quality metrics before the agent starts, compares after, blocks promotion if the agent made things worse
2. **Quality Ratchet** — monotonic thresholds committed to the repo that can only tighten (improve), never loosen
3. **Prompt-Level Guidance** — TDD workflow, boy scout rule, and self-check instructions baked into agent templates

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│                    Agent Session Lifecycle                        │
│                                                                  │
│  1. createWorktree()                                             │
│     └─ Capture quality baseline on main                          │
│        (test counts, typecheck errors, lint errors)              │
│        → .agent/quality-baseline.json                            │
│                                                                  │
│  2. spawnAgent()                                                 │
│     └─ Inject baseline into template context                     │
│        Agent sees: "You started with 0 failing tests,            │
│        3 type errors. Don't make it worse."                      │
│                                                                  │
│  3. Agent works (TDD: red → green → refactor)                    │
│     └─ Self-checks delta before committing                       │
│                                                                  │
│  4. Post-session backstop                                        │
│     └─ Quality delta check:                                      │
│        captureCurrentQuality() → computeQualityDelta()           │
│        If delta > 0 → BLOCK promotion, post diagnostic           │
│        If delta < 0 → Log boy-scout improvement                  │
│                                                                  │
│  5. QA agent (baseline-aware)                                    │
│     └─ Distinguishes agent-caused vs pre-existing failures       │
│                                                                  │
│  6. Merge queue                                                  │
│     └─ Quality ratchet check before merge                        │
│        If thresholds violated → reject                           │
│        If metrics improved → tighten ratchet                     │
│                                                                  │
│  7. CI                                                           │
│     └─ quality-ratchet job validates every PR                    │
└──────────────────────────────────────────────────────────────────┘
```

## Configuration

Enable quality gates in `.donmai/config.yaml`:

```yaml
quality:
  baselineEnabled: true    # Capture baseline + post-session delta check
  ratchetEnabled: true     # Enforce quality ratchet in merge queue
  boyscoutRule: true       # Include "fix issues in files you touch" instructions
  tddWorkflow: true        # Include red/green/refactor workflow instructions
```

All settings default to `false`/`true` respectively. The `quality` section is optional — omitting it disables baseline capture and ratchet enforcement while keeping prompt-level guidance enabled.

## Baseline-Diff Gate

### What It Captures

The orchestrator runs three commands on the worktree and parses their output:

| Metric | Command | Parser |
|--------|---------|--------|
| Test counts (total, passed, failed, skipped) | `{testCommand} -- --reporter=json` | Vitest/Jest JSON output |
| Typecheck error count | `{validateCommand}` | Count `error TS\d+` lines in stderr |
| Lint error count | `{lintCommand}` (if configured) | ESLint summary line or error line count |

Commands are resolved from the repository config (`testCommand`, `validateCommand`) or default to `pnpm test`, `pnpm typecheck`.

### When It Runs

**Baseline capture** happens once per worktree, at the end of `createWorktree()`, after the worktree is initialized on `main`. The result is stored in `.agent/quality-baseline.json` inside the worktree.

**Delta check** happens after the session backstop, before auto-transition. The orchestrator re-runs the same commands on the agent's branch, computes the delta, and decides:

| Delta | Result |
|-------|--------|
| All metrics same or better | Gate passes, promotion proceeds |
| Any failure metric increased | Gate fails, `agent.status = 'failed'`, diagnostic comment posted |
| Metrics improved | Gate passes, improvement logged |

### Delta Computation

```
testFailuresDelta  = current.tests.failed    - baseline.tests.failed
typeErrorsDelta    = current.typecheck.errors - baseline.typecheck.errors
lintErrorsDelta    = current.lint.errors      - baseline.lint.errors
testCountDelta     = current.tests.total      - baseline.tests.total

passed = testFailuresDelta <= 0
      && typeErrorsDelta   <= 0
      && lintErrorsDelta   <= 0
```

A negative `testCountDelta` (tests were removed) generates a warning in the report but does not fail the gate.

### Failure Handling

When the quality gate fails, the orchestrator:

1. Posts a markdown comment to the issue with a comparison table
2. Sets `agent.status = 'failed'` and `agent.workResult = 'failed'`
3. The auto-transition block transitions the issue to the failure status
4. The escalation governor triggers a retry — the retry agent receives the baseline in its prompt and knows not to regress

### Graceful Degradation

- If baseline capture fails during worktree creation, a warning is logged but the worktree is created normally. The agent simply won't have baseline data in its prompt and no post-session delta check runs.
- If the post-session delta check fails (e.g., test command hangs), the error is caught and logged. The session proceeds without quality gating.
- If no `.agent/quality-baseline.json` exists (older worktree, manual worktree), the delta check is skipped.

## Quality Ratchet

The quality ratchet is a committed JSON file that stores the best-known quality thresholds. It lives at `.donmai/quality-ratchet.json`:

```json
{
  "version": 1,
  "updatedAt": "2026-03-30T00:00:00Z",
  "updatedBy": "SUP-456",
  "thresholds": {
    "testCount": { "min": 847 },
    "testFailures": { "max": 0 },
    "typecheckErrors": { "max": 12 },
    "lintErrors": { "max": 34 }
  }
}
```

### Rules

| Threshold | Direction | Meaning |
|-----------|-----------|---------|
| `testCount.min` | Can only go **up** | Agents cannot delete tests without adding replacements |
| `testFailures.max` | Can only go **down** | Each merge that fixes a failure tightens the floor |
| `typecheckErrors.max` | Can only go **down** | Type errors ratchet toward zero |
| `lintErrors.max` | Can only go **down** | Lint errors ratchet toward zero |

### Enforcement Points

**Merge queue** (`merge-worker.ts`): After tests pass but before finalize, the worker loads the ratchet, checks thresholds, and rejects the merge if any are violated. If metrics improved, it auto-tightens the ratchet and commits the updated file (included in the merge).

**CI** (`.github/workflows/ci.yml`): The `quality-ratchet` job runs on every PR. It reads the ratchet file, runs test/typecheck, and fails if thresholds are violated. This job only runs when the ratchet file exists (`if: hashFiles(...)`).

### Initializing the Ratchet

To create the initial ratchet file, use the `initializeQualityRatchet()` function from `@donmai/core`:

```typescript
import { captureQualityBaseline, initializeQualityRatchet } from '@donmai/core'

const baseline = captureQualityBaseline('/path/to/repo', { packageManager: 'pnpm' })
const ratchet = initializeQualityRatchet('/path/to/repo', baseline)
// Commit .donmai/quality-ratchet.json
```

Or capture baseline metrics manually and create the file by hand.

## Prompt-Level Guidance

### TDD Workflow

Development agents receive explicit TDD instructions:

1. Write failing tests for the acceptance criteria (RED)
2. Implement the minimum code to pass (GREEN)
3. Refactor, keeping tests green (REFACTOR)
4. Run the full suite before committing

This is injected via the `{{> partials/quality-baseline}}` partial, conditional on `qualityBaseline` being present in the template context.

### Boy Scout Rule

Agents are instructed: "If you modify a file that has pre-existing lint warnings, type errors, or failing tests, fix them while you are there." This is scoped to files the agent is already touching to prevent merge conflicts with concurrent agents.

### Self-Check Before Commit

The `commit-push-pr` partial includes a quality delta self-check step that reminds the agent to verify it hasn't worsened metrics before committing. This catches regressions early, saving a full QA cycle.

### QA Baseline Awareness

QA agents receive the same baseline data and are instructed to distinguish agent-caused failures from pre-existing ones:

- If failures exceed baseline → HARD FAIL (agent made it worse)
- If failures equal baseline → pre-existing, do not fail QA for these

## Baseline vs Ratchet

These are complementary, not alternatives:

| Aspect | Baseline-Diff Gate | Quality Ratchet |
|--------|-------------------|-----------------|
| Scope | Per-session | Repository-wide |
| Prevents | Agent making things worse | Cumulative drift across all agents |
| Baseline source | Captured at session start | Committed in repo |
| Update frequency | Every session | On merge (auto-tighten) |
| Enforcement | Orchestrator post-session | Merge queue + CI |

Use both: the baseline-diff catches regressions in-session, and the ratchet prevents drift across many agents and branches.

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/orchestrator/quality-baseline.ts` | Capture metrics, compute deltas, format reports |
| `packages/core/src/orchestrator/quality-ratchet.ts` | Load, check, update, initialize ratchet file |
| `packages/core/src/templates/defaults/partials/quality-baseline.yaml` | TDD + boy scout + baseline instructions |
| `packages/core/src/orchestrator/orchestrator.ts` | Integration: capture, inject, check |
| `packages/core/src/merge-queue/merge-worker.ts` | Ratchet enforcement at merge time |
| `packages/core/src/config/repository-config.ts` | `quality` config section schema |
| `.donmai/config.yaml` | Per-repo quality gate settings |
| `.donmai/quality-ratchet.json` | Committed ratchet thresholds |
| `.github/workflows/ci.yml` | `quality-ratchet` CI job |

## API Reference

### `captureQualityBaseline(worktreePath, config?)`

Runs test/typecheck/lint commands and returns structured metrics.

```typescript
interface QualityBaseline {
  timestamp: string
  commitSha: string
  tests: { total: number; passed: number; failed: number; skipped: number }
  typecheck: { errorCount: number; exitCode: number }
  lint: { errorCount: number; warningCount: number }
}
```

### `computeQualityDelta(baseline, current)`

Pure arithmetic comparison. Returns `{ passed: boolean, testFailuresDelta, typeErrorsDelta, lintErrorsDelta, testCountDelta }`.

### `formatQualityReport(baseline, current, delta)`

Markdown table comparing baseline vs current with pass/fail badge.

### `loadQualityRatchet(repoRoot)`

Reads and validates `.donmai/quality-ratchet.json`. Returns `null` if not found.

### `checkQualityRatchet(ratchet, current)`

Compares current metrics against ratchet thresholds. Returns `{ passed: boolean, violations: [...] }`.

### `updateQualityRatchet(repoRoot, current, identifier)`

Tightens thresholds if current metrics are better. Returns `true` if ratchet was updated.

### `initializeQualityRatchet(repoRoot, baseline)`

Creates the initial ratchet file from a baseline snapshot.
