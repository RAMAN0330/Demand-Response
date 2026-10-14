// Public landing page — what the platform does, how it works, and why it can be trusted. Enterprise palette, spatial hero.
import type { ReactNode } from 'react'
import {
  Activity,
  ArrowRight,
  Bell,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  Database,
  FileCheck2,
  Gauge,
  Layers,
  Lock,
  MapPin,
  Network,
  Play,
  Power,
  Radio,
  Receipt,
  Scale,
  Send,
  ShieldCheck,
  Sun,
  Target,
  Telescope,
  TriangleAlert,
  Users,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AdrmsMark } from '@/components/brand/AdrmsMark'

const signIn = () => {
  location.hash = '#/login'
}
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

export function LandingPage() {
  return (
    <div className="h-full overflow-y-auto bg-[#f3f5f8] text-slate-800 [scroll-behavior:smooth]" id="landing">
      <TopBar />
      <Hero />
      <Facts />
      <Problem />
      <Loop />
      <Feature
        id="platform"
        eyebrow="Spatial workspace"
        title="The live grid is the workspace"
        text="Every substation, corridor, 220 kV station, generator and flexible participant on one 3D map. Headline DR numbers and the four operator questions float above it — and anything you select, the camera flies to."
        points={[
          'Now · At risk · Next · Intent, on one screen',
          'Select an alarm, line, participant or event — fly there, see what it affects',
          'Situation → Impact → Prediction → Recommendation → Action → Outcome',
        ]}
        img="/landing/fly.webp"
        icon={<MapPin />}
      />
      <Feature
        eyebrow="DR events"
        title="Optimised, checked, approved, dispatched — and accountable"
        text="A network-constrained optimiser picks the cheapest reliable mix in milliseconds. A digital twin checks every action before it leaves. Each event keeps its own record from the first alarm to the last payment."
        points={[
          'Target vs dispatched vs delivered, live',
          'Options compared like-for-like, binding constraints shown',
          'Signed commands, acknowledgements and a full activity log',
        ]}
        img="/landing/events.webp"
        icon={<Zap />}
        flip
      />
      <Feature
        eyebrow="Programmes & participants"
        title="Flexibility, organised the way it is contracted"
        text="Interruptible load, C&I curtailment, load shifting, DER & EV aggregation, battery storage and supply-side flex. Pick a programme and its participants light up on the map with availability, reliability and price."
        points={['Reliability learned from every metered event', 'Heartbeat and telemetry health per participant', 'Take out of service with a reason — audited']}
        img="/landing/programs.webp"
        icon={<Users />}
      />
      <Shedding />
      <Feature
        eyebrow="Replay · Verify · Settle"
        title="Every event can be replayed — and proven"
        text="Scrub any event on the map to see who was dispatched, when they acknowledged and what they delivered. On close, delivery is measured against baseline, payments are performance-adjusted, and the record is sealed in a hash-chained audit trail."
        points={['Baseline-based measurement & verification', 'Performance-factor settlement per participant', 'One-click SHA-256 audit-chain verification']}
        img="/landing/replay.webp"
        icon={<Receipt />}
        flip
      />
      <Autonomy />
      <Trust />
      <Architecture />
      <Video />
      <Cta />
      <Footer />
    </div>
  )
}

/* ------------------------------------------------------------------ chrome */
function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/60 bg-white/75 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-6">
        <a href="#" className="flex items-center gap-2.5" onClick={(e) => (e.preventDefault(), document.getElementById('landing')?.scrollTo({ top: 0, behavior: 'smooth' }))}>
          <AdrmsMark className="size-9 shadow-sm" />
          <span className="leading-tight">
            <span className="block text-[15px] font-extrabold tracking-[0.08em] text-sky-900">ADRMS</span>
            <span className="block text-[11px] text-slate-500">Automated Demand Response Management System</span>
          </span>
        </a>
        <nav className="ml-6 hidden items-center gap-1 text-[14px] text-slate-600 lg:flex">
          {[
            ['platform', 'Platform'],
            ['how', 'How it works'],
            ['shedding', 'Load rotation'],
            ['trust', 'Trust'],
            ['video', 'Overview video'],
          ].map(([id, l]) => (
            <button key={id} onClick={() => scrollTo(id)} className="rounded-lg px-3 py-1.5 transition hover:bg-slate-100 hover:text-slate-900">
              {l}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => scrollTo('video')}>
            <Play className="size-4" /> Watch overview
          </Button>
          <Button onClick={signIn}>
            Sign in <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </header>
  )
}

