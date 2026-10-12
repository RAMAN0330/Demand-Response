// Thin REST client for the KSFP backend. Adds the bearer token, refreshes it once on 401, maps errors to readable messages.
import { useAuth } from '@/store/useAuth'

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

function send(path: string, opts: { method?: string; body?: unknown }, token: string | null) {
  return fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = useAuth.getState().token
  let res = await send(path, opts, token)
  if (res.status === 401 && token) {
    // access token expired or rotated elsewhere: refresh once and retry; a failed refresh signs out
    if (await useAuth.getState().refresh()) res = await send(path, opts, useAuth.getState().token)
  }
  if (!res.ok) {
    let msg = res.statusText
    let detail: unknown
    try {
      const j = await res.json()
      detail = j.detail
      msg = typeof j.detail === 'string' ? j.detail : typeof j.detail?.message === 'string' ? j.detail.message : JSON.stringify(j.detail ?? j)
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg, detail)
  }
  return (await res.json()) as T
}
