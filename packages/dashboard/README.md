# @donmai/dashboard

A self-contained React component library for Donmai fleet management. Provides a complete dashboard UI with real-time data fetching, a dark design system with orange accent, and four page-level components.

## Deploy

Want to run the dashboard without building from source? Use the one-click deploy template:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRenseiAI%2Fdonmai-libraries%2Ftree%2Fmain%2Ftemplates%2Fdashboard&project-name=donmai-dashboard&env=LINEAR_ACCESS_TOKEN,LINEAR_WEBHOOK_SECRET,REDIS_URL&envDescription=Environment%20variables%20needed%20for%20Donmai%20Dashboard&envLink=https%3A%2F%2Fgithub.com%2FRenseiAI%2Fdonmai-libraries%2Ftree%2Fmain%2Ftemplates%2Fdashboard%23environment-variables)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/A7hIuF?referralCode=MwgIWL)

> Railway includes Redis automatically. Vercel requires adding [Vercel KV](https://vercel.com/docs/storage/vercel-kv) or [Upstash Redis](https://upstash.com/) after deployment.

See the [dashboard template](https://github.com/RenseiAI/donmai-libraries/tree/main/templates/dashboard) for full setup instructions.

## Installation

```bash
npm install @donmai/dashboard
# or
pnpm add @donmai/dashboard
```

### Peer Dependencies

- `next` >= 14.0.0
- `react` >= 18.0.0
- `react-dom` >= 18.0.0
- `tailwindcss` >= 3.4.0

## Quick Start

The package distributes TypeScript source — no build step. Add it to `transpilePackages` in your Next.js config:

```typescript
// next.config.ts
const nextConfig: NextConfig = {
  transpilePackages: ['@donmai/dashboard'],
}
```

### Tailwind v3

Import the globals CSS and use the tailwind preset:

```css
/* globals.css */
@import '@donmai/dashboard/styles';
```

```typescript
// tailwind.config.ts
import dashboardPreset from '@donmai/dashboard/tailwind-preset'

export default {
  presets: [dashboardPreset],
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/@donmai/dashboard/src/**/*.{ts,tsx}',
  ],
}
```

### Tailwind v4

Skip the preset and globals import. Instead, register the design tokens directly in your `globals.css`:

```css
@source "../../node_modules/@donmai/dashboard/src";

@theme {
  /* Dashboard colors */
  --color-af-bg-primary: #0A0E1A;
  --color-af-bg-secondary: #111827;
  --color-af-surface: #1A1F2E;
  --color-af-surface-border: #2A3040;
  --color-af-accent: #FF6B35;
  --color-af-status-success: #22C55E;
  --color-af-status-warning: #F59E0B;
  --color-af-status-error: #EF4444;
  --color-af-text-primary: #F9FAFB;
  --color-af-text-secondary: #9CA3AF;
  --color-af-code: #A5B4FC;

  /* Dashboard animations */
  --animate-pulse-dot: pulse-dot 2s ease-in-out infinite;
  --animate-heartbeat: heartbeat 2s ease-out infinite;

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  @keyframes heartbeat {
    0% { transform: scale(1); opacity: 0.6; }
    50% { transform: scale(1.8); opacity: 0; }
    100% { transform: scale(1); opacity: 0; }
  }
}
```

And set the `:root` CSS variables to the dashboard palette:

```css
:root {
  --background: 222 47% 7%;
  --foreground: 210 40% 98%;
  --primary: 19 100% 60%;       /* orange accent */
  --card: 222 30% 14%;
  --muted: 222 20% 22%;
  --border: 222 20% 22%;
  --ring: 19 100% 60%;
  /* ... see full palette in source */
}
```

## Pages

Four page components handle complete views with data fetching:

```tsx
import {
  DashboardShell,
  DashboardPage,
  PipelinePage,
  SessionPage,
  SettingsPage,
} from '@donmai/dashboard'
```

| Component | Route | Description |
|-----------|-------|-------------|
| `DashboardPage` | `/` | Fleet overview with stat cards and agent session grid |
| `PipelinePage` | `/pipeline` | Kanban board with queued/working/completed columns |
| `SessionPage` | `/sessions` | Session list table with status filtering |
| `SessionPage` | `/sessions/[id]` | Session detail view (pass `sessionId` prop) |
| `SettingsPage` | `/settings` | Integration status and worker list |

### Usage with Next.js App Router

Wrap each page in `DashboardShell` for the sidebar layout:

```tsx
// app/page.tsx
'use client'

import { DashboardShell, DashboardPage as FleetPage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function Home() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <FleetPage />
    </DashboardShell>
  )
}
```

```tsx
// app/sessions/[id]/page.tsx
'use client'

import { DashboardShell, SessionPage } from '@donmai/dashboard'
import { usePathname, useParams } from 'next/navigation'

export default function SessionDetail() {
  const pathname = usePathname()
  const params = useParams<{ id: string }>()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage sessionId={params.id} />
    </DashboardShell>
  )
}
```

## Layout Components

```tsx
import { DashboardShell, Sidebar, TopBar, BottomBar } from '@donmai/dashboard'
```

- **DashboardShell** — Full layout with sidebar, top bar, bottom bar, and mobile hamburger menu
- **Sidebar** — Navigation sidebar with customizable `navItems` and active state via `currentPath`
- **TopBar** — System status bar showing worker count, queue depth, uptime
- **BottomBar** — Footer bar with version and connection status

## Fleet Components

```tsx
import { FleetOverview, AgentCard, StatCard, StatusDot, ProviderIcon } from '@donmai/dashboard'
```

## Pipeline Components

```tsx
import { PipelineView, PipelineColumn, PipelineCard } from '@donmai/dashboard'
```

## Session Components

```tsx
import { SessionList, SessionDetail, SessionTimeline, TokenChart } from '@donmai/dashboard'
```

## Data Hooks

SWR-based hooks that fetch from Donmai API routes with automatic 5-second refresh:

```tsx
import { useStats, useSessions, useWorkers } from '@donmai/dashboard'
```

| Hook | Endpoint | Returns |
|------|----------|---------|
| `useStats()` | `/api/public/stats` | `{ workersOnline, agentsWorking, queueDepth, completedToday, ... }` |
| `useSessions()` | `/api/public/sessions` | `{ sessions: PublicSessionResponse[], count }` |
| `useWorkers()` | `/api/workers` | `{ workers: WorkerResponse[] }` |

## Utilities

```tsx
import { cn, formatDuration, formatCost, formatTokens, formatRelativeTime } from '@donmai/dashboard'
import { getWorkTypeConfig, getStatusConfig } from '@donmai/dashboard'
```

## UI Primitives

Re-exports of Radix-based primitives styled for the dashboard:

```tsx
import {
  Button, Card, Badge, Skeleton, Separator,
  ScrollArea, Tabs, Tooltip, Sheet, DropdownMenu,
} from '@donmai/dashboard'
```

## Design System

Dark-only theme with orange accent (`#FF6B35`). All custom colors use the `af-` prefix:

| Token | Value | Usage |
|-------|-------|-------|
| `af-bg-primary` | `#0A0E1A` | Page background |
| `af-bg-secondary` | `#111827` | Sidebar, panels |
| `af-surface` | `#1A1F2E` | Cards, active states |
| `af-surface-border` | `#2A3040` | Borders, dividers |
| `af-accent` | `#FF6B35` | Primary actions, highlights |
| `af-status-success` | `#22C55E` | Online, completed |
| `af-status-warning` | `#F59E0B` | Queued, warnings |
| `af-status-error` | `#EF4444` | Failed, errors |
| `af-text-primary` | `#F9FAFB` | Headings, labels |
| `af-text-secondary` | `#9CA3AF` | Descriptions, metadata |
| `af-code` | `#A5B4FC` | Code, identifiers |

## License

MIT
