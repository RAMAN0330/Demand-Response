import { useState } from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { AdrmsMark } from '@/components/brand/AdrmsMark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/store/useAuth'

const DEMO = [
  ['operator', 'Shift Operator — approve, ack, reject'],
  ['sic', 'Shift-in-Charge — dual approval, kill switch'],
  ['analyst', 'Analyst — what-if, reports (read-only)'],
  ['engineer', 'Engineer — config, simulator, resources'],
  ['admin', 'Administrator — everything'],
]

export function LoginPage() {
  const login = useAuth((s) => s.login)
  const notice = useAuth((s) => s.notice)
  const [u, setU] = useState('operator')
  const [p, setP] = useState('operator123')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await login(u, p)
    } catch (x) {
      setErr((x as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full place-items-center bg-gradient-to-br from-sky-50 via-white to-emerald-50 p-6">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border bg-white shadow-sm md:grid-cols-2">
        <div className="flex flex-col justify-between bg-gradient-to-br from-sky-100 to-emerald-100 p-8">
          <div>
            <AdrmsMark className="size-11 shadow-sm" />
            <h1 className="mt-5 text-2xl font-extrabold tracking-[0.06em] text-sky-900">ADRMS</h1>
            <div className="text-[13px] font-medium text-slate-600">Automated Demand Response Management System</div>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Run demand response end to end: detect the grid need, forecast it, pick the cheapest reliable mix of flexible loads, batteries and generation, dispatch it under
              operator supervision, then measure delivery against baseline and settle every participant.
            </p>
          </div>
          <ul className="mt-6 space-y-1.5 text-xs text-slate-600">
            <li>• Every DR event is explained: situation → impact → prediction → recommendation → action → outcome</li>
            <li>• Human-in-the-loop by policy · dual authorisation · kill switch</li>
            <li>• Baseline-based M&amp;V, participant settlement and a hash-chained audit trail</li>
          </ul>
        </div>
        <form onSubmit={submit} className="space-y-4 p-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Sign in</h2>
            <a href="#" className="text-xs text-sky-700 hover:underline">
              ← Product overview
            </a>
          </div>
          {notice && <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{notice}</div>}
          <div className="space-y-1.5">
            <Label htmlFor="u">Username</Label>
            <Input id="u" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p">Password</Label>
            <Input id="p" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
          </div>
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />} Sign in
          </Button>
          <div className="rounded-lg border bg-slate-50 p-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Demo accounts (password = username + 123)</div>
            <div className="grid gap-1">
              {DEMO.map(([name, desc]) => (
                <button
                  type="button"
                  key={name}
                  onClick={() => {
                    setU(name)
                    setP(`${name}123`)
                  }}
                  className="flex items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-white"
                >
                  <span className="font-mono font-medium">{name}</span>
                  <span className="text-muted-foreground">{desc}</span>
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
