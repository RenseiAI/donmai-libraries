'use client'

import * as React from 'react'
import { cn } from '../../lib/utils'
import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'
import { BottomBar } from './bottom-bar'
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '../../components/ui/sheet'
import { Button } from '../../components/ui/button'
import { TooltipProvider } from '../../components/ui/tooltip'
import { Menu } from 'lucide-react'
import { Logo } from '../../components/shared/logo'

interface DashboardShellProps {
  children: React.ReactNode
  currentPath?: string
  className?: string
}

export function DashboardShell({ children, currentPath = '/', className }: DashboardShellProps) {
  return (
    <TooltipProvider>
      <div className={cn('flex h-screen bg-af-bg-primary overflow-hidden', className)}>
        {/* Background effects layer */}
        <div className="fixed inset-0 mesh-gradient pointer-events-none" />
        <div className="fixed inset-0 grid-bg pointer-events-none opacity-40" />

        {/* Desktop sidebar */}
        <div className="hidden md:block relative z-10">
          <Sidebar currentPath={currentPath} />
        </div>

        {/* Main content area */}
        <div className="flex flex-1 flex-col overflow-hidden relative z-10">
          {/* Mobile header with hamburger */}
          <div className="flex items-center gap-3 border-b border-af-surface-border bg-af-bg-secondary/80 backdrop-blur-md px-4 py-2.5 md:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-af-text-secondary hover:text-af-text-primary">
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-60 p-0 border-af-surface-border bg-af-bg-secondary">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <Sidebar currentPath={currentPath} />
              </SheetContent>
            </Sheet>
            <Logo size={20} />
            <span className="text-sm font-display font-semibold text-af-text-primary tracking-tight">
              Donmai
            </span>
          </div>

          <TopBar className="hidden md:flex" />

          <main className="flex-1 overflow-auto">
            {children}
          </main>

          <BottomBar />
        </div>
      </div>
    </TooltipProvider>
  )
}
