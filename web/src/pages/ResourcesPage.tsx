// Programs — DR programmes and their enrolled participants: capacity, live availability, reliability and service status.
import { useMemo, useState } from 'react'
import { Crosshair, MapPin } from 'lucide-react'
import { FitPager } from '@/components/common'
import { IndustrialProgramme } from '@/components/gridflex/GridFlex'
import { TerritoryMap } from '@/components/three/TerritoryMap'
import { Panel } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ASSET_TYPE_META } from '@/data/topology'
import { api } from '@/lib/api'
import { frameAssets } from '@/lib/spatial'
import { capacity, PROGRAMS, type Capacity, type Participant, useParticipants } from '@/lib/dr'
import { fmtMW } from '@/lib/geo'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { useUI } from '@/store/useUI'

type Resource = Participant

export function ResourcesPage() {
  const { data, reload } = useParticipants(3000)
  const can = useAuth((s) => s.can)
  const select = useUI((s) => s.select)
  const setCamera = useUI((s) => s.setCamera)
  const focus = useUI((s) => s.focus)
  const selection = useUI((s) => s.selection)
  const selected = selection?.kind === 'asset' ? selection.id : null
  const [type, setType] = useState('ALL')
  const [edit, setEdit] = useState<Resource | null>(null)
  const [reason, setReason] = useState('')
  const all = useMemo(() => data ?? [], [data])
  const progs = PROGRAMS.map((p) => {
    const members = all.filter((r) => r.type === p.type)
    const c = capacity(members)
    const rel = members.length ? members.reduce((a, r) => a + r.reliability, 0) / members.length : 0
    const price = members.length ? Math.min(...members.map((r) => r.bidRs)) : 0
    return { ...p, c, rel, price }
  }).filter((p) => p.c.participants > 0)
  const tot = capacity(all)
  const rows = all.filter((r) => type === 'ALL' || r.type === type)
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid shrink-0 gap-2" style={{ gridTemplateColumns: `repeat(${progs.length + 1}, minmax(0, 1fr))` }}>
        <ProgramCard
          active={type === 'ALL'}
          onClick={() => {
            setType('ALL')
            setCamera('STATE')
          }}
          color="#3a6fb0"
          name="All programmes"
          desc={`${tot.participants} participants enrolled`}
          c={tot}
          rel={all.length ? all.reduce((a, r) => a + r.reliability, 0) / all.length : 0}
        />
        {progs.map((p) => (
          <ProgramCard
            key={p.type}
            active={type === p.type}
            onClick={() => {
              setType(p.type)
              focus(null, frameAssets(all.filter((r) => r.type === p.type && r.type !== 'generation').map((r) => r.id)))
            }}
            color={ASSET_TYPE_META[p.type]?.color}
            name={p.name}
            desc={p.terms}
            c={p.c}
            rel={p.rel}
            price={p.price}
          />
        ))}
      </div>
      {type === 'industrial' ? (
        // GridFlex: the industrial programme is run by offers, baselines and M&V rather than standing contracts
        <Panel className="min-h-0 flex-1" bodyClass="flex min-h-0 flex-col">
          <IndustrialProgramme />
        </Panel>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-3">
          <Panel bodyClass="p-1.5">
            <FitPager
              items={rows}
              rowHeight={43}
              reserve={64}
              render={(slice) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Participant</TableHead>
                      <TableHead>Programme</TableHead>
                      <TableHead className="text-right">Contract</TableHead>
                      <TableHead className="text-right">Bid ₹/kWh</TableHead>
                      <TableHead>Reliability</TableHead>
                      <TableHead className="text-right">Setpoint → live</TableHead>
                      <TableHead>Telemetry</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slice.map((r) => {
                      const hb = r.live.heartbeat_age_s
                      return (
                        <TableRow
                          key={r.id}
                          className={cn('cursor-pointer', r.out_of_service && 'opacity-60', selected === r.id && 'bg-sky-50/80')}
                          onClick={() => select({ kind: 'asset', id: r.id })}
                        >
                          <TableCell className="max-w-[230px]">
                            <div className="flex items-center gap-1 truncate text-xs font-medium">
                              {selected === r.id && <MapPin className="size-3 shrink-0 text-sky-600" />}
                              {r.name}
                            </div>
                            <div className="truncate text-[10px] text-slate-500">
                              {r.discom} · {r.bus} · {r.protocol} · {r.responseMin} min
                            </div>
                          </TableCell>
                          <TableCell className="text-[11px]" style={{ color: ASSET_TYPE_META[r.type]?.color }}>
                            {PROGRAMS.find((p) => p.type === r.type)?.name ?? r.type}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[11px]">{r.contractMW} MW</TableCell>
                          <TableCell className="text-right font-mono text-[11px]">{r.bidRs.toLocaleString('en-IN')}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <div className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className={cn('h-full rounded-full', r.reliability >= 0.9 ? 'bg-emerald-400' : r.reliability >= 0.75 ? 'bg-amber-400' : 'bg-rose-400')}
                                  style={{ width: `${r.reliability * 100}%` }}
                                />
                              </div>
                              <span className="font-mono text-[10px]">{(r.reliability * 100).toFixed(0)}%</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-[11px]">
                            {r.live.setpoint > 0.5 ? `${r.live.setpoint.toFixed(0)} → ${r.live.mw.toFixed(0)}` : '—'}
                            {r.live.soc != null && <div className="text-[10px] text-slate-500">SoC {(r.live.soc * 100).toFixed(0)}%</div>}
                          </TableCell>
                          <TableCell>
                            {hb == null ? (
                              <span className="text-[10px] text-slate-400">n/a</span>
                            ) : hb > 60 ? (
                              <Badge variant="destructive">lost {hb.toFixed(0)}s</Badge>
                            ) : (
                              <Badge variant="success">OK</Badge>
                            )}
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            {can('resources') ? (
                              <Button size="sm" variant={r.out_of_service ? 'outline' : 'ghost'} className="h-6 px-2 text-[11px]" onClick={() => setEdit(r)}>
                                {r.out_of_service ? 'Return to service' : 'Take out'}
                              </Button>
                            ) : (
                              <Badge variant={r.out_of_service ? 'destructive' : 'secondary'}>{r.out_of_service ? 'out of service' : 'available'}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            />
          </Panel>
          <Panel
            title={type === 'ALL' ? 'Where participants are' : `${PROGRAMS.find((p) => p.type === type)?.name} — ${rows.length} participants`}
            aside={<span className="text-[11px] text-slate-500">click a row to fly to it</span>}
            bodyClass="p-0"
          >
            <TerritoryMap
              compact
              className="rounded-t-none border-0"
              overlay={{ lit: type === 'ALL' ? [] : rows.map((r) => r.id) }}
              chrome={{
                hideLegend: true,
                cardActions: () => (
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setCamera('STATE')}>
                    <Crosshair className="size-3.5" /> Reset view
                  </Button>
                ),
              }}
            />
          </Panel>
        </div>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {edit?.out_of_service ? 'Return to service' : 'Take out of service'}: {edit?.short}
            </DialogTitle>
            <DialogDescription>
              {edit?.out_of_service
                ? 'The optimiser will consider this resource again from the next block.'
                : 'The optimiser will stop dispatching this resource; any active setpoint is released at the next revision.'}{' '}
              The change is recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button
              disabled={reason.trim().length < 3}
              onClick={async () => {
                await api(`/resources/${edit!.id}`, { method: 'PATCH', body: { out_of_service: !edit!.out_of_service, reason } })
                setEdit(null)
                setReason('')
                reload()
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ProgramCard({
  name,
  desc,
  color,
  c,
  rel,
  price,
  active,
  onClick,
}: {
  name: string
  desc: string
  color?: string
  c: Capacity
  rel: number
  price?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-xl border bg-white px-3 py-2 text-left shadow-xs transition hover:shadow-sm',
        active && 'border-sky-300 bg-sky-50/60 ring-1 ring-sky-200',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-[12px] font-semibold text-slate-700">{name}</span>
        {c.active > 0 && (
          <Badge variant="info" className="ml-auto h-4 px-1.5 text-[9px]">
            {c.active} active
          </Badge>
        )}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-base font-semibold tabular-nums">{fmtMW(c.available)}</span>
        <span className="truncate text-[10px] text-slate-500">available of {fmtMW(c.contracted)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full" style={{ width: `${c.contracted ? Math.min(100, (c.available / c.contracted) * 100) : 0}%`, background: color }} />
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-500">
        <span>
          <b className="font-mono text-slate-700">{c.online}</b>/{c.participants} online
        </span>
        <span>
          <b className="font-mono text-slate-700">{(rel * 100).toFixed(0)}%</b> reliable
        </span>
        <span className="truncate">
          {price ? (
            <>
              <b className="font-mono text-slate-700">₹{price.toFixed(1)}</b>/kWh
            </>
          ) : (
            <b className="font-mono text-slate-700">{fmtMW(c.dispatched)}</b>
          )}
          {!price && ' called'}
        </span>
      </div>
      <div className="truncate text-[10px] text-slate-400">{desc}</div>
    </button>
  )
}
