// Page template shared by every screen: Header → Primary → Visualisation → Exceptions → Actions → Details.
import type { CSSProperties, ReactNode } from 'react'
import { AlertTriangle, ArrowRight, Bot, CircleCheck, Eye, Lightbulb, Rocket, Telescope, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export function PageHeader({ title, summary, actions, icon }: { title: string; summary?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      {icon && <div className="grid size-8 place-items-center rounded-lg bg-sky-50 text-sky-600 ring-1 ring-sky-100">{icon}</div>}
      <div className="min-w-0 flex-1 leading-tight">
        <h1 className="text-[15px] font-semibold text-slate-800">{title}</h1>
        {summary && <div className="truncate text-xs text-slate-500">{summary}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Panel({
  title,
  icon,
  aside,
  children,
  className,
  bodyClass,
  style,
}: {
  title?: ReactNode
  /** small leading glyph, so panel headers read the same way as KPI tiles */
  icon?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  style?: CSSProperties
}) {
  return (
    <section style={style} className={cn('surface-panel flex min-h-0 flex-col', className)}>
      {(title || aside) && (
        <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-slate-900/[0.06] px-3 py-1.5">
          <h2 className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-slate-700">
            {icon && <span className="shrink-0 text-slate-400 [&_svg]:size-3.5">{icon}</span>}
            <span className="truncate">{title}</span>
          </h2>
          {aside && <div className="flex shrink-0 items-center gap-1.5">{aside}</div>}
        </div>
      )}
      <div className={cn('min-h-0 flex-1 p-3', bodyClass)}>{children}</div>
    </section>
  )
}

type Tone = 'good' | 'warn' | 'bad' | 'info'
const TONE_TEXT: Record<Tone, string> = { good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-rose-600', info: 'text-sky-700' }
const TONE_TILE: Record<Tone | 'none', string> = {
  good: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
  warn: 'bg-amber-50 text-amber-600 ring-amber-100',
  bad: 'bg-rose-50 text-rose-600 ring-rose-100',
  info: 'bg-sky-50 text-sky-600 ring-sky-100',
  none: 'bg-slate-50 text-slate-500 ring-slate-100',
}
const TONE_BAR: Record<Tone | 'none', string> = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-rose-500', info: 'bg-sky-500', none: 'bg-sky-500' }
const TONE_STROKE: Record<Tone | 'none', string> = { good: '#2a8761', warn: '#c07e18', bad: '#b83b3a', info: '#5735cf', none: '#8d76ee' }

/** Tiny trend line (no axes) — last N samples of the metric. */
export function Sparkline({ data, tone = 'none', className }: { data: number[]; tone?: Tone | 'none'; className?: string }) {
  if (data.length < 2) return null
  const lo = Math.min(...data)
  const hi = Math.max(...data)
  const span = hi - lo || 1
  const pts = data.map((v, i) => [(i / (data.length - 1)) * 100, 22 - ((v - lo) / span) * 20])
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const c = TONE_STROKE[tone]
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className={cn('h-6 w-16 shrink-0 overflow-visible', className)}>
      <polygon points={`0,24 ${line} 100,24`} fill={c} opacity={0.1} />
      <polyline points={line} fill="none" stroke={c} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2} fill={c} />
    </svg>
  )
}

/**
 * One KPI tile. Every page's KPI strip is built from these so the layout reads the same everywhere:
 * icon + label (+ delta chip), value (+ sparkline), then a meter or segmented bar, then the context line.
 */
export function Stat({
  label,
  value,
  tone,
  sub,
  icon,
  delta,
  spark,
  meter,
  segments,
  onClick,
}: {
  label: string
  value: string
  tone?: Tone
  sub?: ReactNode
  icon?: ReactNode
  delta?: { text: string; tone?: Tone }
  spark?: number[]
  /** 0–1 fill, coloured by tone */
  meter?: number
  /** stacked bar, e.g. alarm mix by priority */
  segments?: { v: number; cls: string; label?: string }[]
  onClick?: () => void
}) {
  const k = tone ?? 'none'
  const segTotal = segments?.reduce((a, x) => a + x.v, 0) ?? 0
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'surface-tile relative flex min-w-0 flex-col gap-1 overflow-hidden py-2 pr-2.5 pl-3 text-left',
        onClick && 'transition hover:-translate-y-px hover:shadow-[var(--shadow-float)]',
      )}
    >
      {/* status accent */}
      <span className={cn('absolute inset-y-2 left-0 w-[3px] rounded-r-full', tone ? TONE_BAR[tone] : 'bg-slate-200')} />
      <div className="flex min-w-0 items-center gap-1.5">
        {icon && <span className={cn('grid size-5 shrink-0 place-items-center rounded-md ring-1 [&_svg]:size-3', TONE_TILE[k])}>{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-500">{label}</span>
        {delta && (
          <span
            className={cn(
              'shrink-0 rounded-full bg-slate-50 px-1.5 font-mono text-[10px] font-semibold tabular-nums ring-1 ring-slate-200',
              delta.tone ? TONE_TEXT[delta.tone] : 'text-slate-600',
            )}
          >
            {delta.text}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-end gap-2">
        <span className={cn('min-w-0 flex-1 truncate font-mono text-[17px] leading-tight font-semibold tabular-nums', tone ? TONE_TEXT[tone] : 'text-slate-800')}>{value}</span>
        {spark && <Sparkline data={spark} tone={k} />}
      </div>
      {meter != null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div className={cn('h-full rounded-full transition-all', TONE_BAR[k])} style={{ width: `${Math.max(0, Math.min(100, meter * 100))}%` }} />
        </div>
      )}
      {segments && (
        <div className="flex h-1 w-full gap-px overflow-hidden rounded-full bg-slate-100">
          {segTotal > 0 &&
            segments.filter((x) => x.v > 0).map((x, i) => <div key={i} title={x.label} className={cn('h-full', x.cls)} style={{ width: `${(x.v / segTotal) * 100}%` }} />)}
        </div>
      )}
      {sub && <div className="mt-auto truncate text-[10.5px] text-slate-400">{sub}</div>}
    </Comp>
  )
}

/** Headline KPI card: icon, value, context line and an optional fill bar (e.g. delivered / dispatched). */
export function KpiCard({
  icon,
  label,
  value,
  sub,
  tone,
  fill,
  onClick,
  children,
  className,
}: {
  className?: string
  icon: ReactNode
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'good' | 'warn' | 'bad' | 'info'
  fill?: number
  onClick?: () => void
  children?: ReactNode
}) {
  const ring = tone === 'bad' ? 'border-rose-200 !bg-rose-50/80' : tone === 'warn' ? 'border-amber-200 !bg-amber-50/80' : ''
  const text = tone === 'bad' ? 'text-rose-600' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : tone === 'info' ? 'text-sky-700' : 'text-slate-800'
  const bar = tone === 'bad' ? 'bg-rose-400' : tone === 'warn' ? 'bg-amber-400' : tone === 'good' ? 'bg-emerald-400' : 'bg-sky-400'
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'surface-tile flex min-w-0 flex-col gap-1 px-3 py-2 text-left transition enabled:hover:-translate-y-px enabled:hover:shadow-[var(--shadow-float)]',
        ring,
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <span className="text-slate-400 [&_svg]:size-3.5">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className={cn('truncate font-mono text-lg leading-tight font-semibold tabular-nums', text)}>{value}</div>
      {fill != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className={cn('h-full rounded-full transition-all', bar)} style={{ width: `${Math.max(0, Math.min(100, fill * 100))}%` }} />
        </div>
      )}
      {sub && <div className="truncate text-[11px] text-slate-500">{sub}</div>}
      {children}
    </button>
  )
}

/** KPI strip directly under the page header: the page's primary numbers at a glance. */
export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="grid shrink-0 auto-cols-fr grid-flow-col gap-2">{children}</div>
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-4 text-center text-xs text-slate-500">
      <div className="flex flex-col items-center gap-2">
        {icon ?? <CircleCheck className="size-6 text-emerald-400" />}
        {children}
      </div>
    </div>
  )
}

