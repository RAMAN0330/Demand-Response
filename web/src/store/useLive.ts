// Live operational state streamed from the backend over WebSocket (state frames ≤1 Hz + events).
import { create } from 'zustand'
import { useAuth } from './useAuth'
import { setTopology } from '@/data/topology'
import type { Alarm, Frame, Topology } from '@/data/types'
import { api } from '@/lib/api'
import { useNotify } from './useNotify'

export interface TrendPoint {
  t: string
  ts: number
  frequency: number
  ace: number
  deviation: number
  demand: number
  drawal: number
  schedule: number
  re: number
  confidence: number
}

export interface LiveEvent {
  id: string
  ts: number
  topic: string
  title: string
  priority?: number
}

type Conn = 'connecting' | 'live' | 'reconnecting' | 'offline'

interface LiveState {
  topologyReady: boolean
  frame: Frame | null
  trend: TrendPoint[]
  events: LiveEvent[]
  conn: Conn
  lastMessage: number
  rev: number // bumps on any decision/alarm/command event → views refetch details
  loadTopology: () => Promise<void>
  connect: () => void
  disconnect: () => void
}

let ws: WebSocket | null = null
let retry = 0
let timer: ReturnType<typeof setTimeout> | null = null
let wanted = false

export const useLive = create<LiveState>((set, get) => ({
  topologyReady: false,
  frame: null,
  trend: [],
  events: [],
  conn: 'offline',
  lastMessage: 0,
  rev: 0,

  loadTopology: async () => {
    const t = await api<Topology>('/topology')
    setTopology(t)
    // seed trend from server history so charts are populated immediately
    try {
      const h = await api<Omit<TrendPoint, 't'>[]>('/history?minutes=120')
      set({ trend: h.slice(-600).map((p) => ({ ...p, t: clock(p.ts) })) })
    } catch {
      /* optional */
    }
    set({ topologyReady: true })
  },

  connect: () => {
    wanted = true
    if (ws) return
    const token = useAuth.getState().token
    if (!token) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    set({ conn: retry ? 'reconnecting' : 'connecting' })
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`)
    ws.onopen = () => {
      retry = 0
      set({ conn: 'live' })
      void useNotify.getState().seed()
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'state') {
        const f = msg as Frame
        const p: TrendPoint = {
          t: f.clock.slice(0, 5),
          ts: f.ts,
          frequency: f.frequency,
          ace: f.ace,
          deviation: f.deviation,
          demand: f.demand,
          drawal: f.drawal,
          schedule: f.schedule,
          re: f.re,
          confidence: f.confidence,
        }
        set((s) => ({ frame: f, trend: [...s.trend.slice(-599), p], lastMessage: Date.now() }))
      } else if (msg.type === 'event') {
        const d = msg.data
        let title = msg.topic
        let priority: number | undefined
        if (msg.topic.startsWith('alarm.')) {
          const a = d as Alarm
          title = `${msg.topic === 'alarm.raised' ? 'Alarm' : 'Cleared'}: ${a.title}`
          priority = a.priority
        } else if (msg.topic.startsWith('decision.')) title = `Decision ${d.id}: ${d.state} — ${d.headline ?? ''}`
        else if (msg.topic.startsWith('command.')) title = `${msg.topic.split('.')[1]}: ${d.asset_name} ${d.setpoint} MW`
        else if (msg.topic.startsWith('shedding.')) title = d.msg
        const nf = useNotify.getState()
        if (msg.topic === 'decision.updated') nf.onDecision(d)
        else if (msg.topic === 'command.failed') nf.onCommandFailed(d)
        else if (msg.topic === 'alarm.raised') nf.onAlarm(d as Alarm)
        else if (msg.topic.startsWith('shedding.')) nf.onShedding(msg.topic.split('.')[1], d)
        set((s) => ({
          events: [{ id: `${Date.now()}-${Math.random()}`, ts: Date.now(), topic: msg.topic, title, priority }, ...s.events].slice(0, 100),
          rev: s.rev + 1,
          lastMessage: Date.now(),
        }))
      }
    }
    ws.onclose = (ev) => {
      ws = null
      if (ev.code === 4401) {
        // access token expired (or the session ended): refresh and reconnect; a failed refresh signs out
        set({ conn: 'reconnecting' })
        void useAuth
          .getState()
          .refresh()
          .then((ok) => (ok && wanted ? get().connect() : set({ conn: 'offline' })))
        return
      }
      if (!wanted) {
        set({ conn: 'offline' })
        return
      }
      retry = Math.min(retry + 1, 6)
      set({ conn: 'reconnecting' })
      timer = setTimeout(() => get().connect(), Math.min(15000, 500 * 2 ** retry))
    }
  },

  disconnect: () => {
    wanted = false
    if (timer) clearTimeout(timer)
    ws?.close()
    ws = null
    set({ conn: 'offline' })
  },
}))

export function clock(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).slice(0, 5)
}

export function clockS(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
}