function Section({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('scroll-mt-20 px-6 py-20 md:py-24', className)}>
      <div className="mx-auto max-w-7xl">{children}</div>
    </section>
  )
}

function Eyebrow({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return <div className={cn('text-[13px] font-semibold tracking-[0.14em] uppercase', dark ? 'text-sky-200' : 'text-sky-700')}>{children}</div>
}

function Frame({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-white/80 bg-white shadow-2xl shadow-slate-900/15 ring-1 ring-slate-900/5', className)}>
      <div className="flex h-7 items-center gap-1.5 border-b border-slate-200/70 bg-slate-50 px-3">
        <span className="size-2.5 rounded-full bg-slate-300" />
        <span className="size-2.5 rounded-full bg-slate-300" />
        <span className="size-2.5 rounded-full bg-slate-300" />
      </div>
      <img src={src} alt={alt} loading="lazy" className="block w-full" />
    </div>
  )
}

/* ------------------------------------------------------------------ hero */
function Hero() {
  return (
    <div className="relative overflow-hidden bg-gradient-to-br from-sky-900 via-sky-800 to-slate-900 text-white">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(50rem 30rem at 15% 0%, rgb(92 140 198 / .45), transparent 60%), radial-gradient(40rem 30rem at 95% 100%, rgb(42 135 97 / .35), transparent 60%), linear-gradient(to right, rgb(255 255 255 / .05) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / .05) 1px, transparent 1px)',
          backgroundSize: 'auto, auto, 56px 56px, 56px 56px',
        }}
      />
      <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-6 pt-20 pb-24 lg:grid-cols-[1fr_1.15fr] lg:pt-24">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[13px] text-sky-100 ring-1 ring-white/20">
            <span className="size-1.5 rounded-full bg-emerald-400" /> Autonomous DR operations · human in the loop
          </span>
          <h1 className="mt-6 text-4xl leading-[1.08] font-bold tracking-tight md:text-6xl">Turn flexible demand into a grid resource — and run it end to end.</h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-sky-100/90">
            Detect the grid's need, forecast it, choose the cheapest reliable mix of flexible loads, batteries and generation, dispatch under operator supervision, then measure
            every participant against baseline and settle — on a live 3D map of your network.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="lg" className="bg-white text-sky-900 hover:bg-sky-50" onClick={signIn}>
              Sign in to the console <ArrowRight className="size-4" />
            </Button>
            <Button size="lg" variant="outline" className="border-white/30 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => scrollTo('video')}>
              <Play className="size-4" /> Watch the overview
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-sky-100/80">
            {['Dual authorisation above 200 MW', 'Kill switch', 'Hash-chained audit'].map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <CheckCircle2 className="size-4 text-emerald-400" /> {t}
              </span>
            ))}
          </div>
        </div>
        <div className="relative [perspective:1600px]">
          <div className="transition duration-700 [transform:rotateY(-9deg)_rotateX(4deg)] hover:[transform:rotateY(-3deg)_rotateX(1deg)]">
            <Frame src="/landing/hero.webp" alt="The Overview workspace: live 3D grid map with DR headline numbers and the At risk, Next and Intent panels" />
          </div>
          <Chip className="-top-4 left-6" icon={<Target />} label="Grid need" value="744 MW ↓ load" tone="text-amber-700" />
          <Chip className="top-1/3 -left-6" icon={<Activity />} label="Delivering (metered)" value="165 MW · 96%" tone="text-emerald-700" />
          <Chip className="-right-4 bottom-10" icon={<Cpu />} label="Network-constrained LP" value="≈ 15 ms" tone="text-sky-700" />
        </div>
      </div>
    </div>
  )
}