/** Empty state that teaches: what will appear here and how it is derived, laid out as numbered steps. */
export function EmptyGuide({
  icon,
  title,
  text,
  steps,
  action,
}: {
  icon: ReactNode
  title: string
  text: string
  steps?: { k: string; title: string; text: string }[]
  action?: ReactNode
}) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex w-full max-w-3xl flex-col items-center gap-4 text-center">
        <div className="grid size-11 place-items-center rounded-2xl bg-sky-50 text-sky-600 ring-1 ring-sky-100 [&_svg]:size-5">{icon}</div>
        <div>
          <div className="text-[14px] font-semibold text-slate-800">{title}</div>
          <div className="mt-0.5 text-[12px] text-slate-500">{text}</div>
        </div>
        {steps && (
          <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            {steps.map((s) => (
              <div key={s.k} className="surface-tile p-3 text-left">
                <div className="flex items-center gap-2">
                  <span className="num grid size-6 place-items-center rounded-lg bg-slate-900/[0.04] text-[11px] font-bold text-slate-600">{s.k}</span>
                  <span className="text-[12px] font-semibold text-slate-700">{s.title}</span>
                </div>
                <div className="mt-1.5 text-[11px] leading-snug text-slate-500">{s.text}</div>
              </div>
            ))}
          </div>
        )}
        {action}
      </div>
    </div>
  )
}

