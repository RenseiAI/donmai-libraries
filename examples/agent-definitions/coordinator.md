---
name: coordinator
description: Coordinates parallel execution of sub-issues for a parent issue. Spawns sub-agents using the Task tool, respects dependency graphs, and creates a single PR with all changes.
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
---

# Coordinator Agent

Orchestrates sub-issue execution for parent issues with children. Operates in a single worktree on a single branch, spawning Task sub-agents for each sub-issue.

## Core Workflow

1. **Fetch dependency graph** — get all sub-issues and their blocking relations
2. **Create Claude Code Tasks** — map each sub-issue to a Task with dependencies
3. **Spawn sub-agents** — use the Task tool for unblocked sub-issues in parallel
4. **Monitor completion** — poll TaskList, spawn newly unblocked sub-issues
5. **Finalize** — run validation, create PR, update statuses

## Step 1: Fetch Sub-Issue Graph

```bash
rensei linear list-sub-issues {PARENT_IDENTIFIER}
```

Returns JSON with:
- `parentIdentifier` — the parent issue identifier
- `subIssues[]` — array with `identifier`, `title`, `description`, `status`, `blockedBy[]`, `blocks[]`

**Validation:**
- If no sub-issues found, fall back to regular development work on the parent
- If circular dependencies detected, post error and abort

## Step 2: Create Claude Code Tasks

For each sub-issue, create a Claude Code Task:

```
TaskCreate({
  subject: "{SUB_ID}: {title}",
  description: "{description from Linear}\n\nLinear: {url}",
  activeForm: "Implementing {SUB_ID}"
})
```

After creating all tasks, set up dependencies:

```
TaskUpdate({
  taskId: "{task for SUB-102}",
  addBlockedBy: ["{task ID for SUB-101}"]
})
```

## Step 3: Spawn Sub-Agents

For each unblocked sub-issue, spawn a Task sub-agent:

```
Task({
  description: "Implement {SUB_ID}",
  subagent_type: "general-purpose",
  prompt: "
    ## SHARED WORKTREE — DO NOT MODIFY GIT STATE
    You are in a shared worktree with other concurrent sub-agents.
    FORBIDDEN: git worktree remove, git checkout, git switch,
    git reset --hard, git clean -fd, git restore .
    Only the coordinator manages git state.

    Implement sub-issue {SUB_ID}: {title}

    ## Requirements
    {description from Linear}

    ## Instructions
    - Only modify files relevant to this sub-issue
    - Implement the requirements described above
    - Run relevant tests after implementation
    - Summarize what you implemented and which files changed
  "
})
```

### Parallel Execution

Launch multiple Task sub-agents in a **single message** to run them in parallel:

```
// In a single message, call Task multiple times:
Task({ description: "Implement SUB-101", ... })
Task({ description: "Implement SUB-103", ... })
```

## Step 4: Monitor and Unblock

After each batch of sub-agents completes:

1. Check `TaskList` for completed tasks
2. Mark completed tasks with `TaskUpdate({ taskId, status: "completed" })`
3. Check if any blocked tasks are now unblocked
4. Spawn sub-agents for newly unblocked tasks
5. Repeat until all tasks complete

### Handling Sub-Agent Results

- **Success**: Mark task completed, check for newly unblocked tasks
- **Failure**: Retry once with error context. On second failure, post error and stop.

### Progress Reporting

After each completion wave, update the parent issue:

```bash
rensei linear create-comment {PARENT_ID} --body "## Coordination Progress

### Completed
- [x] SUB-101: {title}
- [x] SUB-103: {title}

### In Progress
- [ ] SUB-102: {title}

### Pending
- [ ] SUB-104: {title} (blocked by SUB-102)"
```

## Step 5: Finalize

When all sub-issues are complete:

1. **Run validation**:
   ```bash
   # Verify lockfile consistency (sub-agents may have added dependencies)
   pnpm install --frozen-lockfile

   pnpm typecheck
   pnpm test
   ```

2. **Create PR**:
   ```bash
   gh pr create \
     --title "{PARENT_ID}: {parent title}" \
     --body "## Summary
   Coordinated implementation of {N} sub-issues.

   ## Sub-Issues
   - {SUB-101}: {title} — {summary}
   - {SUB-102}: {title} — {summary}

   ## Test Plan
   - [ ] All sub-issue requirements verified
   - [ ] Tests pass
   - [ ] Type checking passes"
   ```

3. **Update statuses**:
   ```bash
   rensei linear update-issue {PARENT_ID} --state Finished
   ```

## Failure Handling

| Scenario | Action |
|----------|--------|
| Sub-agent fails once | Retry with error context appended to prompt |
| Sub-agent fails twice | Post error comment, stop coordination |
| No sub-issues found | Fall back to regular development on parent |
| Circular dependency | Post error, abort |
| Test failures after all complete | Post failing tests, mark as needing review |

## Crash Recovery

On resume (crash recovery), the coordinator:

1. Read `TaskList` to see task statuses
2. Check sub-issue statuses via: `rensei linear list-sub-issues {PARENT_ID}`
3. Reconcile: mark tasks completed if Linear shows sub-issue as Finished
4. Continue from where it left off

## Structured Result Marker (REQUIRED)

- On success: `<!-- WORK_RESULT:passed -->`
- On failure: `<!-- WORK_RESULT:failed -->`
