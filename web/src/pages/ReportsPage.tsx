// Reports & Audit — settled outcomes (M&V) and the tamper-evident audit trail.
import { useState } from 'react'
import { MapPin, ShieldCheck, ShieldX } from 'lucide-react'
import { FitPager, SectionTabs } from '@/components/common'
import type { GfKpis } from '@/components/gridflex/GridFlex'
import { Empty, Panel, Stat, StatStrip } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ASSET_BY_ID } from '@/data/topology'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { fmtRs } from '@/lib/geo'
import { cn } from '@/lib/utils'
import { clockS } from '@/store/useLive'
import { useUI } from '@/store/useUI'

interface Summary {
  decisions: number
  avoided_dsm_rs: number
  payments_rs: number
  net_benefit_rs: number
  delivered_mwh: number
  expected_mwh: number
  forecast_accuracy: { mape_1block_pct: number | null; samples: number } | null
  items: {
    id: string
    state: string
    severity: string
    opened_at: number
    closed_at: number | null
    headline: string | null
    closed_reason?: string | null
    settlement: Record<string, number>
  }[]
  reliability: Record<string, number>
}
interface AuditEntry {
  seq: number
  ts: number
  kind: string
  actor: string
  ref: string | null
  message: string
  hash: string
}

export function ReportsPage() {
  const { data: s } = useApi<Summary>('/reports/summary', { intervalMs: 10000 })
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; broken_at: number | null; reason?: string } | null>(null)
  const perf = s && s.expected_mwh > 0 ? s.delivered_mwh / s.expected_mwh : null
  const { data: gf } = useApi<{ kpis: GfKpis }>('/gridflex/overview', { intervalMs: 15000 })
  const gk = gf?.kpis
  return (
    <div className="flex h-full flex-col gap-3">
      <StatStrip>
        <Stat label="Settled DR events" value={String(s?.decisions ?? 0)} />
        <Stat
          label="Energy delivered vs baseline"
          value={perf == null ? '—' : `${s!.delivered_mwh.toFixed(1)} MWh`}
          sub={perf == null ? undefined : `${(perf * 100).toFixed(0)}% of ${s!.expected_mwh.toFixed(1)} MWh expected`}
          tone={perf != null && perf < 0.85 ? 'warn' : 'good'}
        />
        <Stat label="Penalties avoided" value={fmtRs(s?.avoided_dsm_rs ?? 0)} tone="good" sub="DSM charges not incurred" />
        <Stat label="Paid to participants" value={fmtRs(s?.payments_rs ?? 0)} sub="performance-adjusted" />
        <Stat label="Net programme benefit" value={fmtRs(s?.net_benefit_rs ?? 0)} tone={(s?.net_benefit_rs ?? 0) >= 0 ? 'good' : 'bad'} />
        <Stat
          label="Cost per delivered MWh"
          value={gk?.flex_cost_rs_per_mwh != null ? `₹${gk.flex_cost_rs_per_mwh.toLocaleString('en-IN')}` : '—'}
          sub={gk ? `${gk.disputes} M&V dispute(s)` : undefined}
          tone={gk?.disputes ? 'warn' : undefined}
        />
        <Stat
          label="Event success rate"
          value={gk?.event_success_rate != null ? `${(gk.event_success_rate * 100).toFixed(0)}%` : '—'}
          sub="delivered ≥ 90 % of expected"
          tone={gk?.event_success_rate == null ? undefined : gk.event_success_rate >= 0.8 ? 'good' : 'warn'}
        />
        <button
          onClick={async () => setVerify(await api('/audit/verify'))}
          className={cn(
            'min-w-0 rounded-lg border bg-white px-2.5 py-1.5 text-left shadow-xs transition hover:bg-slate-50',
            verify && (verify.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50'),
          )}
        >
          <div className="truncate text-[10px] text-slate-500">Audit chain (SHA-256)</div>
          <div className={cn('flex items-center gap-1 text-[13px] font-semibold', verify ? (verify.ok ? 'text-emerald-700' : 'text-rose-600') : 'text-sky-700')}>
            {verify ? verify.ok ? <ShieldCheck className="size-4" /> : <ShieldX className="size-4" /> : <ShieldCheck className="size-4" />}
            {verify ? (verify.ok ? 'Intact' : `Broken at #${verify.broken_at}`) : 'Verify now'}
          </div>
          <div className="truncate text-[10px] text-slate-400">{verify ? `${verify.checked} entries checked` : 'click to re-hash every entry'}</div>
        </button>
      </StatStrip>
      <Panel className="flex-1" bodyClass="flex flex-col">
        <SectionTabs
          sections={[
            { id: 'outcomes', label: 'Event settlement', content: <Outcomes s={s ?? undefined} /> },
            { id: 'reliability', label: 'Participant reliability', content: <Reliability rel={s?.reliability ?? {}} /> },
            { id: 'audit', label: 'Audit trail', content: <Audit /> },
          ]}
        />
      </Panel>
    </div>
  )
}

