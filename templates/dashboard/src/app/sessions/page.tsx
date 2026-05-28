'use client'

import { DashboardShell, SessionPage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function Sessions() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage />
    </DashboardShell>
  )
}
