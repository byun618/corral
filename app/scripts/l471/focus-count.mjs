// LIFE-471 K11ⓓ · G8 — 같은 시나리오에서 corral 이 herdr 로 보낸 `pane.focus`·`tab.focus` 횟수 (before/after 대조).
//
// 시나리오(단계마다 프록시 계수를 앞뒤로 찍는다):
//   P1 같은 탭 split pane 선택 전환(사이드바 행 클릭 ×4) · P2 탭 전환(탭바 클릭 ×4) · P3 워크트리 전환(카드 클릭 ×4)
//   P4 재기동(시작 복원·attach — 앱 종료 → 다시 띄우고 안정까지)
// 사용: node app/scripts/l471/focus-count.mjs --app <app 폴더> --out <raw 폴더> [--work /tmp/l471f] [--port 9471] [--ledger <runs.md> --label <이름>]
// 결과: <out>/focus-count.json. 종료코드 0 = 시나리오를 끝까지 돌았다(횟수 판정은 before/after 대조에서 — 이 도구는 세기만 한다).
/* global document */
import fs from 'node:fs'
import path from 'node:path'
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
    const before = { ...counter.counts }
    const at = Date.now()
    await run()
    await pause(2000)
    const after = { ...counter.counts }
    phases.push({ name, startedAt: at, delta: Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]])) })
    log(name, JSON.stringify(phases.at(-1).delta))
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
  result.ok = true
} catch (error) {
  result.error = String(error?.stack ?? error)
  log('ERROR', result.error)
} finally {
  if (app !== null) await quitCorral({ iso, app }).catch(() => {})
  proxy?.close()
  await stopPid(backend?.pid, 'backend').catch(() => {})
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
