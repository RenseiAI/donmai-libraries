# Contributing to AgentFactory

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

**Prerequisites:** Node.js 22+, pnpm 9+

```bash
# Clone the repo
git clone https://github.com/renseiai/agentfactory.git
cd agentfactory

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run type checking
pnpm typecheck

# Run tests
pnpm test
```

## Project Structure

```
packages/
  core/                @renseiai/agentfactory                       — orchestrator, providers, crash recovery
  linear/              @renseiai/plugin-linear                      — Linear issue tracker integration
  server/              @renseiai/agentfactory-server                — Redis queues, session storage, worker pool
  cli/                 @renseiai/agentfactory-cli                   — CLI tools (orchestrator, worker, fleet)
  nextjs/              @renseiai/agentfactory-nextjs                — Next.js route handlers, webhook, middleware
  dashboard/           @renseiai/agentfactory-dashboard             — Fleet management dashboard UI
  mcp-server/          @renseiai/agentfactory-mcp-server            — MCP server for external clients
  code-intelligence/   @renseiai/agentfactory-code-intelligence     — Tree-sitter AST parsing, BM25 search
  create-app/          @donmai/create-app                           — Project scaffolding tool

docs/          Documentation
examples/      Working code samples
```

### Dependency Order

```
linear (no internal deps)
  └── core (depends on linear)
        ├── server (depends on core + linear)
        ├── cli (depends on core + linear + server)
        └── nextjs (depends on core + linear + server)

create-app (no runtime deps — generates code that uses the other packages)
```

Turborepo handles building packages in the correct order.

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes in the appropriate package
3. Run `pnpm build && pnpm typecheck` to verify everything compiles
4. Run `pnpm test` to run the test suite
5. Open a pull request against `main`

### Working on a Single Package

```bash
# Build just one package (and its dependencies)
pnpm --filter @renseiai/agentfactory-nextjs build

# Typecheck one package
pnpm --filter @renseiai/agentfactory-server typecheck

# Watch mode for tests
pnpm --filter @renseiai/agentfactory test:watch
```

### ESM Build Pattern

All packages use ESM with `.js` extensions in relative imports:

```typescript
// Correct — .js extension in source .ts files
import { foo } from './bar.js'

// Incorrect — no extension
import { foo } from './bar'
```

This ensures emitted JS has proper extensions for Node.js ESM compatibility.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Add tests for new functionality
- Update the relevant package's README.md if the public API changes
- Make sure CI passes (typecheck, build, secret scan)

## Adding a New Provider

To add support for a new coding agent:

1. Create `packages/core/src/providers/my-provider.ts`
2. Implement the `AgentProvider` interface
3. Map native SDK events to `AgentEvent` types
4. Add to the provider resolution in `packages/core/src/providers/index.ts`
5. Add tests and documentation

See `packages/core/src/providers/` for existing implementations.

## Adding a Tool Plugin

Tool plugins expose CLI functionality as typed, in-process tools for Claude agents. This avoids subprocess overhead and gives agents Zod-validated parameters instead of CLI arg strings.

### Background: Why MCP?

Claude Code has a fixed set of built-in tools (Read, Write, Bash, etc.) — you can't add new ones directly. The **only extension mechanism** is MCP (Model Context Protocol) servers. The Claude Agent SDK provides `createSdkMcpServer()` which creates an MCP server **in the same process** — no IPC, no child process, no network. The SDK discovers the tools and adds them to the model's tool palette alongside the built-ins.

### Creating a Plugin

1. Create `packages/core/src/tools/plugins/my-plugin.ts`
2. Implement the `ToolPlugin` interface:

```typescript
import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ToolPlugin, ToolPluginContext } from '../types.js'

export const myPlugin: ToolPlugin = {
  name: 'af-my-plugin',       // MCP server name — tools appear as mcp__af-my-plugin__*
  description: 'My custom tools',
  createTools(context: ToolPluginContext): SdkMcpToolDefinition<any>[] {
    const apiKey = context.env.MY_API_KEY
    if (!apiKey) return []     // Return empty if prerequisites missing

    return [
      tool(
        'af_my_action',
        'Does something useful',
        { param: z.string().describe('The input parameter') },
        async (args) => {
          // Your logic here — runs in-process
          const result = await doSomething(args.param, apiKey)
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
      ),
    ]
  },
}
```

3. Register in `packages/core/src/orchestrator/orchestrator.ts`:

```typescript
import { myPlugin } from '../tools/plugins/my-plugin.js'

// In constructor:
this.toolRegistry.register(myPlugin)
```

4. Export from `packages/core/src/tools/index.ts`
5. Add tests in `packages/core/src/tools/__tests__/`

### Conventions

- Tool names: `af_{plugin}_{action}` with `snake_case` (e.g., `af_linear_get_issue`)
- Plugin `name` field becomes the MCP server name — keep it short, use `af-` prefix
- Return `[]` from `createTools()` when required env vars (API keys) are missing
- Wrap errors as `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }`
- Non-Claude providers ignore plugins — they continue using Bash-based CLI

## Reporting Issues

Use [GitHub Issues](https://github.com/renseiai/agentfactory/issues) to report bugs or request features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Node.js and pnpm versions
- Which package is affected

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
