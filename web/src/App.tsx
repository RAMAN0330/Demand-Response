import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Toaster } from '@/components/layout/Notifications'
import { SideNav } from '@/components/layout/SideNav'
import { canSee } from '@/lib/nav'
import { TopNav } from '@/components/layout/TopNav'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AdminPage } from '@/pages/AdminPage'
import { AlarmsPage } from '@/pages/AlarmsPage'
import { AnalysisPage } from '@/pages/AnalysisPage'
import { CommandCenter } from '@/pages/CommandCenter'
import { DecisionsPage } from '@/pages/DecisionsPage'
import { LandingPage } from '@/pages/LandingPage'
import { LoginPage } from '@/pages/LoginPage'
import { OperationsPage } from '@/pages/OperationsPage'
import { ReportsPage } from '@/pages/ReportsPage'
import { SheddingPage } from '@/pages/SheddingPage'
import { SimulatorPage } from '@/pages/SimulatorPage'
import { ResourcesPage } from '@/pages/ResourcesPage'
import { WhatIfPage } from '@/pages/WhatIfPage'
import { startTokenKeeper, useAuth } from '@/store/useAuth'
import { useLive } from '@/store/useLive'
import { useUI } from '@/store/useUI'

/** Public front door: the landing page, or the sign-in form at #/login (also shown when a session has expired). */
function useHash() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export default function App() {
  const signedIn = useAuth((s) => !!s.token)
  const notice = useAuth((s) => s.notice)
  const hash = useHash()
  useEffect(() => (signedIn ? startTokenKeeper() : undefined), [signedIn])
  const view = signedIn ? <Shell /> : hash === '#/login' || notice ? <LoginPage /> : <LandingPage />
  return <TooltipProvider>{view}</TooltipProvider>
}

function Shell() {
  const wanted = useUI((s) => s.page)
  const can = useAuth((s) => s.can)
  // a page this role may not open falls back to the overview (the API refuses its actions either way)
  const page = canSee(wanted, can) ? wanted : 'command'
  const ready = useLive((s) => s.topologyReady)
  const loadTopology = useLive((s) => s.loadTopology)
  const connect = useLive((s) => s.connect)
  const disconnect = useLive((s) => s.disconnect)

  useEffect(() => {
    loadTopology().catch(() => undefined)
    connect()
    return () => disconnect()
  }, [loadTopology, connect, disconnect])

  if (!ready)
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Connecting to ADRMS…
        </span>
      </div>
    )

  return (
    <div className="spatial-backdrop flex h-full flex-col overflow-hidden">
      <TopNav />
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <SideNav />
        <main key={page} className="min-h-0 min-w-0 flex-1 overflow-hidden animate-in fade-in duration-200">
        {page === 'command' && <CommandCenter />}
        {page === 'operations' && <OperationsPage />}
        {page === 'decisions' && <DecisionsPage />}
        {page === 'shedding' && <SheddingPage />}
        {page === 'alarms' && <AlarmsPage />}
        {page === 'analysis' && <AnalysisPage />}
        {page === 'whatif' && <WhatIfPage />}
        {page === 'simulator' && <SimulatorPage />}
        {page === 'resources' && <ResourcesPage />}
        {page === 'reports' && <ReportsPage />}
        {page === 'admin' && <AdminPage />}
        </main>
      </div>
      <Toaster />
    </div>
  )
}
