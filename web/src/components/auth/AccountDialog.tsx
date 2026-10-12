// Account & security: profile, password, two-factor authentication and active sessions — a dialog, not a page.
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, Download, KeyRound, Laptop, Loader2, LogOut, ShieldCheck, ShieldOff, Smartphone, UserRound } from 'lucide-react'
import { PasswordChecklist, PasswordInput } from '@/components/auth/PasswordField'
import { device, policyChecks, when } from '@/lib/account'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuth, type AuthUser } from '@/store/useAuth'

function Note({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <div
      className={cn('rounded-lg border px-3 py-2 text-[12.5px]', tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800')}
    >
      {children}
    </div>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />} {done ? 'Copied' : label}
    </Button>
  )
}

export function AccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const setUser = useAuth((s) => s.setUser)
  const [me, setMe] = useState<AuthUser | null>(null)
  const load = useCallback(async () => {
    const u = await api<AuthUser>('/auth/me')
    setMe(u)
    setUser(u)
  }, [setUser])
  useEffect(() => {
    if (open) void load().catch(() => undefined)
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[560px] max-h-[90vh] flex-col gap-3 sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4.5 text-sky-700" /> Account &amp; security
          </DialogTitle>
          <DialogDescription>Your profile, password, two-factor sign-in and the devices signed in as you.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="profile" className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="shrink-0">
            <TabsTrigger value="profile" className="px-3 text-xs">
              <UserRound className="size-3.5" /> Profile
            </TabsTrigger>
            <TabsTrigger value="password" className="px-3 text-xs">
              <KeyRound className="size-3.5" /> Password
            </TabsTrigger>
            <TabsTrigger value="mfa" className="px-3 text-xs">
              <Smartphone className="size-3.5" /> Two-factor
            </TabsTrigger>
            <TabsTrigger value="sessions" className="px-3 text-xs">
              <Laptop className="size-3.5" /> Sessions
            </TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <TabsContent value="profile">{me && <Profile me={me} />}</TabsContent>
            <TabsContent value="password">{me && <ChangePassword me={me} onDone={load} />}</TabsContent>
            <TabsContent value="mfa">{me && <TwoFactor me={me} onChange={load} />}</TabsContent>
            <TabsContent value="sessions">
              <Sessions />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function Profile({ me }: { me: AuthUser }) {
  const rows: [string, React.ReactNode][] = [
    [
      'Username',
      <span key="u" className="font-mono">
        {me.username}
      </span>,
    ],
    ['Name', me.display],
    [
      'Email',
      me.email || (
        <span key="e" className="text-slate-400">
          not set — ask an administrator
        </span>
      ),
    ],
    [
      'Role',
      <Badge key="r" variant="info">
        {me.role_label}
      </Badge>,
    ],
    [
      'Two-factor',
      me.mfa_enabled ? (
        <Badge key="m" variant="success">
          on
        </Badge>
      ) : (
        <Badge key="m" variant="warning">
          off
        </Badge>
      ),
    ],
    ['Last sign-in', when(me.last_login_at)],
    ['Password changed', when(me.password_changed_at)],
  ]
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="grid size-12 place-items-center rounded-full bg-sky-100 text-base font-bold text-sky-800 uppercase ring-1 ring-sky-200">{me.username.slice(0, 2)}</div>
        <div>
          <div className="text-[15px] font-semibold">{me.display}</div>
          <div className="text-xs text-slate-500">{me.role_label}</div>
        </div>
      </div>
      <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-slate-600">What your role can do</div>
        <div className="flex flex-wrap gap-1">
          {me.permissions.map((p) => (
            <span key={p} className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600">
              {p}
            </span>
          ))}
        </div>
      </div>
      {me.demo && <div className="text-[12px] text-amber-700">This is a demonstration account with a published password. Change it on the Password tab to keep it private.</div>}
    </div>
  )
}

function ChangePassword({ me, onDone }: { me: AuthUser; onDone: () => Promise<void> }) {
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const { ok } = policyChecks(pw, me.username, confirm)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      await api('/auth/password', { method: 'POST', body: { current_password: cur, new_password: pw } })
      setMsg({ tone: 'ok', text: 'Password changed. Other devices signed in as you have been signed out.' })
      setCur('')
      setPw('')
      setConfirm('')
      await onDone()
    } catch (x) {
      setMsg({ tone: 'error', text: (x as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-5">
      <div className="space-y-3">
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        <div className="space-y-1.5">
          <Label htmlFor="acc-cur">Current password</Label>
          <PasswordInput id="acc-cur" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acc-new">New password</Label>
          <PasswordInput id="acc-new" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acc-new2">Confirm new password</Label>
          <PasswordInput id="acc-new2" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        <Button type="submit" disabled={busy || !ok || !cur}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Change password
        </Button>
      </div>
      <div className="rounded-lg border bg-slate-50/60 p-3">
        <div className="mb-2 text-[12px] font-semibold text-slate-600">Password policy</div>
        <PasswordChecklist password={pw} username={me.username} confirm={confirm} />
        <p className="mt-3 text-[11.5px] leading-relaxed text-slate-500">Changing your password signs out every other device. This one stays signed in.</p>
      </div>
    </form>
  )
}

function TwoFactor({ me, onChange }: { me: AuthUser; onChange: () => Promise<void> }) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'scan' | 'codes' | 'disable'>('idle')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null)
  const [codes, setCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (x) {
      setErr((x as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const start = () =>
    run(async () => {
      const s = await api<{ secret: string; uri: string }>('/auth/mfa/setup', { method: 'POST', body: { password } })
      const qr = await QRCode.toDataURL(s.uri, { margin: 1, width: 360, color: { dark: '#14304f', light: '#ffffff' } })
      setSetup({ ...s, qr })
      setPassword('')
      setPhase('scan')
    })
  const enable = () =>
    run(async () => {
      const r = await api<{ recovery_codes: string[] }>('/auth/mfa/enable', { method: 'POST', body: { code } })
      setCodes(r.recovery_codes)
      setCode('')
      setPhase('codes')
      await onChange()
    })
  const disable = () =>
    run(async () => {
      await api('/auth/mfa/disable', { method: 'POST', body: { password, code } })
      setPassword('')
      setCode('')
      setPhase('idle')
      await onChange()
    })
  const download = () => {
    const blob = new Blob([`ADRMS recovery codes for ${me.username}\nEach code works once.\n\n${codes.join('\n')}\n`], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `adrms-recovery-codes-${me.username}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-4">
      <div className={cn('flex items-start gap-3 rounded-xl border p-4', me.mfa_enabled ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/60')}>
        {me.mfa_enabled ? <ShieldCheck className="mt-0.5 size-5 text-emerald-700" /> : <ShieldOff className="mt-0.5 size-5 text-amber-700" />}
        <div className="flex-1">
          <div className="text-[14px] font-semibold">{me.mfa_enabled ? 'Two-factor sign-in is on' : 'Two-factor sign-in is off'}</div>
          <div className="text-[12.5px] text-slate-600">
            {me.mfa_enabled
              ? 'Each sign-in asks for a 6-digit code from your authenticator app after the password.'
              : 'Add a second step to sign-in with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). Strongly recommended for anyone who approves dispatch.'}
          </div>
        </div>
        {phase === 'idle' &&
          (me.mfa_enabled ? (
            <Button size="sm" variant="outline" onClick={() => setPhase('disable')}>
              Turn off
            </Button>
          ) : (
            <Button size="sm" onClick={() => setPhase('confirm')}>
              Set up
            </Button>
          ))}
      </div>
      {err && <Note tone="error">{err}</Note>}

      {phase === 'confirm' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
          className="max-w-sm space-y-2"
        >
          <Label htmlFor="mfa-pw">Confirm your password to continue</Label>
          <PasswordInput id="mfa-pw" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={busy || !password}>
              {busy && <Loader2 className="size-3.5 animate-spin" />} Continue
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPhase('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {phase === 'scan' && setup && (
        <div className="grid grid-cols-[180px_1fr] gap-5">
          <img src={setup.qr} alt="QR code for your authenticator app" className="size-[180px] rounded-lg border bg-white p-1.5" />
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void enable()
            }}
            className="space-y-2.5"
          >
            <ol className="list-decimal space-y-1 pl-4 text-[12.5px] text-slate-600">
              <li>Scan the code with your authenticator app.</li>
              <li>Or enter this key by hand:</li>
            </ol>
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11.5px] tracking-wider break-all">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
              <CopyButton text={setup.secret} />
            </div>
            <Label htmlFor="mfa-code" className="pt-1">
              3. Enter the 6-digit code it shows
            </Label>
            <div className="flex gap-2">
              <Input
                id="mfa-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="w-36 font-mono text-base tracking-[0.3em]"
                placeholder="000000"
              />
              <Button type="submit" disabled={busy || code.length !== 6}>
                {busy && <Loader2 className="size-3.5 animate-spin" />} Turn on
              </Button>
            </div>
          </form>
        </div>
      )}

      {phase === 'codes' && (
        <div className="space-y-3">
          <Note tone="ok">Two-factor sign-in is on. Save these recovery codes now — they are shown only once and each works once if you lose your device.</Note>
          <div className="grid grid-cols-4 gap-2 rounded-lg border bg-slate-50 p-3 font-mono text-[13px]">
            {codes.map((c) => (
              <span key={c} className="text-center">
                {c}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <CopyButton text={codes.join('\n')} label="Copy codes" />
            <Button size="sm" variant="outline" onClick={download}>
              <Download className="size-3.5" /> Download
            </Button>
            <Button size="sm" onClick={() => setPhase('idle')}>
              I have saved them
            </Button>
          </div>
        </div>
      )}

      {phase === 'disable' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void disable()
          }}
          className="grid max-w-md grid-cols-2 gap-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="mfa-off-pw">Password</Label>
            <PasswordInput id="mfa-off-pw" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mfa-off-code">Code or recovery code</Label>
            <Input id="mfa-off-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" className="font-mono" />
          </div>
          <div className="col-span-2 flex gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={busy || !password || !code}>
              {busy && <Loader2 className="size-3.5 animate-spin" />} Turn off two-factor
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPhase('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

interface Sess {
  id: string
  created_at: number
  last_seen: number
  expires_at: number
  ip: string
  user_agent: string
  remember: boolean
  current: boolean
}

function Sessions() {
  const [rows, setRows] = useState<Sess[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => api<Sess[]>('/auth/sessions').then(setRows), [])
  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])
  const end = async (id: string | 'others') => {
    setBusy(id)
    try {
      await api(id === 'others' ? '/auth/sessions/revoke-others' : `/auth/sessions/${id}`, { method: id === 'others' ? 'POST' : 'DELETE' })
      await load()
    } finally {
      setBusy(null)
    }
  }
  if (!rows)
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="size-3.5 animate-spin" /> Loading sessions…
      </div>
    )
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-slate-600">
          {rows.length} active session{rows.length === 1 ? '' : 's'}
        </div>
        {rows.length > 1 && (
          <Button size="sm" variant="outline" onClick={() => end('others')} disabled={!!busy}>
            {busy === 'others' ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />} Sign out all other sessions
          </Button>
        )}
      </div>
      {rows.map((s) => (
        <div key={s.id} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5', s.current && 'border-sky-200 bg-sky-50/60')}>
          <Laptop className="size-4.5 text-slate-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              {device(s.user_agent)} {s.current && <Badge variant="info">This device</Badge>} {s.remember && <Badge variant="secondary">remembered</Badge>}
            </div>
            <div className="text-[11.5px] text-slate-500">
              {s.ip} · signed in {when(s.created_at)} · active {when(s.last_seen)} · ends {when(s.expires_at)}
            </div>
          </div>
          {!s.current && (
            <Button size="sm" variant="ghost" onClick={() => end(s.id)} disabled={!!busy} className="text-rose-700 hover:text-rose-800">
              {busy === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />} Sign out
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
