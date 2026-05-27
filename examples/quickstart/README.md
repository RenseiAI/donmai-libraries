# Quickstart

Spawn a single coding agent on a Linear issue.

> **Tip:** For a complete project with webhook server, middleware, and CLI tools, use `npx @donmai/create-app my-agent` instead.

## Setup

```bash
# From the repo root
pnpm install

# Set your Linear API key
export LINEAR_API_KEY=lin_api_...
```

## Run

```bash
npx tsx examples/quickstart/index.ts PROJ-123
```

The agent will:

1. Create a git worktree at `../myrepo.wt/PROJ-123-DEV`
2. Fetch issue details and requirements from Linear
3. Run a Claude coding agent (configurable via `AGENT_PROVIDER`)
4. Implement the feature/fix
5. Create a pull request
6. Update the Linear issue status to Finished

## Configuration

Override the default provider:

```bash
AGENT_PROVIDER=codex npx tsx examples/quickstart/index.ts PROJ-123
```

Adjust timeouts:

```typescript
const orchestrator = createOrchestrator({
  inactivityTimeoutMs: 600_000,    // 10 minutes before timeout
  maxSessionTimeoutMs: 3_600_000,  // 1 hour hard cap
})
```
