'use client'

import { DashboardShell, SettingsPage } from '@donmai/dashboard'
import { usePathname } from 'next/navigation'

export default function Settings() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SettingsPage />
    </DashboardShell>
  )
}
