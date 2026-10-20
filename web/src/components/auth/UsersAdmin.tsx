// Administration → Users & roles: create, edit, enable/disable, reset password, unlock, reset two-factor, end sessions.
import { useState } from 'react'
import { KeyRound, Loader2, Lock, LogOut, MoreHorizontal, Pencil, Search, ShieldCheck, ShieldOff, Smartphone, Unlock, UserCheck, UserPlus, UserX } from 'lucide-react'
import { CopyButton } from '@/components/auth/AccountDialog'
import { when } from '@/lib/account'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ROLE_INFO } from '@/lib/roles'
import { useAuth } from '@/store/useAuth'

interface AdminUser {
  username: string
  display: string
  email: string | null
  role: string
  role_label: string
  active: boolean
  locked: boolean
  locked_until: number | null
  failed_attempts: number
  mfa_enabled: boolean
  must_change: boolean
  demo: boolean
  last_login_at: number | null
  created_at: number | null
  sessions: number
}


type Confirm = { title: string; body: string; action: string; danger?: boolean; run: () => Promise<unknown> }

export function UsersAdmin() {
  const can = useAuth((s) => s.can)
  const me = useAuth((s) => s.user)
  const { data, reload } = useApi<AdminUser[]>(can('users') ? '/admin/users' : null, { live: false })
  const [q, setQ] = useState('')
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; user: AdminUser } | null>(null)
  const [secret, setSecret] = useState<{ username: string; password: string; created: boolean } | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  if (!can('users'))
    return (
      <div className="grid h-full grid-cols-[minmax(0,1fr)_300px] gap-4">
        <div className="text-xs text-slate-500">User management requires the Administrator role.</div>
        <Roles />
      </div>
    )

  const rows = (data ?? []).filter((u) => !q || `${u.username} ${u.display} ${u.email ?? ''} ${u.role_label}`.toLowerCase().includes(q.toLowerCase()))
  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      setMsg({ tone: 'ok', text: label })
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message })
    } finally {
      reload()
    }
  }
  const resetPw = (u: AdminUser) =>
    setConfirm({
      title: `Reset password for ${u.display}?`,
      body: 'A one-time password is issued and shown to you once. Their current sessions end, and they must choose a new password at next sign-in.',
      action: 'Reset password',
      run: async () => {
        const r = await api<{ temporary_password: string }>(`/admin/users/${u.username}/reset-password`, { method: 'POST' })
        setSecret({ username: u.username, password: r.temporary_password, created: false })
        reload()
      },
    })

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_300px] gap-4">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" className="h-8 pl-8 text-xs" />
          </div>
          <span className="text-[11.5px] text-slate-500">
            {data?.filter((u) => u.active).length ?? 0} active · {data?.filter((u) => u.mfa_enabled).length ?? 0} with two-factor · {data?.filter((u) => u.locked).length ?? 0}{' '}
            locked
          </span>
          <Button size="sm" className="ml-auto" onClick={() => setForm({ mode: 'create' })}>
            <UserPlus className="size-3.5" /> Add user
          </Button>
        </div>
        {msg && (
          <div className={cn('rounded-md px-3 py-1.5 text-[12px]', msg.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800')} onClick={() => setMsg(null)}>
            {msg.text}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-white">
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => (
                <TableRow key={u.username} className={cn(!u.active && 'opacity-60')}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-sky-100 text-[10.5px] font-bold text-sky-800 uppercase">
                        {u.username.slice(0, 2)}
                      </span>
                      <div className="min-w-0 leading-tight">
                        <div className="truncate text-[12.5px] font-medium">
                          {u.display} {u.username === me?.username && <span className="text-[10.5px] font-normal text-slate-400">(you)</span>}
                        </div>
                        <div className="truncate font-mono text-[10.5px] text-slate-500">
                          {u.username}
                          {u.email ? ` · ${u.email}` : ''}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-[12px]">{u.role_label}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.active ? <Badge variant="success">active</Badge> : <Badge variant="secondary">disabled</Badge>}
                      {u.locked && (
                        <Badge variant="destructive" title={`Locked until ${when(u.locked_until)}`}>
                          <Lock /> locked
                        </Badge>
                      )}
                      {u.mfa_enabled ? (
                        <Badge variant="info">
                          <ShieldCheck /> 2FA
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-slate-500">
                          no 2FA
                        </Badge>
                      )}
                      {u.must_change && <Badge variant="warning">must change password</Badge>}
                      {u.demo && <Badge variant="outline">demo</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-[11.5px] text-slate-600">{when(u.last_login_at)}</TableCell>
                  <TableCell className="text-right text-[12px] tabular-nums">{u.sessions}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="size-7" aria-label={`Actions for ${u.username}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => setForm({ mode: 'edit', user: u })}>
                          <Pencil /> Edit details and role
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => resetPw(u)}>
                          <KeyRound /> Reset password
                        </DropdownMenuItem>
                        {u.locked && (
                          <DropdownMenuItem onClick={() => act(`${u.username} unlocked`, () => api(`/admin/users/${u.username}/unlock`, { method: 'POST' }))}>
                            <Unlock /> Unlock
                          </DropdownMenuItem>
                        )}
                        {u.mfa_enabled && (
                          <DropdownMenuItem
                            onClick={() =>
                              setConfirm({
                                title: `Reset two-factor for ${u.display}?`,
                                body: 'Use this when they have lost their device. Two-factor is turned off and their sessions end; they can set it up again from Account & security.',
                                action: 'Reset two-factor',
                                run: () => act(`Two-factor reset for ${u.username}`, () => api(`/admin/users/${u.username}/reset-mfa`, { method: 'POST' })),
                              })
                            }
                          >
                            <Smartphone /> Reset two-factor
                          </DropdownMenuItem>
                        )}
                        {u.sessions > 0 && (
                          <DropdownMenuItem onClick={() => act(`Sessions ended for ${u.username}`, () => api(`/admin/users/${u.username}/revoke-sessions`, { method: 'POST' }))}>
                            <LogOut /> End all sessions
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        {u.active ? (
                          <DropdownMenuItem
                            disabled={u.username === me?.username}
                            className="text-rose-700"
                            onClick={() =>
                              setConfirm({
                                title: `Disable ${u.display}?`,
                                body: 'They are signed out everywhere and cannot sign in until re-enabled. Their audit history is kept.',
                                action: 'Disable account',
                                danger: true,
                                run: () => act(`${u.username} disabled`, () => api(`/admin/users/${u.username}`, { method: 'PATCH', body: { active: false } })),
                              })
                            }
                          >
                            <UserX /> Disable account
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => act(`${u.username} enabled`, () => api(`/admin/users/${u.username}`, { method: 'PATCH', body: { active: true } }))}>
                            <UserCheck /> Enable account
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {data && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-xs text-slate-500">
                    No users match “{q}”.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <Roles />

      {form && (
        <UserForm
          mode={form}
          onClose={() => setForm(null)}
          onCreated={(username, password) => {
            setForm(null)
            setSecret({ username, password, created: true })
            reload()
          }}
          onSaved={(text) => {
            setForm(null)
            setMsg({ tone: 'ok', text })
            reload()
          }}
        />
      )}
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{secret?.created ? 'User created' : 'Password reset'}</DialogTitle>
            <DialogDescription>
              Give <b>{secret?.username}</b> this one-time password through a trusted channel. It is shown only now; they will choose their own at first sign-in.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border bg-slate-50 px-3 py-2.5">
            <code className="flex-1 font-mono text-[15px] font-semibold tracking-wide">{secret?.password}</code>
            {secret && <CopyButton text={secret.password} />}
          </div>
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog c={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function Roles() {
  return (
    <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
      <div className="text-[12px] font-semibold">Role-based access</div>
      {ROLE_INFO.map((r) => (
        <div key={r.role} className="rounded-lg border px-3 py-1.5">
          <div className="text-xs font-semibold">{r.label}</div>
          <div className="text-[11px] text-slate-500">{r.desc}</div>
        </div>
      ))}
      <div className="mt-1 rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
        <div className="mb-0.5 font-semibold text-slate-700">Sign-in policy</div>
        Passwords: 10+ characters, 3 character types, not common. Five wrong attempts lock an account for 15 minutes. Sessions last 12 hours (7 days if remembered); access tokens
        renew every 15 minutes and end at once on sign-out, disable, role change or reset.
      </div>
    </div>
  )
}

function UserForm({
  mode,
  onClose,
  onCreated,
  onSaved,
}: {
  mode: { mode: 'create' } | { mode: 'edit'; user: AdminUser }
  onClose: () => void
  onCreated: (u: string, pw: string) => void
  onSaved: (msg: string) => void
}) {
  const edit = mode.mode === 'edit' ? mode.user : null
  const [username, setUsername] = useState(edit?.username ?? '')
  const [display, setDisplay] = useState(edit?.display ?? '')
  const [email, setEmail] = useState(edit?.email ?? '')
  const [role, setRole] = useState(edit?.role ?? 'operator')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      if (edit) {
        await api(`/admin/users/${edit.username}`, { method: 'PATCH', body: { display, email, role } })
        onSaved(`${edit.username} updated${role !== edit.role ? ' — their sessions ended so the new role applies at once' : ''}`)
      } else {
        const r = await api<{ username: string; temporary_password: string }>('/admin/users', { method: 'POST', body: { username, display, email: email || null, role } })
        onCreated(r.username, r.temporary_password)
      }
    } catch (x) {
      setErr((x as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>{edit ? `Edit ${edit.display}` : 'Add user'}</DialogTitle>
            <DialogDescription>
              {edit ? 'Changing the role ends their sessions so it takes effect immediately.' : 'A one-time password is generated; they set their own at first sign-in.'}
            </DialogDescription>
          </DialogHeader>
          {err && <div className="rounded-md bg-rose-50 px-3 py-1.5 text-[12px] text-rose-800">{err}</div>}
          <div className="space-y-1.5">
            <Label htmlFor="uf-user">Username</Label>
            <Input
              id="uf-user"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              disabled={!!edit}
              placeholder="e.g. r.sharma"
              autoFocus={!edit}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uf-name">Full name</Label>
            <Input id="uf-name" value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="e.g. Raman Sharma" autoFocus={!!edit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uf-mail">Email (optional)</Label>
            <Input id="uf-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@utility.in" />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_INFO.map((r) => (
                  <SelectItem key={r.role} value={r.role}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="text-[11px] text-slate-500">{ROLE_INFO.find((r) => r.role === role)?.desc}</div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (!edit && username.length < 3)}>
              {busy && <Loader2 className="size-3.5 animate-spin" />} {edit ? 'Save changes' : 'Create user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmDialog({ c, onClose }: { c: Confirm | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Dialog
      open={!!c}
      onOpenChange={(o) => {
        if (!o) {
          setErr(null)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {c?.danger ? <ShieldOff className="size-4.5 text-rose-600" /> : <ShieldCheck className="size-4.5 text-sky-700" />} {c?.title}
          </DialogTitle>
          <DialogDescription>{c?.body}</DialogDescription>
        </DialogHeader>
        {err && <div className="rounded-md bg-rose-50 px-3 py-1.5 text-[12px] text-rose-800">{err}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={c?.danger ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              if (!c) return
              setBusy(true)
              setErr(null)
              try {
                await c.run()
                onClose()
              } catch (x) {
                setErr((x as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />} {c?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
