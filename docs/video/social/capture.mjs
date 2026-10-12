// Social overview video — capture. Drives a real event on a running ADRMS (simulated field, sim start 18:10, ×30 clock)
// and screenshots every state at 3840×2160 with the on-screen box of each component the camera will zoom to.
//   node capture.mjs <outdir>
import { chromium } from 'playwright'
import fs from 'node:fs'

const OUT = process.argv[2] || '/tmp/social/shots'
const API = 'http://127.0.0.1:8000/api/v1'
const WEB = 'http://127.0.0.1:5173'
const VW = 1600, VH = 900, DSF = 2.4
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function token(u) {
  const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: u + '123' }) })
  return (await r.json()).token
}
const ADMIN = await token('admin'), SIC = await token('sic')
const call = async (path, body, tok = ADMIN, method = 'POST') => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined })
  return r.json().catch(() => ({}))
}
const get = (path) => call(path, null, ADMIN, 'GET')

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(WEB + '/#/login', { waitUntil: 'networkidle' })
await page.fill('#u', 'admin')
await page.fill('#p', 'admin123')
await page.click('button[type=submit]')
await page.waitForSelector('main')
// notification toasts arrive at any moment during a live event: keep them out of the frame
await page.addStyleTag({ content: 'div.fixed.z-50.w-\\[380px\\]{display:none!important}' })
await sleep(4000)

const dismiss = () => page.evaluate(() => document.querySelectorAll('button[aria-label=Dismiss]').forEach((b) => b.click()))
const nav = async (label) => {
  // in-page click: the software-rendered 3D map keeps the page busy, so Playwright's stability wait can stall
  await page.evaluate((l) => [...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim().startsWith(l))?.click(), label)
  await sleep(3000)
  await dismiss()
}
const more = async (label) => {
  // leave the 3D map first (it keeps the main thread busy), then open the menu until the item shows
  await nav('Alarms')
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => document.querySelector('header nav button[aria-haspopup=menu]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })))
    const ok = await page.locator('[role=menuitem]', { hasText: label }).first().waitFor({ timeout: 3000 }).then(() => true).catch(() => false)
    if (ok) break
    await page.keyboard.press('Escape')
  }
  await page.locator('[role=menuitem]', { hasText: label }).first().click({ force: true, timeout: 5000 })
  await sleep(2500)
  await dismiss()
}
const tab = async (label) => {
  await page.evaluate((l) => {
    const t = [...document.querySelectorAll('main [role=tab]')].find((b) => b.textContent.trim().startsWith(l))
    t?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    t?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    t?.click()
  }, label)
  await sleep(1800)
}

// box of the container (closest `sel`) around the first leaf element whose text starts with `text`
const box = (text, sel, nth = 0) =>
  page.evaluate(
    ([text, sel, nth]) => {
      const els = [...document.querySelectorAll('body *')].filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().startsWith(text))
      })
      const e = els[nth]
      if (!e) return null
      const c = sel ? e.closest(sel) || e : e
      const r = c.getBoundingClientRect()
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    },
    [text, sel, nth],
  )
const sbox = (selector) =>
  page.evaluate((s) => {
    const e = document.querySelector(s)
    if (!e) return null
    const r = e.getBoundingClientRect()
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
  }, selector)

const manifest = { viewport: [VW, VH], dsf: DSF, shots: {} }
async function shot(name, targets) {
  await dismiss()
  await page.mouse.move(VW - 4, VH - 4) // park the pointer: no hover tooltips in the frame
  await sleep(600)
  const t = {}
  for (const [k, fn] of Object.entries(targets)) t[k] = await fn()
  await page.screenshot({ path: `${OUT}/${name}.png` })
  manifest.shots[name] = { img: `${name}.png`, targets: t }
  console.log('shot', name, JSON.stringify(t))
}

// ---------------------------------------------------------------- 1. calm overview
await shot('overview_calm', {
  gridneed: () => box('Grid need', 'button'),
  map: () => sbox('main canvas'),
  topstatus: () => sbox('header > div.ml-auto'),
})

// ---------------------------------------------------------------- 2. a shortfall opens
const surge = await call('/admin/simulator/disturbances', { kind: 'demand_surge', params: { mw: 1300 }, duration_min: 110, ramp_min: 2 })
await sleep(9000)
await page.evaluate(() => 0)
await shot('overview_event', {
  gridneed: () => box('Grid need', 'button'),
  intent: () => box('Intent — what the system will do', 'section'),
  atrisk: () => box('At risk — what is abnormal', 'section'),
  eventchip: () => sbox('header > div.ml-auto > button'),
  approve: () => box('Approve', 'button', 0),
})
await nav('DR Events')
await tab('Options')
await shot('events_options', { panel: () => sbox('main [role=tabpanel][data-state=active]'), header: () => box('AWAITING APPROVAL', 'div.rounded-2xl') })
await tab('Safety')
await shot('events_safety', { panel: () => sbox('main [role=tabpanel][data-state=active]') })

