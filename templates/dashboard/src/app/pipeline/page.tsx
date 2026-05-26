'use client'

import { DashboardShell, PipelinePage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function Pipeline() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <PipelinePage />
    </DashboardShell>
  )
}
