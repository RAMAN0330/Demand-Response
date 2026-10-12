// Sign-in: credentials → (forced password change) → (second factor) → console. Brand panel on the left, the step on the right.
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BatteryCharging, Factory, KeyRound, Loader2, Lock, LogIn, RefreshCcw, ShieldCheck, Smartphone, User as UserIcon, type LucideIcon } from 'lucide-react'
import { AdrmsMark } from '@/components/brand/AdrmsMark'
import { PasswordChecklist, PasswordInput } from '@/components/auth/PasswordField'
import { policyChecks } from '@/lib/account'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { AuthFailure, useAuth, type LoginStep } from '@/store/useAuth'

interface AuthConfig {
  demo: boolean
  demo_users: { username: string; role: string; label: string }[]
  lockout: { attempts: number; minutes: number }
  session_hours: number
  remember_days: number
}

type Step = { kind: 'credentials' } | { kind: 'mfa'; challenge: string; who: string } | { kind: 'password'; challenge: string; who: string; username: string }

export function LoginPage() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'credentials' })
  const [username, setUsername] = useState('')
  useEffect(() => {
    fetch('/api/v1/auth/config')
      .then((r) => (r.ok ? r.json() : null))
      .then(setCfg)
      .catch(() => undefined)
  }, [])

  function next(s: LoginStep, user: string) {
    if (s.status === 'mfa') setStep({ kind: 'mfa', challenge: s.challenge, who: s.user.display })
    else if (s.status === 'password_change') setStep({ kind: 'password', challenge: s.challenge, who: s.user.display, username: s.user.username || user })
  }

  return (
    <div className="grid h-full overflow-hidden bg-slate-100 lg:grid-cols-[minmax(0,1.05fr)_minmax(460px,1fr)]">
      <BrandPanel />
      <div className="relative flex min-h-0 flex-col overflow-y-auto">
        <div className="flex items-center justify-between px-8 pt-6">
          <span className="flex items-center gap-2 lg:invisible">
            <AdrmsMark className="size-7" />
            <span className="text-sm font-extrabold tracking-[0.08em] text-sky-900">ADRMS</span>
          </span>
          <a href="#" className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-sky-800">
            <ArrowLeft className="size-3.5" /> Product overview
          </a>
        </div>
        <div className="grid flex-1 place-items-center px-6 py-8">
          <div className="w-full max-w-[400px]">
            <div key={step.kind} className="animate-in fade-in slide-in-from-right-3 duration-300">
              {step.kind === 'credentials' && <Credentials cfg={cfg} username={username} setUsername={setUsername} onNext={(s) => next(s, username)} />}
              {step.kind === 'mfa' && <MfaStep challenge={step.challenge} who={step.who} onBack={() => setStep({ kind: 'credentials' })} />}
              {step.kind === 'password' && (
                <PasswordStep
                  challenge={step.challenge}
                  who={step.who}
                  username={step.username}
                  onBack={() => setStep({ kind: 'credentials' })}
                  onNext={(s) => next(s, step.username)}
                />
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-center gap-1.5 px-8 pb-5 text-[11px] text-slate-400">
          <Lock className="size-3" /> Authorised personnel only. Sign-ins and every action are recorded in a tamper-evident audit trail.
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ brand panel
function BrandPanel() {
  const ladder: [LucideIcon, string, string][] = [
    [BatteryCharging, 'Batteries', 'first: fastest, cheapest to call'],
    [Factory, 'Industrial flexibility', 'next: offers, verified against a baseline'],
    [RefreshCcw, 'Load rotation', 'last: fair, limited, always approved'],
  ]
  return (
    <div className="relative hidden overflow-hidden bg-gradient-to-br from-[#14304f] via-[#1d4472] to-[#2a5894] text-white lg:flex lg:flex-col">
      <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.07]" aria-hidden>
        <defs>
          <pattern id="login-grid" width="36" height="36" patternUnits="userSpaceOnUse">
            <path d="M36 0H0V36" fill="none" stroke="white" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#login-grid)" />
      </svg>
      <div className="pointer-events-none absolute -top-40 -right-32 size-[520px] rounded-full bg-sky-300/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 -left-24 size-[480px] rounded-full bg-emerald-300/10 blur-3xl" />

      <div className="relative flex items-center gap-3 px-12 pt-10">
        <AdrmsMark className="size-11 shadow-lg ring-1 ring-white/20" />
        <div>
          <div className="text-xl font-extrabold tracking-[0.1em]">ADRMS</div>
          <div className="text-[12px] text-sky-100/80">Automated Demand Response Management System</div>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col justify-center px-12">
        <h1 className="max-w-md text-[30px] leading-tight font-bold">Keep the grid on schedule, one shaved peak at a time.</h1>
        <p className="mt-3 max-w-md text-[14px] leading-relaxed text-sky-100/80">
          Watch the grid every second, decide with the operator in control, dispatch in a strict priority, and settle every megawatt against what was measured.
        </p>
        <PeakCurve />
        <div className="mt-2 max-w-md space-y-2">
          {ladder.map(([Icon, title, sub], i) => (
            <div
              key={title}
              className="flex items-center gap-3 rounded-xl bg-white/[0.06] px-3.5 py-2.5 ring-1 ring-white/10 backdrop-blur-sm animate-in fade-in slide-in-from-left-2 fill-mode-both"
              style={{ animationDelay: `${300 + i * 140}ms`, animationDuration: '500ms' }}
            >
              <span className="grid size-8 place-items-center rounded-lg bg-white/10 text-[11px] font-bold">{i + 1}</span>
              <Icon className="size-4.5 text-emerald-300" />
              <div className="text-[13px]">
                <span className="font-semibold">{title}</span> <span className="text-sky-100/70">{sub}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="relative flex items-center gap-5 px-12 pb-8 text-[11px] text-sky-100/70">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-emerald-300" /> Role-based access
        </span>
        <span className="flex items-center gap-1.5">
          <Smartphone className="size-3.5 text-emerald-300" /> Two-factor sign-in
        </span>
        <span className="flex items-center gap-1.5">
          <KeyRound className="size-3.5 text-emerald-300" /> Short, revocable sessions
        </span>
      </div>
    </div>
  )
}

/** The demand curve with its peak shaved: dashed is the load that would have been, solid is after demand response. */
function PeakCurve() {
  return (
    <svg viewBox="0 0 400 120" className="mt-6 mb-4 w-full max-w-md" aria-hidden>
      <path d="M0 104H400" stroke="white" strokeOpacity=".15" />
      <path d="M0 92C60 92 90 86 130 60S190 8 210 8 260 40 290 62 350 92 400 92" fill="none" stroke="#b7cfe9" strokeOpacity=".55" strokeWidth="1.6" strokeDasharray="3 4" />
      <path
        d="M0 92C60 92 90 86 130 60L150 46H262L290 62C320 80 350 92 400 92"
        fill="none"
        stroke="white"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray="1"
        className="login-draw"
      />
      <path d="M150 46H262V44C240 20 225 10 210 10S172 22 150 44Z" fill="#7dd3a8" fillOpacity=".14" />
      <g className="login-fade">
        <path d="M206 18v18M200 30l6 6 6-6" fill="none" stroke="#7dd3a8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <text x="270" y="30" fill="#c9e9d8" fontSize="11" fontWeight="600">
          peak shaved
        </text>
      </g>
      <style>{`.login-draw{stroke-dashoffset:1;animation:login-draw 1.6s .2s cubic-bezier(.4,0,.2,1) forwards}.login-fade{opacity:0;animation:login-fade .6s 1.5s forwards}@keyframes login-draw{to{stroke-dashoffset:0}}@keyframes login-fade{to{opacity:1}}@media (prefers-reduced-motion:reduce){.login-draw{animation:none;stroke-dashoffset:0}.login-fade{animation:none;opacity:1}}`}</style>
    </svg>
  )
}

// ------------------------------------------------------------------ shared bits
function Heading({ icon: Icon, title, sub }: { icon: LucideIcon; title: string; sub: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div className="mb-4 grid size-11 place-items-center rounded-xl bg-sky-100 text-sky-800 ring-1 ring-sky-200">
        <Icon className="size-5" />
      </div>
      <h2 className="text-[22px] font-bold tracking-tight text-slate-900">{title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{sub}</p>
    </div>
  )
}

function ErrorNote({ children, tone = 'error' }: { children: React.ReactNode; tone?: 'error' | 'warn' | 'info' }) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed animate-in fade-in',
        tone === 'error' && 'border-rose-200 bg-rose-50 text-rose-800',
        tone === 'warn' && 'border-amber-200 bg-amber-50 text-amber-900',
        tone === 'info' && 'border-sky-200 bg-sky-50 text-sky-900',
      )}
    >
      {children}
    </div>
  )
}

function useCountdown(until: number | null) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!until) return
    const tick = () => setNow(Date.now() / 1000)
    const t = setInterval(tick, 1000)
    const first = setTimeout(tick, 0)
    return () => {
      clearInterval(t)
      clearTimeout(first)
    }
  }, [until])
  if (!until || !now || until <= now) return null
  const s = Math.ceil(until - now)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ------------------------------------------------------------------ step 1: credentials
