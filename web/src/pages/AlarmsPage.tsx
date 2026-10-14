// Alarms & events — prioritised, correlated into incidents; acknowledge and shelve with reasons.
import { useState } from 'react'
import { Activity, Archive, BellDot, BellRing, Check, CheckCheck, Hourglass, Layers, ShieldCheck, Siren } from 'lucide-react'
import { FitPager } from '@/components/common'
import { Empty, Panel, Prio, Stat, StatStrip } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import type { Alarm } from '@/data/types'
import { useApi } from '@/hooks'
import { ALARM_BENCH, alarmKpi, rateVerdict } from '@/lib/alarmKpi'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { clockS, useLive } from '@/store/useLive'
import { useUI } from '@/store/useUI'

const PRIO_BAR: Record<number, string> = { 1: 'bg-rose-500', 2: 'bg-amber-500', 3: 'bg-sky-500', 4: 'bg-slate-300' }
const fmtAge = (s: number) => (s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${(s / 60).toFixed(0)} min` : `${(s / 3600).toFixed(1)} h`)

interface Incident {
  id: string
  category: string
  title: string
  opened_at: number
  closed_at: number | null
  priority: number
  alarm_ids: string[]
  decision_id: string | null
}

export function AlarmsPage() {
  const [status, setStatus] = useState('active')
  const { data, reload } = useApi<{ items: Alarm[]; total: number; incidents: Incident[] }>(`/alarms?status=${status}&limit=500`, { intervalMs: 4000 })
  const { data: act } = useApi<{ items: Alarm[]; total: number; incidents: Incident[] }>('/alarms?status=active&limit=500', { intervalMs: 4000 })
  const { data: shelf } = useApi<{ items: Alarm[]; total: number }>('/alarms?status=shelved&limit=500', { intervalMs: 8000 })
  const { data: hist } = useApi<{ items: Alarm[]; total: number }>('/alarms?status=all&limit=500', { intervalMs: 10000 })
  const trend = useLive((s) => s.trend)
  const can = useAuth((s) => s.can)
  const f = useLive((s) => s.frame)
  const go = useUI((s) => s.go)
  const [shelve, setShelve] = useState<Alarm | null>(null)
  const [reason, setReason] = useState('')
  const items = data?.items ?? []
  const incidents = data?.incidents ?? []
  // KPI figures always describe the active set, whichever filter tab is shown
  const active = act?.items ?? [] // same set the frame counts: active, or cleared but not yet acknowledged
  const now = f?.ts ?? 0
  const byPrio: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  active.forEach((a) => (byPrio[a.priority] = (byPrio[a.priority] ?? 0) + 1))
  const p1Unacked = active.filter((a) => a.priority === 1 && !a.acked).length
  const oldestAlarm = active.filter((a) => !a.acked).sort((a, b) => a.raised_at - b.raised_at)[0]
  const oldest = oldestAlarm ? Math.max(0, now - oldestAlarm.raised_at) : null
  const shelved = shelf?.items.length ?? 0 // the active list excludes shelved alarms
  const openInc = (act?.incidents ?? incidents).filter((i) => !i.closed_at)

  async function ack(id: string) {
    await api(`/alarms/${id}/ack`, { method: 'POST' })
    reload()
  }
  return (
    <div className="flex h-full flex-col gap-3">
      <StatStrip>
        <Stat
          icon={<BellRing />}
          label="Active alarms"
          value={String(f?.counts.alarms ?? 0)}
          segments={[1, 2, 3, 4].map((k) => ({ v: byPrio[k], cls: PRIO_BAR[k], label: `P${k}: ${byPrio[k]}` }))}
          sub={`P1 ${byPrio[1]} · P2 ${byPrio[2]} · P3 ${byPrio[3]} · P4 ${byPrio[4]}`}
          tone={(f?.counts.alarms ?? 0) ? 'warn' : 'good'}
        />
        <Stat
          icon={<Siren />}
          label="Critical (P1)"
          value={String(f?.counts.p1 ?? 0)}
          delta={p1Unacked ? { text: `${p1Unacked} unacked`, tone: 'bad' } : undefined}
          sub={(f?.counts.p1 ?? 0) ? 'respond immediately' : 'none raised'}
          tone={(f?.counts.p1 ?? 0) ? 'bad' : 'good'}
        />
        <Stat
          icon={<BellDot />}
          label="Unacknowledged"
          value={String(f?.counts.unacked ?? 0)}
          meter={(f?.counts.alarms ?? 0) ? 1 - (f?.counts.unacked ?? 0) / (f?.counts.alarms ?? 1) : 1}
          sub={`${(f?.counts.alarms ?? 0) ? Math.round((1 - (f?.counts.unacked ?? 0) / (f?.counts.alarms ?? 1)) * 100) : 100}% acknowledged`}
          tone={(f?.counts.unacked ?? 0) ? 'warn' : 'good'}
        />
        <Stat
          icon={<Hourglass />}
          label="Oldest unacknowledged"
          value={oldest != null ? fmtAge(oldest) : '—'}
          sub={oldestAlarm ? oldestAlarm.title : 'all acknowledged'}
          tone={oldest == null ? 'good' : oldest > 1800 ? 'bad' : oldest > 600 ? 'warn' : 'info'}
        />
        <Stat
          icon={<Layers />}
          label="Open incidents"
          value={String(openInc.length)}
          delta={openInc.length ? { text: `${openInc.reduce((a, i) => a + i.alarm_ids.length, 0)} alarms` } : undefined}
          sub={openInc.length ? `${openInc.filter((i) => i.decision_id).length} linked to a DR event` : 'nothing correlated'}
          tone={openInc.length ? 'info' : 'good'}
        />
        <Stat
          icon={<Archive />}
          label="Shelved"
          value={String(shelved)}
          sub={shelved ? 'returns automatically when shelf expires' : 'nothing shelved'}
          tone={shelved ? 'info' : undefined}
        />
        <Stat
          icon={<ShieldCheck />}
          label="Data confidence"
          value={`${((f?.confidence ?? 1) * 100).toFixed(0)}%`}
          spark={trend.slice(-120).map((p) => p.confidence * 100)}
          sub={(f?.confidence ?? 1) < 0.85 ? 'autonomy degraded to advisory' : 'state estimate healthy'}
          tone={(f?.confidence ?? 1) < 0.85 ? 'warn' : 'good'}
        />
      </StatStrip>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-3">
        <Panel
          title={
            <Tabs value={status} onValueChange={setStatus}>
              <TabsList className="h-7">
                <TabsTrigger value="active" className="text-xs">
                  Active
                </TabsTrigger>
                <TabsTrigger value="shelved" className="text-xs">
                  Shelved
                </TabsTrigger>
                <TabsTrigger value="all" className="text-xs">
                  History
                </TabsTrigger>
              </TabsList>
            </Tabs>
          }
          aside={
            can('ack_alarm') && (
              <Button size="sm" variant="outline" className="h-7" onClick={() => api('/alarms/ack-all', { method: 'POST' }).then(reload)}>
                <CheckCheck className="size-3.5" /> Acknowledge all
              </Button>
            )
          }
          bodyClass="p-1.5"
        >
          {items.length === 0 ? (
            <Empty>{status === 'active' ? 'No standing alarms. The grid is inside every configured limit.' : 'No alarms in this view.'}</Empty>
          ) : (
            <FitPager
              items={items}
              rowHeight={41}
              reserve={64}
              render={(slice) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>P</TableHead>
                      <TableHead>Alarm</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Raised</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slice.map((a) => (
                      <TableRow key={a.id} className={cn(!a.acked && a.state === 'ACTIVE' && 'bg-amber-50/40')}>
                        <TableCell>
                          <Prio p={a.priority} />
                        </TableCell>
                        <TableCell className="max-w-[340px]">
                          <div className="truncate text-xs font-medium">{a.title}</div>
                          <div className="truncate text-[10px] text-slate-500">{a.detail}</div>
                        </TableCell>
                        <TableCell className="text-[11px] text-slate-500">{a.category}</TableCell>
                        <TableCell className="font-mono text-[11px]">{clockS(a.raised_at)}</TableCell>
                        <TableCell>
                          <Badge variant={a.state === 'ACTIVE' ? 'warning' : 'secondary'}>{a.state}</Badge>
                          {a.acked && <span className="ml-1 text-[10px] text-slate-500">ack {a.acked_by}</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          {!a.acked && can('ack_alarm') && (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => ack(a.id)}>
                              <Check className="size-3" /> Ack
                            </Button>
                          )}
                          {a.state === 'ACTIVE' && can('shelve_alarm') && (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setShelve(a)}>
                              <Archive className="size-3" /> Shelve
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            />
          )}
        </Panel>
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
          <AlarmPerformance alarms={hist?.items ?? []} now={now} />
          <Panel title="Incidents (correlated alarms)" icon={<Layers />} bodyClass="p-1.5">
            {incidents.length === 0 ? (
              <Empty>No incidents.</Empty>
            ) : (
              <FitPager
                items={incidents}
                rowHeight={58}
                reserve={36}
                render={(slice) => (
                  <div className="space-y-1">
                    {slice.map((i) => (
                      <div key={i.id} className={cn('rounded-lg border px-2.5 py-1.5', !i.closed_at && 'border-l-2 border-l-amber-400')}>
                        <div className="flex items-center gap-1.5">
                          <Prio p={i.priority} />
                          <span className="font-mono text-[10px] text-slate-500">{i.id}</span>
                          <Badge variant={i.closed_at ? 'secondary' : 'warning'} className="ml-auto">
                            {i.closed_at ? 'closed' : 'open'}
                          </Badge>
                        </div>
                        <div className="mt-0.5 truncate text-[12px] font-medium">{i.title}</div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-500">
                          {clockS(i.opened_at)} · {i.alarm_ids.length} alarm(s)
                          {i.decision_id && (
                            <button className="text-sky-700 hover:underline" onClick={() => go('decisions', i.decision_id)}>
                              → decision {i.decision_id}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              />
            )}
          </Panel>
        </div>
      </div>
      <Dialog open={!!shelve} onOpenChange={(o) => !o && setShelve(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Shelve alarm for 30 minutes</DialogTitle>
            <DialogDescription>{shelve?.title} — shelved alarms are hidden from the active list but remain in history and the audit trail.</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShelve(null)}>
              Cancel
            </Button>
            <Button
              disabled={reason.trim().length < 3}
              onClick={async () => {
                await api(`/alarms/${shelve!.id}/shelve`, { method: 'POST', body: { minutes: 30, reason } })
                setShelve(null)
                setReason('')
                reload()
              }}
            >
              Shelve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** ISA-18.2 / EEMUA 191 alarm-system health: rate per 10 min against the benchmark, floods, chattering and bad actors. */
function AlarmPerformance({ alarms, now }: { alarms: Alarm[]; now: number }) {
  const k = alarmKpi(alarms, now)
  const v = rateVerdict(k.avgPer10)
  const top = Math.max(ALARM_BENCH.flood, k.peakPer10)
  const tone = { good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-rose-600' }[v.tone]
  return (
    <Panel
      title="Alarm system performance"
      icon={<Activity />}
      aside={<span className="text-[10.5px] text-slate-400">ISA-18.2 · EEMUA 191 · last 2 h</span>}
      bodyClass="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Avg / 10 min" value={k.avgPer10.toFixed(1)} cls={tone} sub={v.label} />
          <Metric
            label="Peak / 10 min"
            value={String(k.peakPer10)}
            cls={k.peakPer10 >= ALARM_BENCH.flood ? 'text-rose-600' : 'text-slate-800'}
            sub={`flood ≥ ${ALARM_BENCH.flood}`}
          />
          <Metric
            label="Chattering"
            value={String(k.chattering.length)}
            cls={k.chattering.length ? 'text-amber-700' : 'text-slate-800'}
            sub={`≥ ${ALARM_BENCH.chatter} in 10 min`}
          />
        </div>
        {/* 10-min alarm-rate histogram with the benchmark lines */}
        <div className="relative h-16">
          <div className="absolute inset-x-0 border-t border-dashed border-amber-400/70" style={{ bottom: `${(ALARM_BENCH.manageable / top) * 100}%` }} />
          <div className="absolute inset-x-0 border-t border-dashed border-rose-400/70" style={{ bottom: `${(ALARM_BENCH.flood / top) * 100}%` }} />
          <div className="relative flex h-full items-end gap-1">
            {k.buckets.map((b, i) => (
              <div
                key={i}
                title={`${clockS(k.bucketStart[i])}: ${b} alarm(s)`}
                className={cn('min-h-px flex-1 rounded-t-sm', b >= ALARM_BENCH.flood ? 'bg-rose-400' : b > ALARM_BENCH.manageable ? 'bg-amber-400' : 'bg-sky-400/80')}
                style={{ height: `${(b / top) * 100}%` }}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-slate-400">
          <span className="num">{k.bucketStart.length ? clockS(k.bucketStart[0]) : ''}</span>
          <span>
            <span className="text-amber-600">┄</span> manageable {ALARM_BENCH.manageable} · <span className="text-rose-600">┄</span> flood {ALARM_BENCH.flood}
          </span>
          <span>now</span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="eyebrow mb-1">Most frequent sources</div>
        {k.badActors.length === 0 ? (
          <div className="text-[11px] text-slate-500">No alarms raised in the window.</div>
        ) : (
          <ol className="space-y-1">
            {k.badActors.map((b) => (
              <li key={b.key} className="flex items-center gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-slate-700" title={b.title}>
                  {b.title}
                </span>
                {k.chattering.includes(b.key) && <span className="rounded bg-amber-100 px-1 text-[9px] font-semibold text-amber-800">chatter</span>}
                <span className="num w-6 text-right text-slate-500">{b.n}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-1.5 text-[10px] text-slate-400">{k.standing} standing (active &gt; 24 h)</div>
      </div>
    </Panel>
  )
}

function Metric({ label, value, sub, cls }: { label: string; value: string; sub: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-slate-50/80 px-2 py-1 ring-1 ring-slate-900/[0.05]">
      <div className="truncate text-[10px] text-slate-500">{label}</div>
      <div className={cn('num text-[15px] leading-tight font-semibold', cls)}>{value}</div>
      <div className="truncate text-[9.5px] text-slate-400">{sub}</div>
    </div>
  )
}
