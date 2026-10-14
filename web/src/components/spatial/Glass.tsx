// Glass surfaces for the spatial workspace: floating, collapsible panels that keep the map visible underneath.
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export const glass = 'surface-panel'

export function GlassPanel({
  title,
  icon,
  aside,
  children,
  className,
  bodyClass,
  tone,
  defaultOpen = true,
  collapsedHint,
}: {
  title: ReactNode
  icon?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  tone?: 'warn' | 'bad'
  defaultOpen?: boolean
  /** one-line summary shown in the header while collapsed */
  collapsedHint?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section
      className={cn(
        'pointer-events-auto flex min-h-0 flex-col overflow-hidden',
        glass,
        tone === 'warn' && '!border-amber-300 border-2',
        tone === 'bad' && '!border-rose-300 border-2',
        className,
        !open && 'flex-none',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={open}>
          <ChevronDown className={cn('size-3.5 shrink-0 text-slate-400 transition-transform', !open && '-rotate-90')} />
          {icon && <span className="shrink-0 text-slate-500 [&_svg]:size-3.5">{icon}</span>}
          <span className="truncate text-[12.5px] font-semibold text-slate-700">{title}</span>
          {!open && collapsedHint && <span className="ml-1 truncate text-[11px] text-slate-500">· {collapsedHint}</span>}
        </button>
        {open && aside}
      </header>
      {open && <div className={cn('min-h-0 flex-1 border-t border-slate-900/[0.06] px-3 py-2.5', bodyClass)}>{children}</div>}
    </section>
  )
}
