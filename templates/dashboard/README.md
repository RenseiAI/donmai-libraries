# AgentFactory Dashboard

AI agent fleet management dashboard powered by [AgentFactory](https://github.com/renseiai/agentfactory).

## One-Click Deploy

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Frenseiai%2Fagentfactory%2Ftree%2Fmain%2Ftemplates%2Fdashboard&project-name=agentfactory-dashboard&env=LINEAR_ACCESS_TOKEN,LINEAR_WEBHOOK_SECRET,REDIS_URL&envDescription=Environment%20variables%20needed%20for%20AgentFactory%20Dashboard&envLink=https%3A%2F%2Fgithub.com%2Frenseiai%2Fagentfactory%2Ftree%2Fmain%2Ftemplates%2Fdashboard%23environment-variables)

> **Note:** Vercel does not include built-in Redis. After deploying, add [Vercel KV](https://vercel.com/docs/storage/vercel-kv) from the Storage tab or create an [Upstash Redis](https://upstash.com/) database, then set the `REDIS_URL` environment variable.

**What happens when you click Deploy:**
1. Vercel clones this repository into your GitHub account
2. You're prompted for the 4 required environment variables
3. Vercel auto-detects Next.js and builds the project
4. After deploy, add Redis (Vercel KV or Upstash) and configure `REDIS_URL`
5. Set up your [Linear webhook](#2-linear-webhook) pointing to `https://your-app.vercel.app/webhook`

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/A7hIuF?referralCode=MwgIWL)

> **Advantage:** Railway bundles Redis as a companion service — Redis is provisioned automatically with the template. No separate Redis setup required.

**What happens when you click Deploy:**
1. Railway creates your project with two services: the dashboard app and a Redis instance
2. You're prompted for `LINEAR_ACCESS_TOKEN` and `LINEAR_WEBHOOK_SECRET`
3. `REDIS_URL` is auto-injected from the companion Redis service
4. The app builds via Railpack and starts with health checks on `/api/public/stats`
5. Set up your [Linear webhook](#2-linear-webhook) pointing to your Railway domain

## Quick Start (Local)

```bash
# Clone the template from the monorepo
git clone --depth 1 --filter=blob:none --sparse https://github.com/renseiai/agentfactory.git agentfactory-dashboard
cd agentfactory-dashboard
git sparse-checkout set templates/dashboard
cp -r templates/dashboard/* .
rm -rf templates .git

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Edit .env.local with your Linear API key and webhook secret

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_ACCESS_TOKEN` | Yes | Linear API key ([create here](https://linear.app/settings/api)) |
| `LINEAR_WEBHOOK_SECRET` | Yes | Webhook signature verification (32+ chars) |
| `REDIS_URL` | Yes | Redis connection string |
| `NEXT_PUBLIC_APP_URL` | No | Public URL (auto-detected on Vercel) |
| `WORKER_API_KEY` | Production | Worker authentication bearer token |
| `CRON_SECRET` | Production | Cron endpoint auth token |
| `SESSION_HASH_SALT` | Production | Session hashing salt |

See [.env.example](.env.example) for the full list with descriptions.

## Setup Guide

### 1. Linear API Key

1. Go to [Linear Settings > API](https://linear.app/settings/api)
2. Create a Personal API Key
3. Set `LINEAR_ACCESS_TOKEN` to the generated key

### 2. Linear Webhook

1. Go to [Linear Settings > API > Webhooks](https://linear.app/settings/api)
2. Create a new webhook pointing to `https://your-app.com/webhook`
3. Select events: Issue updates, Comments
4. Copy the signing secret to `LINEAR_WEBHOOK_SECRET`

### 3. Redis

**Vercel:** Add [Vercel KV](https://vercel.com/docs/storage/vercel-kv) from the Storage tab, or create an [Upstash Redis](https://upstash.com/) database and copy the connection URL.

**Railway:** Redis is provisioned automatically. The `REDIS_URL` variable is injected via service reference.

**Local:** Run `redis-server` or use Docker: `docker run -p 6379:6379 redis`

## Architecture

This is a [Next.js](https://nextjs.org) application that provides:

- **Webhook server** — receives Linear webhook events and manages agent sessions
- **Fleet dashboard** — real-time overview of active agents, sessions, and pipeline
- **API routes** — worker registration, session management, and public stats
- **CLI tools** — local worker, orchestrator, and fleet management scripts

### Pages

| Route | Description |
|-------|-------------|
| `/` | Fleet overview with agent status |
| `/pipeline` | Kanban-style pipeline view |
| `/sessions` | Session list and detail views |
| `/settings` | Integration status and configuration |

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `@donmai/nextjs` | Route handlers and middleware |
| `@renseiai/agentfactory-dashboard` | UI components and pages |
| `@renseiai/agentfactory-server` | Redis-backed session/worker persistence |
| `@renseiai/plugin-linear` | Linear SDK client |

## Platform Comparison

| Feature | Vercel | Railway |
|---------|--------|---------|
| Redis included | No (add Vercel KV or Upstash) | Yes (auto-provisioned companion service) |
| Redis setup | Manual — add after deploy | Automatic — `REDIS_URL` injected |
| Auto-detect Next.js | Yes | Yes (via Railpack) |
| Custom domain | Yes | Yes |
| Health checks | Built-in | Configurable via `railway.toml` |
| CLI tools (worker, orchestrator) | Serverless only | Full Node.js runtime |
| Pricing | Free tier available | Free tier available |
| Best for | Serverless dashboard + external workers | All-in-one dashboard + local workers |

## Staying Up to Date

This template lives in the [AgentFactory monorepo](https://github.com/renseiai/agentfactory/tree/main/templates/dashboard). When new versions of `@renseiai/agentfactory-*` packages are released, this template is updated in-tree.

To manually update package versions:

```bash
npm install @renseiai/agentfactory@latest @renseiai/plugin-linear@latest \
  @donmai/nextjs@latest @renseiai/agentfactory-server@latest \
  @renseiai/agentfactory-dashboard@latest @donmai/cli@latest
```

## License

MIT
