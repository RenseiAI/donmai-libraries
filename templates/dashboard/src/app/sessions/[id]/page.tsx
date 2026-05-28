'use client'

import { DashboardShell, SessionPage } from '@donmai/dashboard'
import { usePathname, useParams } from 'next/navigation'

export default function SessionDetailPage() {
  const pathname = usePathname()
  const params = useParams<{ id: string }>()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage sessionId={params.id} />
    </DashboardShell>
  )
}
