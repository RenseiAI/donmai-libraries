'use client'

import { DashboardShell, DashboardPage as FleetPage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function DashboardPage() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <FleetPage />
    </DashboardShell>
  )
}
