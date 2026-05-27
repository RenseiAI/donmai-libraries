'use client'

import Link from 'next/link'
import { cn } from '../../lib/utils'
import { Logo } from '../../components/shared/logo'
import { Separator } from '../../components/ui/separator'
import { LayoutDashboard, Columns3, Activity, Settings, ExternalLink } from 'lucide-react'

export interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
}

const defaultNavItems: NavItem[] = [
  { label: 'Fleet', href: '/', icon: <LayoutDashboard className="h-4 w-4" /> },
  { label: 'Pipeline', href: '/pipeline', icon: <Columns3 className="h-4 w-4" /> },
  { label: 'Sessions', href: '/sessions', icon: <Activity className="h-4 w-4" /> },
  { label: 'Settings', href: '/settings', icon: <Settings className="h-4 w-4" /> },
]

interface SidebarProps {
  currentPath?: string
  navItems?: NavItem[]
  className?: string
}

export function Sidebar({ currentPath = '/', navItems = defaultNavItems, className }: SidebarProps) {
  const isActive = (href: string) => {
    if (href === '/') return currentPath === '/'
    return currentPath.startsWith(href)
  }

  return (
    <aside
      className={cn(
        'flex h-full w-[220px] flex-col border-r border-donmai-surface-border/60 bg-donmai-bg-secondary/60 backdrop-blur-xl',
        className
      )}
    >
      {/* Logo area */}
      <div className="flex items-center gap-2.5 px-5 py-4">
        <Logo size={22} />
        <span className="font-display text-sm font-bold text-donmai-text-primary tracking-tight">
          Donmai
        </span>
      </div>

      <div className="px-5">
        <Separator className="bg-donmai-surface-border/60" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3 py-4">
        {navItems.map((item) => {
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-body transition-all duration-200',
                active
                  ? 'nav-active-indicator bg-donmai-surface/80 text-donmai-text-primary font-medium'
                  : 'text-donmai-text-secondary hover:bg-donmai-surface/40 hover:text-donmai-text-primary'
              )}
            >
              <span className={cn(
                'transition-colors duration-200',
                active ? 'text-donmai-accent' : ''
              )}>
                {item.icon}
              </span>
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="px-5">
        <Separator className="bg-donmai-surface-border/60" />
      </div>

      {/* Footer */}
      <div className="px-5 py-3">
        <a
          href="https://github.com/RenseiAI/donmai"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-1.5 text-2xs font-body text-donmai-text-tertiary hover:text-donmai-text-secondary transition-colors"
        >
          Donmai
          <ExternalLink className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>
      </div>
    </aside>
  )
}
