// Sign-in state. Short access token (15 min) + rotating refresh token bound to a server session.
// "Keep me signed in" stores the session in localStorage (survives the browser closing); otherwise sessionStorage.
import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import type { User } from '@/data/types'

export interface AuthUser extends User {
  email?: string | null
  mfa_enabled?: boolean
  must_change?: boolean
  last_login_at?: number | null
  password_changed_at?: number | null
  demo?: boolean
}

export type LoginStep =
  | { status: 'ok' }
  | { status: 'mfa'; challenge: string; user: { username: string; display: string } }
  | { status: 'password_change'; challenge: string; policy: string; user: { username: string; display: string } }

export class AuthFailure extends Error {
  status: number
  lockedUntil?: number
  issues?: string[]
  constructor(status: number, message: string, extra: { lockedUntil?: number; issues?: string[] } = {}) {
    super(message)
    this.status = status
    this.lockedUntil = extra.lockedUntil
    this.issues = extra.issues
  }
}

interface Tokens {
  token: string
  refresh_token: string
  expires_in: number
  user: AuthUser
}

interface AuthState {
  token: string | null
  refreshToken: string | null
  expiresAt: number
  remember: boolean
  user: AuthUser | null
  notice: string | null
  login: (username: string, password: string, remember: boolean) => Promise<LoginStep>
  verifyMfa: (challenge: string, code: string) => Promise<LoginStep>
  completePasswordChange: (challenge: string, password: string) => Promise<LoginStep>
  refresh: () => Promise<boolean>
  logout: (notice?: string) => void
  setUser: (u: Partial<AuthUser>) => void
  can: (perm: string) => boolean
}

const KEY = 'ksfp-auth'
let rememberFlag = false
// read from whichever store holds the session; write to the one chosen at sign-in and clear the other
const storage: StateStorage = {
  getItem: (k) => localStorage.getItem(k) ?? sessionStorage.getItem(k),
  setItem: (k, v) => {
    ;(rememberFlag ? localStorage : sessionStorage).setItem(k, v)
    ;(rememberFlag ? sessionStorage : localStorage).removeItem(k)
  },
  removeItem: (k) => {
    localStorage.removeItem(k)
    sessionStorage.removeItem(k)
  },
}

async function post(path: string, body: unknown, token?: string | null) {
  const res = await fetch(`/api/v1/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  let j: Record<string, unknown> = {}
  try {
    j = await res.json()
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const d = j.detail as string | { message: string; locked_until?: number; issues?: string[] } | undefined
    if (res.status === 429 || res.status >= 500 || !d)
      throw new AuthFailure(
        res.status,
        res.status === 429 ? String(d ?? 'Too many attempts. Wait a few minutes.') : `The server could not complete sign-in (${res.status}). Try again.`,
      )
    if (typeof d === 'string') throw new AuthFailure(res.status, d)
    throw new AuthFailure(res.status, d.message, { lockedUntil: d.locked_until, issues: d.issues })
  }
  return j
}

let inflight: Promise<boolean> | null = null

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => {
      const accept = (j: Record<string, unknown>): LoginStep => {
        if (j.status !== 'ok') return j as unknown as LoginStep
        const t = j as unknown as Tokens
        set({ token: t.token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, user: t.user, notice: null })
        return { status: 'ok' }
      }
      return {
        token: null,
        refreshToken: null,
        expiresAt: 0,
        remember: false,
        user: null,
        notice: null,
        login: async (username, password, remember) => {
          rememberFlag = remember
          set({ remember })
          return accept(await post('/login', { username, password, remember }))
        },
        verifyMfa: async (challenge, code) => accept(await post('/mfa', { challenge, code })),
        completePasswordChange: async (challenge, password) => accept(await post('/password/required', { challenge, new_password: password })),
        refresh: () => {
          // one refresh at a time: concurrent 401s share it (a second use of the same refresh token would end the session)
          if (inflight) return inflight
          const rt = get().refreshToken
          if (!rt) {
            if (get().token) get().logout('Your session has ended. Sign in again.')
            return Promise.resolve(false)
          }
          const run = async () => {
            // another tab sharing a remembered session may have rotated it already: take its tokens instead
            if (rememberFlag) {
              await useAuth.persist.rehydrate()
              const s = get()
              if (s.refreshToken !== rt && s.token && s.expiresAt - Date.now() > 90_000) return true
            }
            const j = await post('/refresh', { refresh_token: get().refreshToken ?? rt })
            accept(j)
            return true
          }
          const locked = rememberFlag && typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('adrms-refresh', run) : run()
          inflight = locked
            .catch((e: AuthFailure) => {
              if (e.status === 401) get().logout(e.message)
              return false
            })
            .finally(() => (inflight = null))
          return inflight
        },
        logout: (notice) => {
          const { token } = get()
          if (token && !notice) void post('/logout', {}, token).catch(() => undefined)
          set({ token: null, refreshToken: null, expiresAt: 0, user: null, notice: notice ?? null })
        },
        setUser: (u) => set((s) => (s.user ? { user: { ...s.user, ...u } } : {})),
        can: (perm) => !!get().user?.permissions.includes(perm),
      }
    },
    {
      name: KEY,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ token: s.token, refreshToken: s.refreshToken, expiresAt: s.expiresAt, remember: s.remember, user: s.user }),
      onRehydrateStorage: () => (s) => {
        rememberFlag = !!s?.remember
      },
    },
  ),
)

// keep tabs that share a remembered session in step
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) void useAuth.persist.rehydrate()
  })

/** Keep the access token fresh while signed in: refresh a minute before it expires. */
export function startTokenKeeper(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const plan = () => {
    clearTimeout(timer)
    const { token, expiresAt } = useAuth.getState()
    if (!token) return
    timer = setTimeout(() => void useAuth.getState().refresh(), Math.max(5_000, expiresAt - Date.now() - 60_000))
  }
  plan()
  const unsub = useAuth.subscribe((s, prev) => {
    if (s.token !== prev.token) plan()
  })
  return () => {
    clearTimeout(timer)
    unsub()
  }
}
