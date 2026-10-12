// Password input with show/hide and caps-lock warning, and the live policy checklist (mirrors the server policy).
import { useState } from 'react'
import { Check, Eye, EyeOff, TriangleAlert, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { policyChecks } from '@/lib/account'
import { cn } from '@/lib/utils'

export function PasswordChecklist({ password, username, confirm, className }: { password: string; username?: string; confirm?: string; className?: string }) {
  const { checks, score } = policyChecks(password, username, confirm)
  const tone = ['bg-rose-500', 'bg-rose-500', 'bg-amber-500', 'bg-sky-500', 'bg-emerald-500'][score]
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <div className="grid flex-1 grid-cols-4 gap-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className={cn('h-1 rounded-full transition-colors', password && score >= i ? tone : 'bg-slate-200')} />
          ))}
        </div>
        <span className="w-14 text-right text-[10.5px] font-medium text-slate-500">{password ? ['Weak', 'Weak', 'Fair', 'Good', 'Strong'][score] : ''}</span>
      </div>
      <ul className="grid gap-1">
        {checks.map((c) => (
          <li key={c.label} className={cn('flex items-center gap-1.5 text-[11.5px] transition-colors', c.ok ? 'text-emerald-700' : 'text-slate-500')}>
            {c.ok ? <Check className="size-3.5 shrink-0" /> : <X className="size-3.5 shrink-0 text-slate-400" />}
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PasswordInput({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  const [show, setShow] = useState(false)
  const [caps, setCaps] = useState(false)
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false)
  return (
    <div>
      <div className="relative">
        <Input {...props} type={show ? 'text' : 'password'} onKeyDown={onKey} onKeyUp={onKey} onBlur={() => setCaps(false)} className={cn('pr-10', className)} />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow((v) => !v)}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-slate-400 hover:text-slate-700"
          aria-label={show ? 'Hide password' : 'Show password'}
          title={show ? 'Hide password' : 'Show password'}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {caps && (
        <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-amber-700">
          <TriangleAlert className="size-3.5" /> Caps Lock is on
        </div>
      )}
    </div>
  )
}
