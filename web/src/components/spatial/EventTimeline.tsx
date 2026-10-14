// Scrubbable DR event timeline docked at the bottom of the workspace: performance curve, milestones, play / live.
import { useEffect, useRef, useState } from 'react'
import { Area, ComposedChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { CheckCircle2, Pause, Play, Radio, Send, UserCheck, X, XCircle, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { fmtMW } from '@/lib/geo'
import { cn } from '@/lib/utils'
import { clockS } from '@/store/useLive'
import { useUI } from '@/store/useUI'
import type { Marker, Playback } from './useEventPlayback'

const MARK: Record<Marker['kind'], { icon: typeof Zap; cls: string }> = {
  open: { icon: Zap, cls: 'bg-sky-500' },
  approval: { icon: UserCheck, cls: 'bg-amber-500' },
  dispatch: { icon: Send, cls: 'bg-sky-600' },
  release: { icon: Send, cls: 'bg-violet-500' },
  failed: { icon: XCircle, cls: 'bg-rose-500' },
  close: { icon: CheckCircle2, cls: 'bg-emerald-500' },
}

export function EventTimeline({ pb, onClose }: { pb: Playback; onClose: () => void }) {
  const playhead = useUI((s) => s.playhead)
  const setPlayhead = useUI((s) => s.setPlayhead)
  const playing = useRef<ReturnType<typeof setInterval> | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const { detail, start, end, at, live, point, markers } = pb
  const span = Math.max(1, end - start)

  const stop = () => {
    if (playing.current) clearInterval(playing.current)
    playing.current = null
    setIsPlaying(false)
  }
  useEffect(() => stop, [])

  function play() {
    if (playing.current) return stop()
    let t = live ? start : at
    setPlayhead(t)
    setIsPlaying(true)
    playing.current = setInterval(() => {
      t += span / 60
      if (t >= end) {
        stop()
        setPlayhead(null)
      } else setPlayhead(t)
    }, 200)
  }

  if (!detail) return null
  const rows = detail.timeline ?? []
  const pct = ((at - start) / span) * 100
  return (
    <div className={cn('surface-panel pointer-events-auto flex items-stretch gap-3 px-3 py-2')}>
      <div className="flex w-[200px] shrink-0 flex-col justify-between">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-semibold text-slate-700">Event {detail.id}</span>
          <span className={cn('rounded px-1.5 text-[9px] font-bold', live ? 'bg-rose-100 text-rose-700' : 'bg-slate-200 text-slate-600')}>{live ? 'LIVE' : 'REPLAY'}</span>
          <button className="ml-auto rounded p-0.5 text-slate-400 hover:bg-slate-900/5" onClick={onClose} aria-label="Close timeline">
            <X className="size-3.5" />
          </button>
        </div>
        <div className="font-mono text-[11px] text-slate-500">{clockS(at)}</div>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 flex-1 bg-white/70" onClick={play}>
            {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} {isPlaying ? 'Pause' : 'Replay'}
          </Button>
          <Button
            size="sm"
            variant={live ? 'default' : 'outline'}
            className={cn('h-7', !live && 'bg-white/70')}
            onClick={() => {
              stop()
              setPlayhead(null)
            }}
          >
            <Radio className="size-3.5" /> Live
          </Button>
        </div>
      </div>

      <div className="relative min-w-0 flex-1">
        <div className="h-[58px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <XAxis dataKey="t" type="number" domain={[start, end]} hide />
              <YAxis hide domain={[0, 'dataMax']} />
              <Area dataKey="delivered" stroke="#2a8761" fill="#abdbc3" fillOpacity={0.7} isAnimationActive={false} />
              <Line dataKey="dispatched" stroke="#6d4fe3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line dataKey="target" stroke="#c07e18" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* playhead + milestones share the chart's x scale (time) */}
        <div className="pointer-events-none absolute inset-y-0 w-px bg-slate-800/70" style={{ left: `${pct}%` }} />
        <div className="relative mt-1 h-4">
          {markers.map((m, i) => {
            const M = MARK[m.kind]
            const Icon = M.icon
            return (
              <button
                key={i}
                title={`${clockS(m.t)} · ${m.label}`}
                onClick={() => {
                  stop()
                  setPlayhead(m.t)
                }}
                className={cn('absolute top-0 grid size-4 -translate-x-1/2 place-items-center rounded-full text-white ring-2 ring-white transition hover:scale-125', M.cls)}
                style={{ left: `${((m.t - start) / span) * 100}%` }}
              >
                <Icon className="size-2.5" />
              </button>
            )
          })}
        </div>
        <Slider
          className="mt-1"
          value={[playhead == null ? end : Math.min(end, Math.max(start, playhead))]}
          min={start}
          max={end}
          step={span / 400}
          onValueChange={([v]) => {
            stop()
            setPlayhead(v >= end - span / 400 ? null : v)
          }}
          aria-label="Event playhead"
        />
      </div>

      <div className="grid w-[230px] shrink-0 grid-cols-2 content-center gap-x-3 gap-y-1 text-[11px]">
        <Metric label="Target" value={fmtMW(point?.target ?? detail.requirement_mw)} color="bg-amber-400" />
        <Metric label="Dispatched" value={fmtMW(point?.dispatched ?? detail.planned_mw)} color="bg-sky-500" />
        <Metric label="Delivered" value={fmtMW(point?.delivered ?? detail.delivered_mw)} color="bg-emerald-500" />
        <Metric label="Participants" value={String(pb.activeCount)} color="bg-slate-400" />
      </div>
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] text-slate-500">
        <span className={cn('size-1.5 rounded-full', color)} /> {label}
      </div>
      <div className="font-mono text-[13px] font-semibold tabular-nums text-slate-800">{value}</div>
    </div>
  )
}