// operator approves (dual authorisation)
const st = await get('/state')
const did = st.active_decision?.id
for (const tk of [SIC, ADMIN]) await call(`/decisions/${did}/approve`, {}, tk)
await sleep(26000)
await tab('Coordination')
await shot('events_coord', {
  panel: () => sbox('main [role=tabpanel][data-state=active]'),
  priority: () => box('Dispatch priority', 'div.rounded-xl'),
  ledger: () => box('Shortage ledger — planned / commanded vs measured', 'div.rounded-xl'),
  lifecycle: () => box('Event lifecycle', 'div.rounded-xl'),
})
await tab('Dispatch')
await shot('events_dispatch', { panel: () => sbox('main [role=tabpanel][data-state=active]') })
await sleep(16000)

// ---------------------------------------------------------------- 3. industrial flexibility
await nav('Programs')
await page.evaluate(() => [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('C&I Curtailment'))?.click())
await sleep(2500)
// open the industry that is delivering the most
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('main tbody tr')]
  const val = (r) => parseFloat((r.children[3]?.textContent || '').replace(/[^0-9.]/g, '')) || 0
  rows.sort((a, b) => val(b) - val(a))[0]?.click()
})
await sleep(5000)
await shot('programs_ci', {
  cards: () => box('C&I Curtailment', 'button'),
  table: () => sbox('main table'),
  detail: () => box('Metered demand vs baseline (MW)', 'div.grid > div'),
  chart: () => box('Metered demand vs baseline (MW)', 'div.rounded-xl'),
  mv: () => box('M&V — latest event', 'div.rounded-xl'),
})

// ---------------------------------------------------------------- 4. load rotation for the residual
const surge2 = await call('/admin/simulator/disturbances', { kind: 'demand_surge', params: { mw: 2200 }, duration_min: 60, ramp_min: 1 })
let order = null
for (let i = 0; i < 30 && !order; i++) {
  await sleep(2000)
  const sh = await get('/shedding')
  order = sh.orders?.find((o) => o.state === 'PROPOSED')
}
await nav('Load Rotation')
await shot('rotation_proposed', { order: () => box('Order LR-', 'section'), kpis: () => sbox('main > div > div.grid') })
if (order) {
  for (const tk of [SIC, ADMIN]) await call(`/shedding/orders/${order.id}/approve`, {}, tk)
}
await sleep(9000)
await shot('rotation_active', {
  roster: () => box('Roster board', 'section'),
  order: () => box('Order LR-', 'section'),
  map: () => box('220 kV feeders — red = rotated out', 'section'),
  kpis: () => sbox('main > div > div.grid'),
})
await nav('Overview')
await sleep(2500)
await shot('overview_rotation', { map: () => sbox('main canvas'), gridneed: () => box('Grid need', 'button') })

// ---------------------------------------------------------------- 5. what-if
await more('What-if')
await tab('Shortage & rotation')
await page.locator('main input[type=number]').first().fill('1500', { force: true })
await page.evaluate(() => [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === '50%')?.click())
await page.evaluate(() => [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('Run scenario'))?.click())
await sleep(6000)
await shot('whatif', { inputs: () => box('Shortage (MW)', 'div.rounded-xl'), cases: () => box('No action', 'div.grid') })

// ---------------------------------------------------------------- 6. resolve and settle
for (const d of [surge, surge2]) if (d?.id) await call(`/admin/simulator/disturbances/${d.id}`, null, ADMIN, 'DELETE')
let settled = null
for (let i = 0; i < 60 && !settled; i++) {
  await sleep(3000)
  const ds = await get('/decisions?limit=20')
  settled = (ds.items || ds).find((x) => x.id === did && x.state === 'COMPLETED')
}
await nav('DR Events')
// the settled event may be on a later page of the event list: page forward until it is there, then open it
for (let i = 0; i < 6; i++) {
  const found = await page.evaluate((id) => {
    const b = [...document.querySelectorAll('main button')].find((x) => x.textContent.includes(id) && x.textContent.includes('COMPLETED'))
    if (b) b.click()
    return !!b
  }, did)
  if (found) break
  await page.evaluate(() => {
    const sec = [...document.querySelectorAll('main section')].find((s) => s.textContent.includes('DR events'))
    const btns = sec ? [...sec.querySelectorAll('button')] : []
    btns[btns.length - 1]?.click()
  })
  await sleep(800)
}
await sleep(2500)
await tab('Settlement')
await shot('events_settlement', { panel: () => sbox('main [role=tabpanel][data-state=active]'), ledger: () => box('Counterfactual ledger', 'div.rounded-xl') })
await more('Settlement')
await shot('reports', { kpis: () => sbox('main > div > div.grid'), audit: () => box('Audit chain (SHA-256)', 'button') })

fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1))
console.log(JSON.stringify({ errors, event: did, order: order?.id, settled: !!settled }))
await browser.close()
