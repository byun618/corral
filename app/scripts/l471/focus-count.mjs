// LIFE-471 K11ⓓ · G8 — 같은 시나리오에서 corral 이 herdr 로 보낸 `pane.focus`·`tab.focus` 횟수 (before/after 대조).
//
// 시나리오(단계마다 프록시 계수를 앞뒤로 찍는다):
//   P1 같은 탭 split pane 선택 전환(사이드바 행 클릭 ×4) · P2 탭 전환(탭바 클릭 ×4) · P3 워크트리 전환(카드 클릭 ×4)
//   P4 재기동(시작 복원·attach — 앱 종료 → 다시 띄우고 안정까지)
// 판정 합계(totals)는 P0~P4 까지다. 그 뒤 양성 대조(r3 L-4): 프록시 control 소켓에 합성 `tab.focus` 1건 — `control.tab.focus` 가 1 이어야 한다.
// 맨 앞 앱 감시(r3 M-1, 조건 ②): 회차 전·중·후 맨 앞 앱을 분류(corral = 이 회차 Electron · start = 회차 시작 때 앞이던 앱 · other)로만
// 기록한다(이름은 적지 않는다). 회차 중 other 가 보이면 다음 단계 경계에서 중단한다(사용자가 Mac 을 쓰는 신호). 이 도구의 입력은 CDP 뿐이다.
// 사용: node app/scripts/l471/focus-count.mjs --app <app 폴더> --out <raw 폴더> [--work /tmp/l471f] [--port 9471] [--ledger <runs.md> --label <이름>]
// 결과: <out>/focus-count.json. 종료코드 0 = 시나리오를 끝까지 돌았다(횟수 판정은 before/after 대조에서 — 이 도구는 세기만 한다).
/* global document */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  appendRun, backendRpc, guardWork, inputs, isolation, launchCorral, loadSample, makeCounter, makeRepo, parseArgs, pause, quitCorral, rpc,
  startBackend, startProxies, stopPid, until,
} from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = parseArgs(process.argv.slice(2))
const appRoot = path.resolve(String(args.app ?? path.resolve(here, '../..')))
const work = guardWork(args.work ?? '/tmp/l471f')
const out = path.resolve(String(args.out ?? 'l471-focus-out'))
const port = Number(args.port ?? 9471)
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(out, { recursive: true })
const t0 = Date.now()
const log = (...parts) => console.log(`[l471-fc +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)

const iso = isolation({ work, session: 'l471-fc' })
const spawned = []
const counter = makeCounter()
const phases = []
let proxy = null
let app = null
let backend = null
// ── 맨 앞 앱 감시 ──
const winctl = '/tmp/l471-bin/winctl'
if (!fs.existsSync(winctl)) throw new Error(`${winctl} 없음 — unread-isolated.mjs 가 만든다`)
const frontPid = () => JSON.parse(execFileSync(winctl, ['front'], { encoding: 'utf8' })).pid
function electronPid() {
  const ps = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
  const line = ps.split('\n').find((row) => row.includes(`--remote-debugging-port=${port}`) && row.includes('Electron.app/Contents/MacOS/Electron') && !row.includes('Helper'))
  return line === undefined ? null : Number(line.trim().split(/\s+/)[0])
}
const startFront = frontPid()
const corralPids = new Set()
const fronts = { startClass: 'start', samples: [], stop: null }
function sampleFront(label) {
  const live = electronPid()
  if (live !== null) corralPids.add(live)
  const pid = frontPid()
  const cls = corralPids.has(pid) ? 'corral' : pid === startFront ? 'start' : 'other'
  const last = fronts.samples.at(-1)
  if (label !== null || last?.cls !== cls) fronts.samples.push({ t: Date.now() - t0, label, cls })
  if (cls === 'other' && fronts.stop === null && label !== 'after-cleanup') fronts.stop = { t: Date.now() - t0, label }
}
sampleFront('before')
const watcher = setInterval(() => {
  try {
    sampleFront(null)
  } catch {
    // ps·winctl 일시 실패는 다음 표본에서
  }
}, 300)
const assertFront = (label) => {
  sampleFront(label)
  if (fronts.stop !== null) throw new Error(`맨 앞 앱이 이 회차의 것도 시작 앱도 아니다(${fronts.stop.label ?? '표본'} +${fronts.stop.t}ms) — 사용자 활동으로 보고 중단`)
}

const result = { appRoot, build: null, load: { before: loadSample() }, phases, totals: null, spawned, ok: false, error: null }
try {
  const build = path.join(appRoot, 'out/main/index.js')
  result.build = { mainBundleMtime: fs.statSync(build).mtime.toISOString(), mainBundleBytes: fs.statSync(build).size }
  const { root, worktrees } = makeRepo({ reposDir: path.join(work, 'repos'), name: 'fc', linked: ['wt-b'] })
  const wtB = worktrees['wt-b']
  // 에이전트 묶음 알약(2개 이상이면 접힘)을 펼쳐 둔다 — 행을 눌러야 한다.
  fs.writeFileSync(iso.prefsFile, JSON.stringify({ version: 1, expandedAgentGroups: [root, wtB] }) + '\n')
  backend = await startBackend({ iso, logFile: path.join(out, 'backend.log'), spawned })
  proxy = await startProxies({ iso, counter })
  app = await launchCorral({ iso, appRoot, port, socket: iso.proxySocket, spawned })
  let ui = inputs(app.cdp)
  const res = await rpc(iso.control, { cmd: 'add-repo', root })
  if (!res.ok) throw new Error(`add-repo: ${JSON.stringify(res)}`)
  const cardSel = (p) => `[data-worktree="${p}"] [data-worktree-card-surface]`
  await until(() => app.cdp.evaluate((s) => document.querySelectorAll(s).length === 2, '[data-worktree]'), 'two cards', 60_000)
  const state = async () => (await rpc(iso.control, { cmd: 'state' })).state
  const wsOf = async (p) => (await state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === p)?.workspace ?? null
  for (const p of [root, wtB]) {
    await ui.click(cardSel(p))
    await until(async () => (await wsOf(p))?.tabs?.length > 0, `workspace open ${p}`, 60_000)
  }
  // A: 탭 2개(첫 탭은 split 2 pane) · B: 탭 1개. 모든 pane 에 에이전트(idle) — 사이드바 행이 서게.
  const wsA = await wsOf(root)
  await backendRpc(iso, 'tab.create', { workspace_id: wsA.workspaceId })
  await backendRpc(iso, 'pane.split', { target_pane_id: wsA.tabs[0].panes[0].paneId, direction: 'right', focus: false })
  await until(async () => {
    const ws = await wsOf(root)
    return ws.tabs.length === 2 && ws.tabs[0].panes.length === 2
  }, 'A layout', 30_000)
  const allPanes = async () => [...((await wsOf(root)).tabs.flatMap((t) => t.panes)), ...((await wsOf(wtB)).tabs.flatMap((t) => t.panes))]
  for (const pane of await allPanes()) await backendRpc(iso, 'pane.report_agent', { pane_id: pane.paneId, source: 'l471-fc', agent: 'claude', state: 'idle' })
  await until(async () => app.cdp.evaluate((n) => document.querySelectorAll('[data-agent-row-source="live"]').length >= n, (await allPanes()).length), 'agent rows', 30_000)
  const A = await wsOf(root)
  const B = await wsOf(wtB)
  const [p1, p2] = A.tabs[0].panes.map((p) => p.paneId)
  const [t1, t2] = A.tabs.map((t) => t.tabId)
  await pause(2500)

  const phase = async (name, run) => {
    assertFront(`${name} 전`)
    const before = { ...counter.counts }
    const at = Date.now()
    await run()
    await pause(2000)
    const after = { ...counter.counts }
    phases.push({ name, startedAt: at, delta: Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]])) })
    log(name, JSON.stringify(phases.at(-1).delta))
    assertFront(`${name} 뒤`)
  }
  // 기동~안정 동안 나간 횟수(준비 단계) — 판정 단계와 따로 적는다.
  phases.push({ name: 'P0-setup', startedAt: t0, delta: { ...counter.counts } })
  await phase('P1-split-pane-select', async () => {
    for (const pane of [p2, p1, p2, p1]) {
      await ui.click(`[data-agent-row-source="live"][data-pane="${pane}"]`)
      await pause(600)
    }
  })
  await phase('P2-tab-switch', async () => {
    for (const tab of [t2, t1, t2, t1]) {
      await ui.click(`[data-main-tab="${tab}"]`)
      await pause(600)
    }
  })
  await phase('P3-worktree-switch', async () => {
    for (const p of [wtB, root, wtB, root]) {
      await ui.click(cardSel(p))
      await pause(800)
    }
  })
  await phase('P4-restart-restore', async () => {
    await quitCorral({ iso, app })
    app = await launchCorral({ iso, appRoot, port, socket: iso.proxySocket, spawned })
    ui = inputs(app.cdp)
    await pause(3000)
  })
  // 양성 대조: P1(같은 탭 split pane 선택 전환)은 pane.focus 를 반드시 보낸다(`group-session.ts` focusPane) — 0 이면 계수기가 못 보는 것이다.
  if (phases.find((p) => p.name === 'P1-split-pane-select').delta['pane.focus'] === 0) throw new Error('양성 대조 실패: P1 에서 pane.focus 0 — 프록시가 endpoint 트래픽을 못 본다')
  result.ids = { root: 'fc', wtB: 'fc-wt/wt-b', panes: { p1, p2, b: B.tabs[0].panes[0].paneId }, tabs: { t1, t2 } }
  result.totals = { ...counter.counts }
  result.events = counter.events.map((e) => ({ ...e, t: e.at - t0 }))
  // 양성 대조(r3 L-4) — corral 은 tab.focus 를 보내지 않으니 0 은 항등이다. 프록시에 합성 tab.focus 1건을 흘려 1 이 세지는지 본다.
  const beforeControl = { ...counter.counts }
  const reply = await new Promise((resolve, reject) => {
    const socket = net.createConnection(iso.proxySocket)
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8')
      if (text.includes('\n')) {
        socket.end()
        resolve(text.trim())
      }
    })
    socket.on('error', reject)
    socket.write(JSON.stringify({ id: 'l471-fc-control', method: 'tab.focus', params: { tab_id: t1 } }) + '\n')
  })
  await pause(800)
  result.control = { sent: 'tab.focus ×1 (합성, 프록시 control 소켓)', reply: reply.slice(0, 200), delta: Object.fromEntries(Object.keys(counter.counts).map((k) => [k, counter.counts[k] - beforeControl[k]])) }
  log('control', JSON.stringify(result.control.delta))
  if (result.control.delta['tab.focus'] !== 1) throw new Error(`양성 대조 실패: 합성 tab.focus 1건이 ${result.control.delta['tab.focus']} 로 세졌다`)
  assertFront('측정 끝')
  result.ok = true
} catch (error) {
  result.error = String(error?.stack ?? error)
  log('ERROR', result.error)
} finally {
  if (app !== null) await quitCorral({ iso, app }).catch(() => {})
  proxy?.close()
  await stopPid(backend?.pid, 'backend').catch(() => {})
  clearInterval(watcher)
  sampleFront('after-cleanup')
  result.fronts = { ...fronts, corralPidCount: corralPids.size }
  result.load.after = loadSample()
  result.cleanup = spawned.map((s) => {
    let alive = false
    try {
      process.kill(s.pid, 0)
      alive = true
    } catch {
      alive = false
    }
    return { ...s, aliveAfter: alive }
  })
  fs.writeFileSync(path.join(out, 'focus-count.json'), JSON.stringify(result, null, 2) + '\n')
  if (typeof args.ledger === 'string') {
    const rel = (p) => path.relative(path.resolve(here, '../../..'), p)
    appendRun({
      ledger: args.ledger,
      criterion: `K11ⓓ G8 pane.focus·tab.focus 계수 (${args.label ?? 'run'})`,
      command: `node app/scripts/l471/focus-count.mjs --app ${args.app ?? 'app'} --out ${rel(out)} --work ${work}`,
      expected: 0,
      actual: result.ok ? 0 : 1,
      raw: rel(out),
      pass: result.ok,
    })
  }
  log('done ok=', result.ok, JSON.stringify(result.totals))
  process.exit(result.ok ? 0 : 1)
}