function Outcomes({ s }: { s?: Summary }) {
  const go = useUI((x) => x.go)
  const showEvent = useUI((x) => x.showEvent)
  if (!s?.items.length) return <Empty>No DR events settled yet — results appear here when an event closes.</Empty>
  return (
    <FitPager
      items={s.items}
      rowHeight={37}
      reserve={60}
      render={(slice) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Decision</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Closed</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Avoided DSM</TableHead>
              <TableHead className="text-right">Payments</TableHead>
              <TableHead className="text-right">Net benefit</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {slice.map((d) => (
              <TableRow key={d.id} className="cursor-pointer" onClick={() => go('decisions', d.id)}>
                <TableCell className="font-mono text-[11px]">
                  {d.id} <Badge variant="outline">{d.state}</Badge>
                </TableCell>
                <TableCell className="max-w-[320px] truncate text-xs" title={d.headline ?? ''}>
                  {d.closed_reason || d.headline}
                </TableCell>
                <TableCell className="font-mono text-[11px]">{d.closed_at ? clockS(d.closed_at) : '—'}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{(d.settlement.delivered_mwh ?? 0).toFixed(1)} MWh</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{fmtRs(d.settlement.avoided_dsm_rs ?? 0)}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{fmtRs(d.settlement.payments_rs ?? 0)}</TableCell>
                <TableCell className={`text-right font-mono text-[11px] font-semibold ${(d.settlement.net_benefit_rs ?? 0) >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                  {fmtRs(d.settlement.net_benefit_rs ?? 0)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={(e) => {
                      e.stopPropagation()
                      showEvent(d.id, [], d.opened_at)
                    }}
                  >
                    <MapPin className="size-3" /> Replay
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    />
  )
}

function Reliability({ rel }: { rel: Record<string, number> }) {
  const rows = Object.entries(rel).sort((a, b) => a[1] - b[1])
  if (!rows.length) return <Empty>No delivery measurements yet.</Empty>
  return (
    <div className="grid grid-cols-3 gap-x-6 gap-y-1.5">
      {rows.slice(0, 36).map(([id, v]) => (
        <div key={id} className="flex items-center gap-2 text-xs">
          <span className="w-40 truncate">{ASSET_BY_ID[id]?.short ?? id}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${v >= 0.9 ? 'bg-emerald-400' : v >= 0.75 ? 'bg-amber-400' : 'bg-rose-400'}`} style={{ width: `${v * 100}%` }} />
          </div>
          <span className="w-9 text-right font-mono text-[11px]">{(v * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  )
}

const KINDS = ['ALL', 'EVENT', 'ANALYSIS', 'APPROVAL', 'COMMAND', 'ACK', 'SETTLEMENT', 'ALARM', 'OVERRIDE', 'CONFIG', 'SECURITY', 'SYSTEM']

function Audit() {
  const [kind, setKind] = useState('ALL')
  const [page, setPage] = useState(0)
  const size = 14
  const { data } = useApi<{ items: AuditEntry[]; total: number }>(`/audit?limit=${size}&offset=${page * size}${kind !== 'ALL' ? `&kind=${kind}` : ''}`, { intervalMs: 5000 })
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / size))
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v)
            setPage(0)
          }}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {k === 'ALL' ? 'All entry kinds' : k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[11px] text-slate-500">{data?.total ?? 0} entries</span>
        <div className="ml-auto flex items-center gap-1 text-[11px]">
          <Button size="sm" variant="ghost" className="h-6" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Newer
          </Button>
          <span className="font-mono">
            {page + 1}/{pages}
          </span>
          <Button size="sm" variant="ghost" className="h-6" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            Older
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Hash</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.items ?? []).map((e) => (
              <TableRow key={e.seq}>
                <TableCell className="font-mono text-[10px] text-slate-500">{e.seq}</TableCell>
                <TableCell className="font-mono text-[11px]">{clockS(e.ts)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">
                    {e.kind}
                  </Badge>
                </TableCell>
                <TableCell className="text-[11px]">{e.actor}</TableCell>
                <TableCell className="max-w-[560px] truncate text-xs" title={e.message}>
                  {e.message}
                </TableCell>
                <TableCell className="font-mono text-[10px] text-slate-400">{e.hash.slice(0, 10)}…</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