function Credentials({ cfg, username, setUsername, onNext }: { cfg: AuthConfig | null; username: string; setUsername: (v: string) => void; onNext: (s: LoginStep) => void }) {
  const login = useAuth((s) => s.login)
  const notice = useAuth((s) => s.notice)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [forgot, setForgot] = useState(false)
  const pwRef = useRef<HTMLInputElement>(null)
  const left = useCountdown(lockedUntil)

  async function submit(e?: React.FormEvent, u = username, p = password) {
    e?.preventDefault()
    if (!u.trim() || !p) {
      setErr('Enter your username and password.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const s = await login(u, p, remember)
      if (s.status !== 'ok') onNext(s)
    } catch (x) {
      const f = x as AuthFailure
      setErr(f.message || 'Sign-in failed.')
      setLockedUntil(f.lockedUntil ?? null)
      setPassword('')
      pwRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <Heading icon={LogIn} title="Sign in" sub="Use the account your administrator issued you." />
      <div className="space-y-4">
        {notice && <ErrorNote tone="warn">{notice}</ErrorNote>}
        {err && (
          <ErrorNote>
            {err}
            {left && (
              <span className="mt-0.5 block font-medium">
                Try again in <span className="tabular-nums">{left}</span>, or ask an administrator to unlock the account.
              </span>
            )}
          </ErrorNote>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="login-user">Username</Label>
          <div className="relative">
            <UserIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="login-user"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                setLockedUntil(null)
              }}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              className="h-10 bg-white pl-9"
              placeholder="e.g. r.sharma"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="login-pw">Password</Label>
            <button type="button" onClick={() => setForgot((v) => !v)} className="text-[12px] font-medium text-sky-700 hover:underline">
              Forgot password?
            </button>
          </div>
          <PasswordInput id="login-pw" ref={pwRef} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="h-10 bg-white" />
        </div>
        {forgot && (
          <ErrorNote tone="info">
            Passwords are reset by an ADRMS administrator (Administration → Users &amp; roles). They will give you a one-time password; you will choose a new one when you sign in.
          </ErrorNote>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-600 select-none">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
          Keep me signed in on this device{cfg ? ` for ${cfg.remember_days} days` : ''}
        </label>
        <Button type="submit" className="h-10 w-full text-[14px]" disabled={busy || !!left}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />} {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>

      {cfg?.demo && cfg.demo_users.length > 0 && (
        <div className="mt-7">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            <span className="h-px flex-1 bg-slate-200" /> Demo accounts <span className="h-px flex-1 bg-slate-200" />
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {cfg.demo_users.map((d) => (
              <button
                key={d.username}
                type="button"
                disabled={busy}
                onClick={() => {
                  setUsername(d.username)
                  setPassword(`${d.username}123`)
                  void submit(undefined, d.username, `${d.username}123`)
                }}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-600 shadow-xs transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
                title={`Sign in as ${d.username} (password ${d.username}123)`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-center text-[11px] text-slate-400">Demonstration mode: password is the username followed by 123.</div>
        </div>
      )}
    </form>
  )
}

// ------------------------------------------------------------------ step 2: second factor
function MfaStep({ challenge, who, onBack }: { challenge: string; who: string; onBack: () => void }) {
  const verify = useAuth((s) => s.verifyMfa)
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''))
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const refs = useRef<(HTMLInputElement | null)[]>([])

  async function submit(value: string) {
    setBusy(true)
    setErr(null)
    try {
      await verify(challenge, value)
    } catch (x) {
      const f = x as AuthFailure
      if (f.status === 401 && /expired/i.test(f.message)) {
        onBack()
        return
      }
      setErr(f.message)
      setDigits(Array(6).fill(''))
      setCode('')
      setTimeout(() => refs.current[0]?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }

  function put(i: number, v: string) {
    const clean = v.replace(/\D/g, '')
    if (!clean) {
      setDigits((d) => d.map((x, j) => (j === i ? '' : x)))
      return
    }
    const next = [...digits]
    for (let k = 0; k < clean.length && i + k < 6; k++) next[i + k] = clean[k]
    setDigits(next)
    const filled = next.join('')
    if (filled.length === 6) void submit(filled)
    else refs.current[Math.min(5, i + clean.length)]?.focus()
  }

  return (
    <div>
      <Heading
        icon={Smartphone}
        title="Two-factor verification"
        sub={
          <>
            Enter the 6-digit code from the authenticator app for <b className="text-slate-700">{who}</b>.
          </>
        }
      />
      <div className="space-y-4">
        {err && <ErrorNote>{err}</ErrorNote>}
        {!recovery ? (
          <div className="flex justify-between gap-2" onPaste={(e) => (e.preventDefault(), put(0, e.clipboardData.getData('text')))}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => {
                  refs.current[i] = el
                }}
                value={d}
                autoFocus={i === 0}
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                maxLength={6}
                aria-label={`Digit ${i + 1}`}
                disabled={busy}
                onChange={(e) => put(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Backspace' && !d && i > 0) refs.current[i - 1]?.focus()
                  if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
                  if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus()
                }}
                className={cn(
                  'h-13 w-full rounded-lg border bg-white text-center text-xl font-semibold text-slate-900 tabular-nums shadow-xs outline-none transition focus:border-sky-500 focus:ring-[3px] focus:ring-sky-500/20',
                  d && 'border-sky-300',
                )}
              />
            ))}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (code.trim()) void submit(code.trim())
            }}
            className="space-y-1.5"
          >
            <Label htmlFor="login-rc">Recovery code</Label>
            <Input
              id="login-rc"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              placeholder="xxxx-xxxx"
              className="h-10 bg-white font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="text-[11.5px] text-slate-500">Each recovery code works once.</div>
            <Button type="submit" className="mt-2 h-10 w-full" disabled={busy || !code.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Verify
            </Button>
          </form>
        )}
        {busy && !recovery && (
          <div className="flex items-center justify-center gap-2 text-[12px] text-slate-500">
            <Loader2 className="size-3.5 animate-spin" /> Verifying…
          </div>
        )}
        <div className="flex items-center justify-between pt-1 text-[12.5px]">
          <button type="button" onClick={onBack} className="flex items-center gap-1 font-medium text-slate-500 hover:text-slate-800">
            <ArrowLeft className="size-3.5" /> Back
          </button>
          <button
            type="button"
            onClick={() => {
              setRecovery((v) => !v)
              setErr(null)
            }}
            className="font-medium text-sky-700 hover:underline"
          >
            {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ step: required password change
function PasswordStep({ challenge, who, username, onBack, onNext }: { challenge: string; who: string; username: string; onBack: () => void; onNext: (s: LoginStep) => void }) {
  const complete = useAuth((s) => s.completePasswordChange)
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { ok } = policyChecks(pw, username, confirm)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      const s = await complete(challenge, pw)
      if (s.status !== 'ok') onNext(s)
    } catch (x) {
      const f = x as AuthFailure
      if (f.status === 401) {
        onBack()
        return
      }
      setErr(f.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <Heading
        icon={KeyRound}
        title="Choose a new password"
        sub={
          <>
            Welcome, <b className="text-slate-700">{who}</b>. Your password was issued or reset by an administrator; set your own before continuing.
          </>
        }
      />
      <div className="space-y-4">
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="space-y-1.5">
          <Label htmlFor="new-pw">New password</Label>
          <PasswordInput id="new-pw" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus className="h-10 bg-white" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-pw2">Confirm new password</Label>
          <PasswordInput id="new-pw2" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className="h-10 bg-white" />
        </div>
        <PasswordChecklist password={pw} username={username} confirm={confirm} className="rounded-lg border bg-white px-3 py-2.5" />
        <Button type="submit" className="h-10 w-full" disabled={busy || !ok}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Set password and continue
        </Button>
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-[12.5px] font-medium text-slate-500 hover:text-slate-800">
          <ArrowLeft className="size-3.5" /> Back to sign in
        </button>
      </div>
    </form>
  )
}
