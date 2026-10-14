// ADRMS mark: a demand curve with its peak shaved — the dashed peak is the load that would have been,
// the solid line is the load after demand response, the arrow is the dispatch that took it off.
import { useId } from 'react'
import { cn } from '@/lib/utils'

export function AdrmsMark({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} role="img" aria-label="ADRMS">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c5ae8" />
          <stop offset="1" stopColor="#2a1a9e" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <path d="M5 24.5h22" stroke="#fff" strokeOpacity=".22" strokeWidth="1" />
      <path d="M5 21.5C9 21.5 10.5 7.5 16 7.5S23 21.5 27 21.5" fill="none" stroke="#d2cafb" strokeOpacity=".7" strokeWidth="1.3" strokeDasharray="1.6 1.8" strokeLinecap="round" />
      <path d="M5 21.5C8.2 21.5 10 15 12.4 15H19.6C22 15 23.8 21.5 27 21.5" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 9.6v3.2M14.4 11.4 16 13l1.6-1.6" fill="none" stroke="#7dd3a8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Mark + wordmark, for the top bar. */
export function AdrmsBrand({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)} title="ADRMS — Automated Demand Response Management System">
      <AdrmsMark className="shadow-sm" />
      <span className="text-[14px] text-gradient font-extrabold tracking-[0.08em] max-[1365px]:hidden">ADRMS</span>
    </span>
  )
}
