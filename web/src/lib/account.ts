// Account helpers shared by the sign-in page, Account & security and user administration.

const COMMON = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'welcome',
  'welcome1',
  'welcome123',
  'qwerty',
  'qwerty123',
  'letmein',
  'admin',
  'admin123',
  'administrator',
  'changeme',
  'iloveyou',
  '12345678',
  '123456789',
  '1234567890',
  'abc123',
  'monkey',
  'dragon',
  'sunshine',
  'football',
  'baseball',
  'superman',
  'trustno1',
  'master',
  'secret',
  'login',
  'india123',
])

export function policyChecks(pw: string, username = '', confirm?: string) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  const lower = pw.toLowerCase()
  const checks = [
    { ok: pw.length >= 10, label: 'At least 10 characters' },
    { ok: classes >= 3, label: '3 of: lowercase, uppercase, digits, symbols' },
    { ok: !!pw && !(username && lower.includes(username.toLowerCase())), label: 'Does not contain your username' },
    { ok: !!pw && !COMMON.has(lower) && !COMMON.has(lower.replace(/[!0-9]+$/, '')), label: 'Not a common password' },
  ]
  if (confirm !== undefined) checks.push({ ok: !!pw && pw === confirm, label: 'Both entries match' })
  const score = Math.min(4, (pw.length >= 10 ? 1 : 0) + (pw.length >= 14 ? 1 : 0) + Math.max(0, classes - 1))
  return { checks, ok: checks.every((c) => c.ok), score }
}

export const when = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

export function device(ua: string) {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Browser' : 'Unknown client'
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${b} on ${os}` : b
}
