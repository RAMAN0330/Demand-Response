// Reports & Audit — settled outcomes (M&V) and the tamper-evident audit trail.
import { useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { HandCoins, IndianRupee, Link2, ListChecks, MapPin, Receipt, Scale, ShieldCheck, ShieldX, Target, Zap } from 'lucide-react'
import { FitPager, SectionTabs } from '@/components/common'
import type { GfKpis } from '@/components/gridflex/GridFlex'
import { Empty, EmptyGuide, Panel, Stat, StatStrip } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ASSET_BY_ID } from '@/data/topology'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { fmtRs } from '@/lib/geo'
import { fmtEnergy, GLOSSARY, REFERENCES } from '@/lib/standards'
import { chartTooltip } from '@/lib/ui'
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
        <Stat icon={<ListChecks />} label="Settled DR events" value={String(s?.decisions ?? 0)} sub={s?.decisions ? 'closed and settled' : 'none closed yet'} tone="info" />
        <Stat
          icon={<Zap />}
          label="Energy delivered vs baseline"
          value={perf == null ? '—' : fmtEnergy(s!.delivered_mwh)}
          meter={perf ?? undefined}
          sub={perf == null ? 'measured against each baseline' : `${(perf * 100).toFixed(0)}% of ${fmtEnergy(s!.expected_mwh)} expected`}
          tone={perf == null ? undefined : perf < 0.85 ? 'warn' : 'good'}
        />
        <Stat icon={<ShieldCheck />} label="DSM charges avoided" value={fmtRs(s?.avoided_dsm_rs ?? 0)} tone="good" sub="deviation charges not incurred" />
        <Stat icon={<HandCoins />} label="Paid to participants" value={fmtRs(s?.payments_rs ?? 0)} sub="performance-adjusted" />
        <Stat
          icon={<IndianRupee />}
          label="Net programme benefit"
          value={fmtRs(s?.net_benefit_rs ?? 0)}
          sub="avoided charges − payments"
          tone={(s?.net_benefit_rs ?? 0) >= 0 ? 'good' : 'bad'}
        />
        <Stat
          icon={<Scale />}
          label="Cost per delivered MWh"
          value={gk?.flex_cost_rs_per_mwh != null ? `₹${gk.flex_cost_rs_per_mwh.toLocaleString('en-IN')}` : '—'}
          sub={gk ? `${gk.disputes} M&V dispute(s)` : undefined}
          tone={gk?.disputes ? 'warn' : undefined}
        />
        <Stat
          icon={<Target />}
          label="Event success rate"
          value={gk?.event_success_rate != null ? `${(gk.event_success_rate * 100).toFixed(0)}%` : '—'}
          sub="delivered ≥ 90 % of expected"
          tone={gk?.event_success_rate == null ? undefined : gk.event_success_rate >= 0.8 ? 'good' : 'warn'}
        />
        <Stat
          icon={verify && !verify.ok ? <ShieldX /> : <Link2 />}
          label="Audit chain (SHA-256)"
          value={verify ? (verify.ok ? 'Intact' : `Broken at #${verify.broken_at}`) : 'Verify now'}
          sub={verify ? `${verify.checked} entries re-hashed` : 'click to re-hash every entry'}
          tone={verify ? (verify.ok ? 'good' : 'bad') : 'info'}
          onClick={async () => setVerify(await api('/audit/verify'))}
        />
      </StatStrip>
      <Panel className="min-h-0 flex-1" bodyClass="flex flex-col">
        <SectionTabs
          sections={[
            { id: 'outcomes', label: 'Event settlement', content: <Outcomes s={s ?? undefined} /> },
            { id: 'reliability', label: 'Participant reliability', content: <Reliability rel={s?.reliability ?? {}} /> },
            { id: 'audit', label: 'Audit trail', content: <Audit /> },
            { id: 'standards', label: 'Standards & glossary', content: <Standards /> },
          ]}
        />
      </Panel>
    </div>
  )
}

function Outcomes({ s }: { s?: Summary }) {
  const go = useUI((x) => x.go)
  const showEvent = useUI((x) => x.showEvent)
  if (!s?.items.length)
    return (
      <EmptyGuide
        icon={<Receipt />}
        title="No DR events settled yet"
        text="Each event is settled automatically when it closes. The ledger below is how every rupee is derived."
        steps={[
          { k: 'B', title: 'Baseline', text: 'What each participant would have drawn without the event (counterfactual, per 15-min block).' },
          { k: 'M', title: 'Metered', text: 'What the meter recorded during the event, aged from its source timestamp.' },
          { k: 'V', title: 'Verified energy', text: 'V = min(B − M, accepted offer); only energy delivered inside the block is credited.' },
          { k: '₹', title: 'Payment & benefit', text: 'Payment = V × price × performance; benefit = DSM charges avoided − payments.' },
        ]}
      />
    )
  const chart = [...s.items]
    .reverse()
    .slice(-24)
    .map((d) => ({
      id: d.id,
      avoided: (d.settlement.avoided_dsm_rs ?? 0) / 1e5,
      payments: -(d.settlement.payments_rs ?? 0) / 1e5,
      net: (d.settlement.net_benefit_rs ?? 0) / 1e5,
    }))
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(180px,0.8fr)] gap-3">
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
                  <TableCell className="text-right font-mono text-[11px]">{fmtEnergy(d.settlement.delivered_mwh ?? 0)}</TableCell>
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
      <div className="flex min-h-0 flex-col rounded-xl bg-slate-50/70 p-2 ring-1 ring-slate-900/[0.05]">
        <div className="flex items-baseline justify-between px-1">
          <span className="eyebrow">Benefit by event (₹ lakh)</span>
          <span className="text-[10px] text-slate-400">DSM charges avoided above the axis, participant payments below, net as the line</span>
        </div>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chart} stackOffset="sign" margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eaef" vertical={false} />
            <XAxis dataKey="id" tick={{ fontSize: 9, fill: '#96a1ae' }} />
            <YAxis tick={{ fontSize: 10, fill: '#96a1ae' }} width={36} />
            <ReferenceLine y={0} stroke="#c4ccd5" />
            <RTooltip {...chartTooltip} formatter={(v) => `₹${Number(v).toFixed(2)} L`} />
            <Bar dataKey="avoided" name="DSM avoided" stackId="a" fill="#78c19f" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="payments" name="Payments" stackId="a" fill="#b1a3f6" radius={[0, 0, 3, 3]} isAnimationActive={false} />
            <Line dataKey="net" name="Net benefit" stroke="#1f6e4e" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
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

/** Instruments the console follows and the terms it uses, so settlement reports can be read against them. */
function Standards() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
      <div className="min-h-0 overflow-y-auto">
        <div className="eyebrow mb-2">Regulations and standards applied</div>
        <ul className="space-y-1.5">
          {REFERENCES.map((r) => (
            <li key={r.title} className="surface-tile flex gap-2.5 p-2.5">
              <Badge variant="info" className="h-5 w-12 shrink-0">
                {r.body}
              </Badge>
              <div className="min-w-0 leading-tight">
                <div className="text-xs font-medium text-slate-800">{r.title}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">{r.applies}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <div className="eyebrow mb-2">Glossary</div>
        <dl className="divide-y divide-slate-200/70">
          {GLOSSARY.map((g) => (
            <div key={g.term} className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-1.5 text-xs">
              <dt className="font-semibold text-slate-700">{g.term}</dt>
              <dd className="text-slate-600">{g.def}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
