# @donmai/create-app

Scaffold a new [donmai](https://github.com/RenseiAI/donmai-libraries) project — a Next.js webhook server that processes Linear issues with coding agents.

> **Just want to deploy?** Skip scaffolding and use one-click deploy: [Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Frenseiai%2Fagentfactory%2Ftree%2Fmain%2Ftemplates%2Fdashboard&project-name=agentfactory-dashboard&env=LINEAR_ACCESS_TOKEN,LINEAR_WEBHOOK_SECRET,REDIS_URL&envDescription=Environment%20variables%20needed%20for%20AgentFactory%20Dashboard&envLink=https%3A%2F%2Fgithub.com%2Frenseiai%2Fagentfactory%2Ftree%2Fmain%2Ftemplates%2Fdashboard%23environment-variables) | [Railway](https://railway.com/deploy/A7hIuF?referralCode=MwgIWL) (includes Redis). See the [dashboard template](https://github.com/RenseiAI/donmai-libraries/tree/main/templates/dashboard) for details.

## Usage

```bash
npx @donmai/create-app my-agent
```

Then follow the prompts:

```
  create-donmai-app

  Project name (my-agent):
  Linear team key (e.g., MY): ENG
  Include dashboard UI? [Y/n]: Y
  Include CLI tools (worker, orchestrator)? [Y/n]: Y
  Include Redis for distributed workers? [Y/n]: n

  Created 28 files

  Next steps:

    cd my-agent
    cp .env.example .env.local
    # Fill in LINEAR_ACCESS_TOKEN and other secrets
    pnpm install
    pnpm dev              # Start webhook server
    pnpm worker           # Start a local worker (in another terminal)
```

## What's Generated

```
my-agent/
  .env.example              # All env vars with comments
  src/lib/config.ts         # createAllRoutes() with defaults + customization hints
  src/middleware.ts          # Auth, rate limiting, webhook verification
  src/app/webhook/route.ts  # Linear webhook endpoint
  src/app/callback/route.ts # OAuth callback
  src/app/api/...           # All 21 route re-exports (2-3 lines each)
  src/app/page.tsx          # Dashboard UI (optional)
  cli/worker.ts             # Local worker wrapper
  cli/orchestrator.ts       # Local orchestrator wrapper
  .claude/agents/           # Agent definition templates
```

## Options

```
npx @donmai/create-app [project-name] [options]

Options:
  --team <KEY>     Linear team key (default: MY)
  --no-dashboard   Skip dashboard UI
  --no-cli         Skip CLI tools (worker, orchestrator)
  --no-redis       Skip Redis/distributed worker setup
  -h, --help       Show help
```

## After Setup

1. **Configure Linear webhook** — point it to `https://your-app.vercel.app/webhook`
2. **Set webhook secret** — add `LINEAR_WEBHOOK_SECRET` to `.env.local`
3. **Customize prompts** — edit `src/lib/config.ts` to change how agents receive instructions
4. **Add agent definitions** — edit `.claude/agents/developer.md` for your stack

## Documentation

- [Getting Started](https://github.com/renseiai/agentfactory/blob/main/docs/getting-started.md)
- [Configuration Reference](https://github.com/renseiai/agentfactory/blob/main/docs/configuration.md)
- [Architecture](https://github.com/renseiai/agentfactory/blob/main/docs/architecture.md)

## License

MIT