function Chip({ icon, label, value, tone, className }: { icon: ReactNode; label: string; value: string; tone: string; className: string }) {
  return (
    <div
      className={cn('absolute hidden rounded-xl border border-white/70 bg-white/85 px-3.5 py-2 text-slate-800 shadow-xl shadow-slate-900/20 backdrop-blur-md md:block', className)}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 [&_svg]:size-3.5">
        {icon} {label}
      </div>
      <div className={cn('font-mono text-[15px] font-semibold', tone)}>{value}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ facts */
function Facts() {
  const f = [
    ['1 Hz', 'control loop: ingest → detect → decide → dispatch'],
    ['≈ 15 ms', 'network-constrained LP solve per plan (HiGHS)'],
    ['90', '220 kV stations live on the map, all DISCOMs'],
    ['25', 'load-rotation roster groups across 5 DISCOMs'],
    ['1,683 MW', 'contracted flexibility, 24 participants'],
  ]
  return (
    <div className="border-b border-slate-200 bg-white px-6">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 py-10 md:grid-cols-5">
        {f.map(([v, l]) => (
          <div key={l}>
            <div className="font-mono text-2xl font-semibold text-sky-800">{v}</div>
            <div className="mt-1 text-[13px] leading-snug text-slate-500">{l}</div>
          </div>
        ))}
      </div>
      <div className="mx-auto max-w-7xl pb-4 text-[11px] text-slate-400">
        Figures from the reference deployment: the Karnataka control area (KPTCL SLDC), with simulated field data.
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ problem */
function Problem() {
  const items = [
    {
      icon: <Scale />,
      t: 'Deviation (DSM) charges',
      d: 'Over- and under-drawal against schedule is charged under DSM regulations — beyond the band, at a premium.',
      c: 'bg-amber-100 text-amber-700',
    },
    { icon: <Sun />, t: 'Renewable swings', d: 'Solar and wind move by hundreds of megawatts in minutes. Something has to absorb it.', c: 'bg-sky-100 text-sky-700' },
    { icon: <Network />, t: 'Local congestion', d: 'There can be enough power overall and still one overloaded corridor. Location matters.', c: 'bg-violet-100 text-violet-700' },
    {
      icon: <TriangleAlert />,
      t: 'Blackouts',
      d: 'Without flexibility, the last resort is cutting feeders. Paid, consenting flexibility should come first.',
      c: 'bg-rose-100 text-rose-700',
    },
  ]
  return (
    <Section>
      <Eyebrow>Why demand response</Eyebrow>
      <h2 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
        Balancing the grid is getting harder — and demand can help, if you can call on it fast, in the right place, and prove it.
      </h2>
      <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {items.map((x) => (
          <div key={x.t} className="rounded-2xl border border-white/80 bg-white/90 p-6 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5">
            <span className={cn('grid size-11 place-items-center rounded-xl [&_svg]:size-5', x.c)}>{x.icon}</span>
            <div className="mt-4 text-lg font-semibold text-slate-900">{x.t}</div>
            <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{x.d}</p>
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ loop */
function Loop() {
  const steps = [
    { i: <Activity />, t: 'Detect', d: 'ACE, frequency and line loading at 1 Hz, with data-quality checks and ISA-18.2 alarms.' },
    { i: <Telescope />, t: 'Forecast', d: 'P10–P50–P90 for the next two hours and predicted violations, ahead of time.' },
    { i: <BrainCircuit />, t: 'Decide', d: 'Network-constrained LP across all resources, re-solved every block; digital-twin gate.' },
    { i: <Send />, t: 'Dispatch', d: 'Signed setpoints, acknowledgements, no blind resend — within the autonomy policy.' },
    { i: <Gauge />, t: 'Verify', d: 'Metered delivery against baseline for every participant, every second.' },
    { i: <Receipt />, t: 'Settle', d: 'Performance-adjusted payments, learned reliability, sealed audit record.' },
  ]
  return (
    <Section id="how" className="bg-white">
      <Eyebrow>How it works</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">One continuous loop, explained at every step</h2>
      <div className="mt-12 grid gap-4 md:grid-cols-3 lg:grid-cols-6">
        {steps.map((s, k) => (
          <div key={s.t} className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
            <div className="flex items-center gap-2">
              <span className="grid size-9 place-items-center rounded-lg bg-sky-600 text-white [&_svg]:size-4.5">{s.i}</span>
              <span className="font-mono text-[12px] text-slate-400">0{k + 1}</span>
            </div>
            <div className="mt-4 font-semibold text-slate-900">{s.t}</div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-slate-600">{s.d}</p>
            {k < steps.length - 1 && <ArrowRight className="absolute top-1/2 -right-3.5 z-10 hidden size-5 -translate-y-1/2 text-slate-300 lg:block" />}
          </div>
        ))}
      </div>
      <div className="mt-8 rounded-2xl border border-sky-100 bg-sky-50/60 p-5 text-[15px] text-slate-700">
        <b className="text-sky-800">Every decision reads as a story:</b> Situation → Impact → Prediction → Recommendation → Action → Outcome — so an operator understands what is
        happening, why, and what the system intends, before approving anything.
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ feature rows */
function Feature({
  id,
  eyebrow,
  title,
  text,
  points,
  img,
  icon,
  flip,
}: {
  id?: string
  eyebrow: string
  title: string
  text: string
  points: string[]
  img: string
  icon: ReactNode
  flip?: boolean
}) {
  return (
    <Section id={id}>
      <div className={cn('grid items-center gap-12 lg:grid-cols-[1fr_1.25fr]', flip && 'lg:grid-cols-[1.25fr_1fr]')}>
        <div className={cn(flip && 'lg:order-2')}>
          <span className="grid size-11 place-items-center rounded-xl bg-sky-100 text-sky-700 [&_svg]:size-5">{icon}</span>
          <div className="mt-5">
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">{title}</h2>
          <p className="mt-4 text-[16px] leading-relaxed text-slate-600">{text}</p>
          <ul className="mt-6 space-y-2.5">
            {points.map((p) => (
              <li key={p} className="flex gap-2.5 text-[15px] text-slate-700">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" /> {p}
              </li>
            ))}
          </ul>
        </div>
        <Frame src={img} alt={title} className={cn(flip && 'lg:order-1')} />
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ shedding */
function Shedding() {
  return (
    <Section id="shedding" className="bg-gradient-to-br from-slate-900 via-sky-950 to-slate-900 text-white">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.25fr]">
        <div>
          <span className="grid size-11 place-items-center rounded-xl bg-rose-500/20 text-rose-300 [&_svg]:size-5">
            <Power />
          </span>
          <div className="mt-5">
            <Eyebrow dark>Emergency load management</Eyebrow>
          </div>
          <h2 className="mt-3 text-3xl font-bold tracking-tight">Load rotation as the last resort — fair, limited, and never automatic</h2>
          <p className="mt-4 text-[16px] leading-relaxed text-sky-100/85">
            Only the over-drawal that paid flexibility cannot cover becomes a load-rotation proposal — when it stays beyond the DSM deviation band or frequency drops below 49.90 Hz
            — and it acts only after shift-in-charge approval.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-3">
            {[
              ['≤ 45 min', 'per spell'],
              ['≤ 120 min', 'per group per day'],
              ['Fair', 'split across DISCOMs by load'],
              ['Staged', 'restoration, no rebound spike'],
            ].map(([v, l]) => (
              <div key={l} className="rounded-xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                <div className="font-mono text-lg font-semibold text-white">{v}</div>
                <div className="text-[13px] text-sky-100/70">{l}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 text-[13px] text-sky-100/70">Never rotated:</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {['Hospitals', 'Water works', 'Railway traction', 'Defence'].map((x) => (
              <span key={x} className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-[13px] text-emerald-200 ring-1 ring-emerald-400/30">
                <ShieldCheck className="size-3.5" /> {x}
              </span>
            ))}
          </div>
        </div>
        <div className="relative">
          <Frame src="/landing/shed.webp" alt="Load Rotation: roster board, 220 kV feeders on the map and the order lifecycle" />
          <Frame
            src="/landing/shedcard.webp"
            alt="A rotated-out 220 kV station with its roster group and protected loads"
            className="absolute -bottom-10 -left-8 hidden w-[46%] md:block"
          />
        </div>
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ autonomy */
function Autonomy() {
  const levels = [
    ['L0', 'Monitor', 'Detect, assess and forecast. No plans.'],
    ['L1', 'Advisory', 'Plans proposed; every action needs approval.'],
    ['L2', 'Supervised', 'Acts inside an envelope; the rest waits for approval.'],
    ['L3', 'Autonomous', 'Acts; humans supervise and can abort.'],
  ]
  const guards = [
    { i: <Power />, t: 'Kill switch', d: 'Suspend autonomy instantly, with a reason — audited.' },
    { i: <Users />, t: 'Dual authorisation', d: 'Two different people for anything above 200 MW.' },
    { i: <Gauge />, t: 'Auto-degrade', d: 'Below 85% data confidence, the system steps back to advisory.' },
    { i: <Layers />, t: 'Digital-twin gate', d: 'Heartbeat, SoC, flows, voltage and reserve checked before dispatch.' },
  ]
  return (
    <Section className="bg-white">
      <Eyebrow>Governance</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">Autonomy is a policy, not a leap of faith</h2>
      <div className="mt-10 grid gap-3 md:grid-cols-4">
        {levels.map(([k, t, d], i) => (
          <div key={k} className={cn('rounded-2xl border p-5', i === 2 ? 'border-sky-300 bg-sky-50 ring-1 ring-sky-200' : 'border-slate-200 bg-slate-50/60')}>
            <div className="font-mono text-sm text-sky-700">{k}</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{t}</div>
            <p className="mt-1 text-[14px] text-slate-600">{d}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {guards.map((g) => (
          <div key={g.t} className="flex gap-3 rounded-2xl border border-slate-200 p-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700 [&_svg]:size-4.5">{g.i}</span>
            <div>
              <div className="font-semibold text-slate-900">{g.t}</div>
              <p className="mt-1 text-[14px] text-slate-600">{g.d}</p>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ trust */
function Trust() {
  const items = [
    {
      i: <Scale />,
      t: 'IEGC & CERC DSM',
      d: 'ACE per IEGC; deviation charges on the CERC DSM 2024 structure (NR = max(A, B, C), band, frequency multipliers). Load your notified table before go-live.',
    },
    { i: <Bell />, t: 'ISA-18.2 alarms', d: 'On/off delays, acknowledgement, shelving with reason, and correlation into incidents.' },
    { i: <Gauge />, t: 'ISA-101 HMI', d: 'Calm, muted base; colour reserved for abnormal states so alarms stand out.' },
    { i: <Lock />, t: 'RBAC & JWT', d: 'Operator, shift-in-charge, analyst, engineer and admin — every permission enforced server-side.' },
    { i: <FileCheck2 />, t: 'Tamper-evident audit', d: 'SHA-256 hash-chained log of every decision, approval, command and override, verifiable in one click.' },
    { i: <Radio />, t: 'Observability', d: 'Health and readiness probes, Prometheus metrics, dead-man watchdog, write-behind persistence.' },
  ]
  return (
    <Section id="trust">
      <Eyebrow>Trust & standards</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">Built for the control room, from the first line</h2>
      <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((x) => (
          <div key={x.t} className="rounded-2xl border border-white/80 bg-white/90 p-6 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5">
            <span className="grid size-10 place-items-center rounded-xl bg-sky-100 text-sky-700 [&_svg]:size-5">{x.i}</span>
            <div className="mt-4 font-semibold text-slate-900">{x.t}</div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-slate-600">{x.d}</p>
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ architecture */
function Architecture() {
  const flow = [
    ['Ingest', 'SCADA/EMS · SLDC web feeds · DR gateways'],
    ['Quality & state', 'Validation · substitution · confidence'],
    ['Detect & forecast', 'Alarms · anomalies · P10–P90'],
    ['Optimise & check', 'HiGHS LP · digital twin'],
    ['Policy & dispatch', 'Autonomy envelope · signed commands'],
    ['M&V & settle', 'Baseline · payments · reliability'],
  ]
  return (
    <Section className="bg-white">
      <Eyebrow>Architecture</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">A production backend, not a dashboard</h2>
      <div className="mt-10 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        {flow.map(([t, d], i) => (
          <div key={t} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="font-mono text-[12px] text-sky-700">0{i + 1}</div>
            <div className="mt-1 font-semibold text-slate-900">{t}</div>
            <div className="mt-1 text-[13px] text-slate-500">{d}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {[
          'FastAPI',
          'Event bus',
          'PostgreSQL / TimescaleDB',
          'WebSocket live stream',
          'React · shadcn/ui',
          'three.js 3D map',
          'Docker Compose',
          'IEC-104 · OpenADR · Modbus (gateway)',
        ].map((t) => (
          <span key={t} className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[13px] text-slate-700">
            <Database className="size-3.5 text-slate-400" /> {t}
          </span>
        ))}
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ video */
function Video() {
  return (
    <Section id="video">
      <div className="text-center">
        <Eyebrow>Product overview</Eyebrow>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">See a DR event from first alarm to settlement</h2>
        <p className="mx-auto mt-3 max-w-2xl text-[16px] text-slate-600">
          A four-minute narrated walkthrough: the spatial workspace, a live DR event, programmes, replay and settlement, and load rotation under human control.
        </p>
      </div>
      <div className="mx-auto mt-10 max-w-5xl overflow-hidden rounded-2xl bg-slate-900 shadow-2xl shadow-slate-900/25 ring-1 ring-slate-900/10">
        <video controls preload="metadata" poster="/media/poster.jpg" className="block aspect-video w-full">
          <source src="/media/demand-response-overview.mp4" type="video/mp4" />
          <source src="/media/demand-response-overview.webm" type="video/webm" />
          <track kind="captions" src="/media/overview.vtt" srcLang="en" label="English" default />
        </video>
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ cta + footer */
function Cta() {
  return (
    <Section className="pt-4">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-sky-800 to-slate-900 px-8 py-14 text-white md:px-14">
        <div className="relative grid items-center gap-8 md:grid-cols-[1.4fr_1fr]">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Put flexibility to work on your grid</h2>
            <p className="mt-3 text-sky-100/85">Sign in to the console, or run the full stack yourself in one command.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button size="lg" className="bg-white text-sky-900 hover:bg-sky-50" onClick={signIn}>
                Sign in to the console <ArrowRight className="size-4" />
              </Button>
              <Button size="lg" variant="outline" className="border-white/30 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => scrollTo('video')}>
                <Play className="size-4" /> Watch the overview
              </Button>
            </div>
          </div>
          <div className="rounded-2xl bg-black/30 p-5 font-mono text-[13px] text-sky-100 ring-1 ring-white/10">
            <div className="text-sky-300/70"># API + console on http://localhost:8080</div>
            <div className="mt-1">docker compose up --build</div>
            <div className="mt-3 text-sky-300/70"># live SLDC feeds (hybrid mode)</div>
            <div className="mt-1">KSFP_SOURCE=hybrid docker compose up</div>
          </div>
        </div>
      </div>
    </Section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white px-6 py-10">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-6 text-[13px] text-slate-500">
        <span className="flex items-center gap-2 font-semibold text-slate-700">
          <AdrmsMark className="size-7" />
          ADRMS — Automated Demand Response Management System
        </span>
        <span>Autonomous DR operations with the operator in control.</span>
        <span className="ml-auto">DSM multipliers are illustrative until the notified table is loaded. Reference deployment uses simulated field data.</span>
      </div>
    </footer>
  )
}
