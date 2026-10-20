// Demand-response domain helpers shared by Overview, DR Events and Programs: programmes, participants, live capacity.
import type { Asset } from '@/data/types'
import { useApi } from '@/hooks'

/** A registered DR participant (resource) with live telemetry, as served by GET /resources. */
export type Participant = Omit<Asset, 'reliability' | 'maxLoadMW'> & {
  reliability: number
  out_of_service: boolean
  live: { mw: number; soc: number | null; heartbeat_age_s: number | null; setpoint: number }
}

/** DR programmes: each participant type is enrolled in one programme with its own dispatch and payment terms. */
export const PROGRAMS: { type: string; name: string; desc: string; terms: string }[] = [
  {
    type: 'interruptible',
    name: 'Interruptible Load',
    desc: 'Cold storage, water pumping and process loads curtailed on short notice.',
    terms: 'Paid per MWh curtailed vs baseline',
  },
  {
    type: 'industrial',
    name: 'C&I Demand Response',
    desc: 'Large commercial & industrial customers reduce load under contract.',
    terms: 'Offers per window · baseline M&V (GridFlex)',
  },
  { type: 'shiftable', name: 'Load Shifting', desc: 'Agricultural feeders and flexible loads moved out of the stress window.', terms: 'Shift incentive; rebound tracked' },
  { type: 'der', name: 'DER & EV Aggregation', desc: 'Rooftop solar, EV depots and smart charging via aggregators.', terms: 'Aggregator settlement per MWh' },
  { type: 'bess', name: 'Battery Storage', desc: 'Grid batteries discharged or charged within state-of-charge limits.', terms: 'Energy + opportunity cost' },
  { type: 'generation', name: 'Supply-side Flex', desc: 'Intra-state hydro/thermal headroom re-dispatched when DR is short.', terms: 'Variable cost of generation' },
]

export const isOnline = (p: Participant) => !p.out_of_service && (p.live.heartbeat_age_s == null || p.live.heartbeat_age_s <= 60)
export const isActive = (p: Participant) => p.live.setpoint > 0.5

export interface Capacity {
  participants: number
  online: number
  active: number
  contracted: number
  /** reliability-weighted headroom still callable right now */
  available: number
  dispatched: number
  delivering: number
  commsLost: number
  outOfService: number
}

export function capacity(list: Participant[]): Capacity {
  const c: Capacity = { participants: list.length, online: 0, active: 0, contracted: 0, available: 0, dispatched: 0, delivering: 0, commsLost: 0, outOfService: 0 }
  for (const p of list) {
    c.contracted += p.contractMW
    if (p.out_of_service) c.outOfService += 1
    else if (!isOnline(p)) c.commsLost += 1
    if (isOnline(p)) {
      c.online += 1
      c.available += Math.max(0, p.contractMW - p.live.setpoint) * p.reliability
    }
    if (isActive(p)) {
      c.active += 1
      c.dispatched += p.live.setpoint
      c.delivering += p.live.mw
    }
  }
  return c
}

/** Live participant registry (refreshes every few seconds and on platform events). */
export function useParticipants(intervalMs = 4000) {
  return useApi<Participant[]>('/resources', { intervalMs })
}

/** GridFlex event lifecycle (backend DecisionEngine.phase_of), in order, with short labels for steppers. */
export const PHASES = ['DETECTED', 'ASSESSED', 'PROPOSED', 'APPROVED', 'ACTIVATING', 'VERIFYING', 'RECOVERY', 'SETTLED']
export const PHASE_SHORT: Record<string, string> = {
  DETECTED: 'Detect',
  ASSESSED: 'Assess',
  PROPOSED: 'Propose',
  APPROVED: 'Approve',
  ACTIVATING: 'Activate',
  VERIFYING: 'Verify',
  RECOVERY: 'Recover',
  SETTLED: 'Settle',
}