export const PRIORITY_STYLE: Record<number, string> = {
  1: 'bg-rose-500 text-white',
  2: 'bg-amber-500 text-white',
  3: 'bg-sky-100 text-sky-800',
  4: 'bg-slate-100 text-slate-600',
}

export function Prio({ p }: { p: number }) {
  return <span className={cn('inline-grid h-5 min-w-7 place-items-center rounded px-1 text-[10px] font-bold', PRIORITY_STYLE[p])}>P{p}</span>
}

const STEPS = [
  { k: 'situation', label: 'Situation', icon: Eye },
  { k: 'impact', label: 'Impact', icon: TriangleAlert },
  { k: 'prediction', label: 'Prediction', icon: Telescope },
  { k: 'recommendation', label: 'Recommendation', icon: Lightbulb },
  { k: 'action', label: 'Action', icon: Rocket },
  { k: 'outcome', label: 'Outcome', icon: Bot },
] as const

/** Situation → Impact → Prediction → Recommendation → Action → Outcome */
export function StoryChain({ narrative, compact }: { narrative: Record<string, unknown>; compact?: boolean }) {
  return (
    <ol className={cn('relative min-w-0', compact ? 'space-y-1.5' : 'space-y-2')}>
      {STEPS.map(({ k, label, icon: Icon }, i) => {
        const text = narrative[k] as string | undefined
        if (!text) return null
        return (
          <li key={k} className="relative flex min-w-0 gap-2.5">
            {i < STEPS.length - 1 && <span className="absolute top-6 left-[11px] h-[calc(100%-0.75rem)] w-px bg-slate-200" />}
            <span
              className={cn(
                'relative grid size-6 shrink-0 place-items-center rounded-full ring-4 ring-white',
                k === 'outcome' ? 'bg-emerald-100 text-emerald-700' : k === 'action' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-600',
              )}
            >
              <Icon className="size-3.5" />
            </span>
            {compact ? (
              <div className="flex min-w-0 flex-1 items-baseline gap-2 pt-0.5" title={text}>
                <span className="w-[112px] shrink-0 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{label}</span>
                <span className="line-clamp-2 min-w-0 flex-1 text-[12px] leading-snug text-slate-700">{text}</span>
              </div>
            ) : (
              <div className="min-w-0 pb-0.5">
                <div className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{label}</div>
                <div className="text-[13px] leading-snug text-slate-700">{text}</div>
              </div>
            )}
          </li>
        )
      })}
      {Array.isArray(narrative.reasons) && (narrative.reasons as string[]).length > 0 && !compact && (
        <li className="mt-1 flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{(narrative.reasons as string[]).join(' · ')}</span>
        </li>
      )}
    </ol>
  )
}

export function GoLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="flex items-center gap-0.5 text-[11px] font-medium text-sky-700 hover:underline">
      {children} <ArrowRight className="size-3" />
    </button>
  )
}
