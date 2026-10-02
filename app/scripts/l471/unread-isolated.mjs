// LIFE-471 격리 실행 — 안 읽음 매트릭스 K1~K8 + 재시작(K8ⓐⓔ · K9 시간축).
//
// 격리: --work(/tmp/l471*) 아래 userData·ui-prefs·레지스트리·herdr 격리 세션·제어 소켓·fixture. 사용자 userData·herdr 기본 세션 무접촉.
// 입력: 화면 클릭·우클릭은 **CDP Input**(이 인스턴스 페이지에만 간다). 창 상태는 control `window-visibility`(hide·minimize·restore·show).
// 「다른 앱이 앞」 은 **실제 앱 활성화**다(K1ⓒ) — 사용자 앱이 아니라 이 회차가 띄우는 무해한 미끼 창(`decoy.swift`, 글자 칸 없음)을
// NSRunningApplication 으로 앞에 세우고, 돌아올 때 격리 corral 을 pid 로 활성화한다. **활성화 직전마다 맨 앞 앱이 이 회차의 것(격리 corral·
// 미끼)인지 본다** — 아니면(사용자가 Mac 을 쓰는 중) 그 자리에서 중단하고 종료코드 3 으로 끝난다(469·478 절차).
// 완료 만들기: provider 없는 `pane.report_agent`(working → idle) — 격리 backend 소켓에 직접.
//
// 사용: node app/scripts/l471/unread-isolated.mjs --out <raw 폴더> [--work /tmp/l471i] [--port 9472] [--restarts 3] [--ledger <runs.md> --label <이름>]
// 결과: <out>/result.json(검사 목록·시간축) · <out>/shots/*.png. 종료코드 0 = 전 검사 통과 · 1 = 검사 실패 · 2 = 하네스 오류 · 3 = 사용자 활동으로 중단.
/* global document, getComputedStyle, PointerEvent, MouseEvent -- CDP evaluate 클로저 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  appendRun, backendRpc, guardWork, inputs, isolation, launchCorral, loadSample, makeRepo, parseArgs, pause, quitCorral, rpc, startBackend, stopPid, until,
} from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const repoRoot = path.resolve(appRoot, '..')
const args = parseArgs(process.argv.slice(2))
const work = guardWork(args.work ?? '/tmp/l471i')
const out = path.resolve(String(args.out ?? 'l471-iso-out'))
const port = Number(args.port ?? 9472)
const restarts = Number(args.restarts ?? 3)
const shots = path.join(out, 'shots')
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
const t0 = Date.now()
const log = (...parts) => console.log(`[l471-iso +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)

const checks = []
const timeline = []
const fronts = []
function check(id, criterion, pass, observed) {
  checks.push({ id, criterion, pass: pass === true, observed })
  log(pass ? 'PASS' : 'FAIL', id, JSON.stringify(observed).slice(0, 300))
}
class UserActive extends Error {}

// --- OS 앞 창 도우미 (winctl · decoy 는 /tmp/l471-bin 에 빌드) -------------------------------------------------
const bin = '/tmp/l471-bin'
function buildTools() {
  fs.mkdirSync(bin, { recursive: true })
  for (const [name, src] of [['winctl', path.join(appRoot, 'scripts/l470/winctl.swift')], ['decoy', path.join(here, 'decoy.swift')]]) {
    const target = path.join(bin, name)
    if (!fs.existsSync(target) || fs.statSync(target).mtimeMs < fs.statSync(src).mtimeMs) execFileSync('swiftc', ['-O', '-o', target, src], { stdio: 'ignore' })
  }
}
const winctl = (...rest) => JSON.parse(execFileSync(path.join(bin, 'winctl'), rest.map(String), { encoding: 'utf8' }))
let decoy = null
let corralPid = null
function electronPid() {
  const ps = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
  const line = ps.split('\n').find((row) => row.includes(`--remote-debugging-port=${port}`) && row.includes('Electron.app/Contents/MacOS/Electron') && !row.includes('Helper'))
  return line === undefined ? null : Number(line.trim().split(/\s+/)[0])
}
/** 활성화 직전 확인 — 맨 앞 앱이 이 회차의 것인가(469·478 ⓑ, 사용자 활동 감지). 처음 한 번은 회차 시작 전 앞 앱을 적어 둔다. */
// 직전 자기 앱 이벤트(활성화·미끼·기동·종료) — guard 가 걸리면 그 간격과 미끼 생존을 원자료로(r3 코디 지시 ask-5).
let lastOwn = null
const ownEvent = (label) => {
  lastOwn = { label, at: Date.now() - t0 }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function guardFront(label) {
  const front = winctl('front')
  const ours = new Set([corralPid, decoy?.pid].filter((pid) => pid !== null && pid !== undefined))
  const at = Date.now() - t0
  const entry = { label, frontPid: front.pid, ours: ours.has(front.pid), at }
  fronts.push(entry)
  if (!entry.ours) {
    entry.lastOwn = lastOwn === null ? null : { ...lastOwn, gapMs: at - lastOwn.at }
    entry.decoyAlive = decoy === null ? null : alive(decoy.pid)
    throw new UserActive(`맨 앞 앱이 이 회차의 것이 아니다(${label}) — 사용자 활동으로 보고 중단`)
  }
}
async function attention() {
  return app.cdp.evaluate(() => document.documentElement.dataset.windowAttention ?? null)
}
async function waitAttention(want, label) {
  const ok = await until(async () => ((await attention()) === want ? true : null), `attention ${want} (${label})`, 8000, 150).then(() => true).catch(() => false)
  if (!ok) return { ok, value: await attention(), raw: await app.cdp.evaluate(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState })) }
  return { ok, value: await attention() }
}
async function focusCorral(label) {
  guardFront(`focus-corral:${label}`)
  winctl('activate', corralPid)
  ownEvent(`activate-corral:${label}`)
  await pause(400)
  const front = winctl('front')
  fronts.push({ label: `after-focus-corral:${label}`, frontPid: front.pid, ours: front.pid === corralPid, at: Date.now() - t0 })
  return waitAttention('watched', label)
}
async function decoyFront(label) {
  guardFront(`decoy-front:${label}`)
  if (decoy === null) {
    const child = spawn(path.join(bin, 'decoy'), [], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))))
    decoy = { child, pid }
    spawned.push({ pid, label: 'decoy window' })
    ownEvent(`decoy-spawn:${label}`)
  } else {
    process.kill(decoy.pid, 'SIGUSR1')
    ownEvent(`decoy-activate:${label}`)
  }
  // 미끼가 실제로 앞에 왔는지 표본으로 확인한다(최대 2초) — run7 은 고정 400ms 뒤 미끼가 아니었다.
  const waitedFrom = Date.now()
  let front = winctl('front')
  while (front.pid !== decoy.pid && Date.now() - waitedFrom < 2000) {
    await pause(100)
    front = winctl('front')
  }
  fronts.push({ label: `after-decoy:${label}`, frontPid: front.pid, ours: front.pid === decoy.pid, waitedMs: Date.now() - waitedFrom, at: Date.now() - t0 })
  if (front.pid !== decoy.pid) {
    const entry = fronts.at(-1)
    entry.lastOwn = { ...lastOwn, gapMs: entry.at - lastOwn.at }
    entry.decoyAlive = alive(decoy.pid)
    throw new UserActive(`미끼가 2초 안에 앞에 오지 않았다(${label}) — 사용자 활동일 수 있어 중단`)
  }
  return waitAttention('away', label)
}

// --- 격리 인스턴스 ---------------------------------------------------------------------------------------------
const iso = isolation({ work, session: 'l471-iso' })
const spawned = []
let backend = null
let app = null
let ui = null
const ctl = (request) => rpc(iso.control, request, 30_000)
const visibility = (action) => ctl({ cmd: 'window-visibility', action })
/** 캡처 — 창이 숨김·최소화면 Page.captureScreenshot 이 응답하지 않는다(run1 30초 타임아웃). 그때는 건너뛰고 이유를 남긴다. */
const shot = async (name) => {
  const visible = await app.cdp.evaluate(() => document.visibilityState === 'visible')
  if (!visible) {
    timeline.push({ label: `shot-skipped:${name}`, reason: 'window hidden', at: Date.now() - t0 })
    return
  }
  const { data } = await app.cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
const cardSel = (p) => `[data-worktree="${p}"] [data-worktree-card-surface]`
const rowSel = (paneId) => `[data-agent-row="${paneId}"]`

/** 화면 한 장 — 행(굵기·점)·카드(벨·상태 칸)·활성 카드·창 신호·열린 메뉴. */
async function snap() {
  return app.cdp.evaluate(() => {
    const rows = {}
    for (const el of document.querySelectorAll('[data-agent-row]')) {
      rows[el.getAttribute('data-agent-row')] = { unseen: el.getAttribute('data-unseen-done') === 'true', dot: el.querySelector('[data-agent-dot]')?.getAttribute('data-agent-dot') ?? null, focused: el.getAttribute('data-focused-agent-pane') === 'true' }
    }
    const cards = {}
    for (const el of document.querySelectorAll('[data-worktree]')) {
      const toggle = el.querySelector('[data-worktree-unread-toggle]')
      cards[el.getAttribute('data-worktree')] = {
        bell: toggle?.getAttribute('data-worktree-unread-toggle') ?? null,
        status: el.querySelector('[data-worktree-status]')?.getAttribute('data-worktree-status') ?? null,
        active: el.querySelector('[data-worktree-card-active]') !== null,
        title: toggle?.getAttribute('title') ?? null,
      }
    }
    const menu = document.querySelector('[data-card-menu]')
    return {
      attention: document.documentElement.dataset.windowAttention ?? null,
      rows,
      cards,
      reordering: document.querySelector('.sidebar.is-reordering') !== null,
      menu: menu === null ? null : [...menu.querySelectorAll('[data-menu-action]')].map((item) => ({ action: item.getAttribute('data-menu-action'), label: item.textContent?.trim() ?? '', disabled: item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled') })),
    }
  })
}
function findKey(value, key) {
  if (value === null || typeof value !== 'object') return undefined
  if (key in value) return value[key]
  for (const child of Object.values(value)) {
    const found = findKey(child, key)
    if (found !== undefined) return found
  }
  return undefined
}
/** herdr 가 지금 그 pane 을 어떻게 보나(재동기 없이 직접 묻는다). */
async function herdr(paneId) {
  try {
    return findKey(await backendRpc(iso, 'pane.get', { pane_id: paneId }), 'agent_status') ?? null
  } catch (error) {
    return `error:${String(error).slice(0, 80)}`
  }
}
const report = (paneId, state) => backendRpc(iso, 'pane.report_agent', { pane_id: paneId, source: 'l471-iso', agent: 'claude', state })
/** 완료 만들기 — working 을 화면이 본 뒤 idle. 앞뒤 herdr 값을 시간축에. */
async function complete(paneId, label) {
  await report(paneId, 'working')
  await until(async () => ((await snap()).rows[paneId]?.dot === 'working' ? true : null), `working seen ${paneId}`, 8000, 120).catch(() => {})
  await pause(300)
  await report(paneId, 'idle')
  await pause(1500)
  const entry = { label, paneId, herdrAfter: await herdr(paneId), at: Date.now() - t0 }
  timeline.push(entry)
  return entry
}
/** 포커스를 주지 않는 클릭 — 페이지 안 DOM 이벤트만(React 핸들러가 받는다). */
async function domClick(selector) {
  const ok = await app.cdp.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el === null) return false
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }))
    return true
  }, selector)
  if (!ok) throw new Error(`domClick: ${selector} 없음`)
}
async function openMenu(p) {
  await ui.rightClick(cardSel(p))
  await until(() => app.cdp.evaluate(() => document.querySelector('[data-card-menu]') !== null), 'card menu', 5000).catch(() => {})
}
async function menuAction(p, action) {
  await openMenu(p)
  const before = (await snap()).menu
  await ui.click(`[data-card-menu] [data-menu-action="${action}"]`)
  await pause(500)
  return before
}
async function bellClick(p) {
  await ui.click(`[data-worktree="${p}"] [data-worktree-unread-toggle]`)
  await pause(500)
}
async function readMenuThenClose(p) {
  await openMenu(p)
  const menu = (await snap()).menu
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pause(300)
  return menu
}
const readPrefs = () => (fs.existsSync(iso.prefsFile) ? JSON.parse(fs.readFileSync(iso.prefsFile, 'utf8')) : null)
async function launch(label) {
  app = await launchCorral({ iso, appRoot, port, socket: iso.realSocket, spawned })
  ui = inputs(app.cdp)
  corralPid = electronPid()
  spawned.push({ pid: corralPid, label: `corral Electron main (${label})` })
  ownEvent(`launch:${label}`)
  log('launched', label, 'electron pid', corralPid)
}

const result = { build: null, load: { before: loadSample() }, checks, timeline, fronts, restartsDone: 0, spawned, ok: false, aborted: null, error: null }
let exitCode = 2
try {
  buildTools()
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
  const bundle = path.join(appRoot, 'out/renderer/index.html')
  result.build = { head, rendererBundleMtime: fs.statSync(bundle).mtime.toISOString(), dirty: spawnSync('git', ['status', '--porcelain', 'app/src'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim().length > 0 }
  result.frontAtStart = winctl('front')

  const { root, worktrees } = makeRepo({ reposDir: path.join(work, 'repos'), name: 'iso', linked: ['wt-b', 'wt-c'] })
  const A = root
  const B = worktrees['wt-b']
  const C = worktrees['wt-c']
  result.paths = { A: 'iso', B: 'iso-wt/wt-b', C: 'iso-wt/wt-c' }
  // 478 출고 모양 ui-prefs(벨 칸 없음) — K8ⓒ.
  const legacy = {
    version: 1, sidebarWidth: 300, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: [], expandedAgentGroups: [A, B], tabOrdinals: [], groupLayouts: [],
    manualRepoOrder: [], manualWorktreeOrder: {}, manualFlatOrder: [], pinnedWorktrees: [], sidebarGroupBy: 'repo', sidebarSortBy: 'manual', sidebarProjectOrderBy: 'manual',
    sidebarRepoFilter: [], sidebarHideDefaultBranch: false, sidebarHideDetachedHead: false, sidebarCardLayout: 'detailed', sidebarCardProperties: ['inline-agents'], sidebarAgentActivityLayout: 'compact',
  }
  fs.writeFileSync(iso.prefsFile, JSON.stringify(legacy, null, 2) + '\n')
  backend = await startBackend({ iso, logFile: path.join(out, 'backend.log'), spawned })
  await launch('L1')
  // K8ⓒ 파일 대조는 add-repo **전에** — add-repo 는 순서 칸(manualRepoOrder 등)을 정상적으로 쓰고, main 은 쓸 때 전체 prefs 를 정규화해
  // 새 칸(`unreadWorktrees: []`)도 함께 싣는다(run1 에서 파일 전체 동일을 기대해 오판). 벨 칸은 없거나 빈 배열이어야 한다.
  const prefs0 = readPrefs()
  const added = await ctl({ cmd: 'add-repo', root: A })
  if (!added.ok) throw new Error(`add-repo: ${JSON.stringify(added)}`)
  await until(() => app.cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length === 3), 'three cards', 60_000)

  // ── K8ⓒ 478 모양 prefs → 벨 없음 · 다른 칸 그대로 ──
  let s = await snap()
  const legacyKept = Object.entries(legacy).every(([key, value]) => JSON.stringify(prefs0?.[key]) === JSON.stringify(value))
  const bellField = prefs0?.unreadWorktrees ?? null
  check('K8c-legacy-no-bells', 'K8ⓒ 478 모양 ui-prefs 로 기동 → 벨 0 · (add-repo 전) 파일의 기존 칸 값 그대로 · 벨 칸은 없거나 빈 배열', Object.values(s.cards).every((card) => card.bell === 'read') && legacyKept && (bellField === null || (Array.isArray(bellField) && bellField.length === 0)), { bells: Object.values(s.cards).map((c) => c.bell), legacyKept, bellField, prefsKeys: Object.keys(prefs0 ?? {}) })

  // ── 배치: A = t1(p1|p2 split) + t2(p3) · B = t1(p4) ──
  const state = async () => (await ctl({ cmd: 'state' })).state
  const wsOf = async (p) => (await state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === p)?.workspace ?? null
  for (const p of [A, B]) {
    await ui.click(cardSel(p))
    await until(async () => (await wsOf(p))?.tabs?.length > 0, `workspace open ${p}`, 60_000)
  }
  const wsA = await wsOf(A)
  await backendRpc(iso, 'tab.create', { workspace_id: wsA.workspaceId })
  await backendRpc(iso, 'pane.split', { target_pane_id: wsA.tabs[0].panes[0].paneId, direction: 'right', focus: false })
  await until(async () => {
    const ws = await wsOf(A)
    return ws.tabs.length === 2 && ws.tabs[0].panes.length === 2
  }, 'A layout', 30_000)
  const a = await wsOf(A)
  const b = await wsOf(B)
  const [p1, p2] = a.tabs[0].panes.map((p) => p.paneId)
  const p3 = a.tabs[1].panes[0].paneId
  const p4 = b.tabs[0].panes[0].paneId
  const [t1, t2] = a.tabs.map((t) => t.tabId)
  result.ids = { p1, p2, p3, p4, t1, t2 }
  for (const pane of [p1, p2, p3, p4]) await report(pane, 'idle')
  await until(() => app.cdp.evaluate((ids) => ids.every((id) => document.querySelector(`[data-agent-row="${id}"]`) !== null), [p1, p2, p3, p4]), 'agent rows', 30_000)
  // 활성 = A · 탭 t1 · p1 선택.
  await ui.click(cardSel(A))
  await ui.click(rowSel(p1))
  await pause(800)

  // ── K1 창 신호 — 실제 앱 활성화 · control hide/minimize ──
  const k1 = {}
  k1.focus1 = await focusCorral('K1-start')
  k1.decoy = await decoyFront('K1-other-app')
  k1.focus2 = await focusCorral('K1-back')
  k1.hide = { reply: await visibility('hide'), attention: (await waitAttention('away', 'K1-hide')).value }
  k1.show = { reply: await visibility('show'), attention: (await focusCorral('K1-show')).value }
  k1.minimize = { reply: await visibility('minimize'), attention: (await waitAttention('away', 'K1-minimize')).value }
  await visibility('restore')
  k1.restore = { attention: (await focusCorral('K1-restore')).value }
  check('K1a-signal', 'K1ⓐⓑⓒ 창 신호: 포커스 watched → 다른 앱(미끼) 활성화 away → 복귀 watched → hide away → show watched → minimize away → restore watched', k1.focus1.value === 'watched' && k1.decoy.value === 'away' && k1.focus2.value === 'watched' && k1.hide.attention === 'away' && k1.show.attention === 'watched' && k1.minimize.attention === 'away' && k1.restore.attention === 'watched', k1)

  // ── K2ⓒ 보고 있는 pane 완료 = 안 읽음 아님 ──
  let c = await complete(p1, 'K2c-watched-selected')
  s = await snap()
  check('K2c-watched-selected', 'K2ⓒ 보고 있는(선택+창 보임+포커스) pane 완료 → 안 읽음 아님 · 벨 꺼짐', !s.rows[p1].unseen && s.cards[A].bell === 'read' && s.rows[p1].dot === 'idle', { row: s.rows[p1], bell: s.cards[A].bell, herdr: c.herdrAfter })
  // ── K2ⓑ 같은 탭 split pane ──
  c = await complete(p2, 'K2b-split-sibling')
  s = await snap()
  check('K2b-split-sibling', 'K2ⓑ 같은 탭 다른 split pane 완료 → 안 읽음 + 벨 (herdr 는 탭 단위 seen 이라 idle)', s.rows[p2].unseen && s.rows[p2].dot === 'done' && s.cards[A].bell === 'unread' && !s.rows[p1].unseen, { p2: s.rows[p2], bell: s.cards[A].bell, herdr: c.herdrAfter })
  await shot('k2b-split-unread')
  // ── K3ⓐ 선택 전환으로 확인 ──
  await ui.click(rowSel(p2))
  await pause(800)
  s = await snap()
  check('K3a-select', 'K3ⓐ 그 pane 을 선택(보고 있음) → 확인 · 남은 안 읽음 없어 벨 꺼짐', !s.rows[p2].unseen && s.cards[A].bell === 'read', { p2: s.rows[p2], bell: s.cards[A].bell })
  await ui.click(rowSel(p1))
  await pause(500)
  // ── 다른 탭 · K4ⓑ Mark Read 뒤 herdr done 이어도 done 아님 ──
  c = await complete(p3, 'K2-other-tab')
  s = await snap()
  check('K2-other-tab', 'K2 다른 탭 pane 완료 → 안 읽음 + 벨 (herdr done)', s.rows[p3].unseen && s.cards[A].bell === 'unread', { p3: s.rows[p3], bell: s.cards[A].bell, herdr: c.herdrAfter })
  const menuBefore = await menuAction(A, 'toggle-unread')
  s = await snap()
  const herdrP3 = await herdr(p3)
  check('K4b-markread-herdr-done', 'K4ⓑ Mark Read 로 확인한 완료는 herdr 가 아직 done 이어도 행 굵기·행 점·카드 상태 칸 모두 done 아님', !s.rows[p3].unseen && s.rows[p3].dot === 'idle' && s.cards[A].status !== 'done' && s.cards[A].bell === 'read' && herdrP3 === 'done', { p3: s.rows[p3], card: s.cards[A], herdr: herdrP3 })
  const labels = menuBefore?.map((item) => item.label) ?? []
  const pinAt = labels.indexOf('고정')
  check('K6a-menu-position-read', 'K6ⓐ 벨 켜짐 → Pin 바로 아래 「읽음으로 표시」', pinAt >= 0 && labels[pinAt + 1] === '읽음으로 표시', { labels })

  // ── K2ⓐ 창 숨김 중 선택 pane 완료 → K3ⓐ 창 복귀로 확인 ──
  await visibility('hide')
  await waitAttention('away', 'K2a-hide')
  c = await complete(p1, 'K2a-hidden-selected')
  s = await snap()
  const hiddenUnread = s.rows[p1].unseen && s.cards[A].bell === 'unread'
  await shot('k2a-hidden-unread')
  await visibility('show')
  await focusCorral('K3a-return-from-hide')
  await pause(800)
  let s2 = await snap()
  check('K2a-hidden', 'K2ⓐ 창 숨김 중 선택 pane 완료 → 안 읽음 + 벨 (herdr 는 done 을 건너뛴 idle) · K3ⓐ 창 복귀로 확인 → 벨 꺼짐', hiddenUnread && c.herdrAfter === 'idle' && !s2.rows[p1].unseen && s2.cards[A].bell === 'read', { hidden: { row: s.rows[p1], bell: s.cards[A].bell, attention: s.attention }, herdr: c.herdrAfter, back: { row: s2.rows[p1], bell: s2.cards[A].bell, attention: s2.attention } })
  // ── K2ⓐ 최소화 ──
  await visibility('minimize')
  await waitAttention('away', 'K2a-minimize')
  c = await complete(p1, 'K2a-minimized-selected')
  s = await snap()
  const minUnread = s.rows[p1].unseen && s.cards[A].bell === 'unread'
  await visibility('restore')
  await focusCorral('K3a-return-from-minimize')
  await pause(800)
  s2 = await snap()
  check('K2a-minimized', 'K2ⓐ 최소화 중 선택 pane 완료 → 안 읽음 + 벨 · 복원·포커스로 확인', minUnread && !s2.rows[p1].unseen && s2.cards[A].bell === 'read', { minimized: { row: s.rows[p1], bell: s.cards[A].bell }, herdr: c.herdrAfter, back: { row: s2.rows[p1], bell: s2.cards[A].bell } })
  // ── K2ⓐ 다른 앱 앞 ──
  await decoyFront('K2a-other-app')
  c = await complete(p1, 'K2a-other-app-selected')
  s = await snap()
  const appUnread = s.rows[p1].unseen && s.cards[A].bell === 'unread' && s.attention === 'away'
  await focusCorral('K3a-focus-return')
  await pause(800)
  s2 = await snap()
  check('K2a-other-app', 'K2ⓐ 다른 앱이 앞인 채 선택 pane 완료 → 안 읽음 + 벨 · K3ⓐ 포커스 복귀로 확인', appUnread && c.herdrAfter === 'idle' && !s2.rows[p1].unseen && s2.cards[A].bell === 'read', { away: { row: s.rows[p1], bell: s.cards[A].bell, attention: s.attention }, herdr: c.herdrAfter, back: { row: s2.rows[p1], bell: s2.cards[A].bell } })

  // ── K3ⓑ 숨은 채 선택만 바뀐 것은 확인이 아니다 ──
  await visibility('hide')
  await waitAttention('away', 'K3b-hide')
  await complete(p2, 'K3b-hidden-p2')
  await ui.click(rowSel(p2)).catch((error) => timeline.push({ label: 'K3b-hidden-click-error', error: String(error) }))
  await pause(800)
  s = await snap()
  const stillUnreadHidden = s.rows[p2].unseen
  const focusedWhileHidden = s.rows[p2].focused
  await visibility('show')
  await focusCorral('K3b-show')
  await pause(800)
  s2 = await snap()
  check('K3b-hidden-select', 'K3ⓑ 창이 숨은 채 선택이 p2 로 바뀌어도 확인 아님 → 창이 보이고 포커스가 되면(보고 있음) 그때 확인', stillUnreadHidden && focusedWhileHidden && !s2.rows[p2].unseen, { hidden: { row: s.rows[p2] }, back: { row: s2.rows[p2], bell: s2.cards[A].bell } })
  // 다른 앱 앞 + 선택 변경
  await ui.click(rowSel(p1))
  await decoyFront('K3b-other-app')
  await complete(p3, 'K3b-away-p3')
  // 선택 변경은 DOM 이벤트로 — CDP Input 클릭은 페이지에 포커스를 줘 다른 앱이 앞인데도 hasFocus 가 참이 된다(run2·run3 오판).
  // 실제로 다른 앱이 앞인 채 선택이 바뀌는 길은 클릭이 아니라 CLI·herdr 쪽 전환이다 — 여기서는 같은 React 핸들러를 포커스 없이 부른다.
  await domClick(`[data-main-tab="${t2}"]`)
  await domClick(rowSel(p3))
  await pause(800)
  s = await snap()
  const stillUnreadAway = s.rows[p3].unseen
  await focusCorral('K3b-focus')
  await pause(800)
  s2 = await snap()
  check('K3b-away-select', 'K3ⓑ 다른 앱이 앞인 채 선택이 p3 으로 바뀌어도 확인 아님 → 포커스 복귀 때 확인', stillUnreadAway && s.rows[p3].focused && s.attention === 'away' && !s2.rows[p3].unseen, { away: { row: s.rows[p3], attention: s.attention }, back: { row: s2.rows[p3], bell: s2.cards[A].bell } })
  await ui.click(`[data-main-tab="${t1}"]`).catch(() => {})
  await ui.click(rowSel(p1))
  await pause(600)

  // ── K3ⓒ 같은 worktree 의 다른 pane 안 읽음은 남는다 ──
  await decoyFront('K3c')
  await complete(p2, 'K3c-p2')
  await complete(p3, 'K3c-p3')
  await focusCorral('K3c-back')
  await pause(600)
  s = await snap()
  await ui.click(rowSel(p2))
  await pause(800)
  s2 = await snap()
  check('K3c-others-remain', 'K3ⓒ p2·p3 안 읽음 · p1 을 보며 복귀 → 둘 다 남음 · p2 선택 → p2 만 확인, p3·벨 남음', s.rows[p2].unseen && s.rows[p3].unseen && !s2.rows[p2].unseen && s2.rows[p3].unseen && s2.cards[A].bell === 'unread', { before: { p2: s.rows[p2], p3: s.rows[p3] }, after: { p2: s2.rows[p2], p3: s2.rows[p3], bell: s2.cards[A].bell } })
  // ── K6ⓒ Mark Read = 벨 끄기 + 그 worktree pane 안 읽음 전부 확인 ──
  await menuAction(A, 'toggle-unread')
  s = await snap()
  check('K6c-markread-all', 'K6ⓒ Mark Read → 벨 꺼짐 + p3 안 읽음 확인', s.cards[A].bell === 'read' && !s.rows[p3].unseen, { bell: s.cards[A].bell, p3: s.rows[p3] })
  await ui.click(rowSel(p1))
  await pause(500)

  // ── K6ⓑⓓ Mark Unread (완료 없는 worktree · 보고 있는 worktree) · 활성화로 풀림 ──
  let menuB = await readMenuThenClose(B)
  const labelsB = menuB?.map((item) => item.label) ?? []
  await menuAction(B, 'toggle-unread')
  s = await snap()
  check('K6b-markunread-empty', 'K6ⓐⓑ 완료 없는 worktree(B) 메뉴 Pin 아래 「안 읽음으로 표시」 → 벨 켜짐', labelsB[labelsB.indexOf('고정') + 1] === '안 읽음으로 표시' && s.cards[B].bell === 'unread', { labelsB, bell: s.cards[B].bell })
  await menuAction(A, 'toggle-unread')
  await pause(1800)
  s = await snap()
  check('K6d-protect', 'K6ⓓ 보고 있는 worktree(A, p1 선택·포커스)에 Mark Unread → 자동 확인이 바로 지우지 않는다(1.8s 뒤에도 켜짐)', s.cards[A].bell === 'unread' && s.attention === 'watched', { bell: s.cards[A].bell, attention: s.attention })
  await ui.click(cardSel(B))
  await pause(1000)
  s = await snap()
  const bOff = s.cards[B].bell === 'read' && s.cards[A].bell === 'unread'
  await ui.click(cardSel(A))
  await pause(1000)
  s2 = await snap()
  check('K7b-activation', 'K7ⓑ·K6ⓓ 보고 있는 중 활성화 A→B 는 B 벨을 끈다(A 벨 남음) · B→A 는 A 벨을 끈다', bOff && s2.cards[A].bell === 'read', { afterB: { A: s.cards[A].bell, B: s.cards[B].bell }, afterA: { A: s2.cards[A].bell, B: s2.cards[B].bell } })
  await ui.click(rowSel(p1))
  await pause(500)

  // ── K5 벨 클릭 — 토글 · 카드 활성화 없음 · 끌기 없음 · hover 흐린 벨 ──
  const activeBefore = Object.entries((await snap()).cards).find(([, card]) => card.active)?.[0] ?? null
  await ui.hover(`[data-worktree="${B}"] [data-worktree-unread-toggle]`)
  const hint = await app.cdp.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el === null ? null : { hint: getComputedStyle(el.querySelector('.worktree-unread-hint')).opacity, status: getComputedStyle(el.querySelector('.worktree-status')).opacity, title: el.getAttribute('title') }
  }, `[data-worktree="${B}"] [data-worktree-unread-toggle]`)
  await shot('k5-hover-hint')
  await bellClick(B)
  s = await snap()
  const onAfterClick = s.cards[B].bell === 'unread'
  await shot('k5-bell-on')
  const activeAfter = Object.entries(s.cards).find(([, card]) => card.active)?.[0] ?? null
  await bellClick(B)
  s2 = await snap()
  check('K5-bell-click', 'K5ⓐⓑⓒ hover → 흐린 벨 보임·상태 표시 숨김 · 클릭 → 벨 켜짐(채운 벨) · 다시 클릭 → 꺼짐 · 활성 카드 그대로 · 끌기 시작 없음', hint !== null && Number(hint.hint) > 0.9 && Number(hint.status) < 0.1 && onAfterClick && s2.cards[B].bell === 'read' && activeBefore === activeAfter && !s.reordering, { hint, onAfterClick, off: s2.cards[B].bell, activeBefore, activeAfter, reordering: s.reordering })

  // ── K4ⓓ 보존 행 — 닫힌 탭의 확인 안 된 완료 ──
  await decoyFront('K4d')
  await complete(p3, 'K4d-p3-before-close')
  await focusCorral('K4d-back')
  await backendRpc(iso, 'tab.close', { tab_id: t2 })
  await until(async () => ((await snap()).rows[`retained:${p3}`] !== undefined ? true : null), 'retained row', 10_000).catch(() => {})
  s = await snap()
  const retained = s.rows[`retained:${p3}`] ?? null
  await shot('k4d-retained-unread')
  await menuAction(A, 'toggle-unread')
  s2 = await snap()
  const retainedAfter = s2.rows[`retained:${p3}`] ?? null
  check('K4d-retained', 'K4ⓓ 닫힌 탭의 확인 안 된 완료 → 보존 행 굵게 + 완료 점 + 카드 벨(벨이 상태 칸을 대체 — K5ⓐ) · Mark Read → 대기 점, 카드 done 아님', retained?.unseen === true && retained?.dot === 'done' && s.cards[A].bell === 'unread' && retainedAfter?.unseen === false && retainedAfter?.dot === 'idle' && s2.cards[A].status !== 'done', { retained, cardBefore: { bell: s.cards[A].bell, status: s.cards[A].status }, retainedAfter, cardAfter: s2.cards[A].status })

  // ── K8ⓓ 지운 worktree 의 벨은 유령으로 안 남는다 ──
  await menuAction(C, 'toggle-unread')
  const prefsWithC = readPrefs()?.unreadWorktrees ?? null
  execFileSync('git', ['worktree', 'remove', '--force', C], { cwd: A })
  await ctl({ cmd: 'rebuild-tree' })
  await until(() => app.cdp.evaluate((p) => document.querySelector(`[data-worktree="${p}"]`) === null, C), 'card C gone', 20_000).catch(() => {})
  await pause(800)
  const prefsAfterC = readPrefs()?.unreadWorktrees ?? null
  check('K8d-ghost', 'K8ⓓ 벨 켠 worktree(C)를 지우면 ui-prefs 벨 목록에서도 빠진다', Array.isArray(prefsWithC) && prefsWithC.includes(C) && Array.isArray(prefsAfterC) && !prefsAfterC.includes(C), { withC: prefsWithC?.map((p) => path.basename(p)), afterC: prefsAfterC?.map((p) => path.basename(p)) })

  // ── r2 F-E 첫 묶음 뒤에 처음 나타난 pane — 세션 중 레포 추가 (r3 M-2ⓐ 재설계) ──
  // corral 이 그 레포를 모르는 동안 herdr 에서 working → idle 이 지나간 pane 을 add-repo 로 처음 보게 한다.
  // R055 실패 원인: main 은 에이전트 상태를 **pane id 목록 구독**으로 받고 그 구독은 토폴로지 변경 뒤 debounce 로 다시 열린다
  // (`link.ts` scheduleAgentSubscription · `agent.sub.open`). 구독이 새 pane 을 덮기 전에 보고한 전이는 거울에 안 남는다 →
  // 이번에는 main 로그(`corral.ndjson`)로 ① 새 pane 을 덮은 구독이 열린 뒤 ② 각 전이가 거울에 반영된 뒤에 다음 단계로 간다.
  // 기대: 처음 볼 때 이력에 working 이 있다(전제) · 그 이력은 벨·굵기를 만들지 않는다 · 대조: 그 뒤 새 working → idle 은 벨 + 굵기.
  {
    const mainLog = path.join(iso.userData, 'corral.ndjson')
    const logSince = (from) =>
      (fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split('\n') : [])
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((entry) => entry !== null && entry.at >= from)
    const waitLog = async (label, from, test) =>
      until(() => (logSince(from).some(test) ? true : null), label, 10_000, 100).then(() => true, () => false)
    const late = makeRepo({ reposDir: path.join(work, 'repos'), name: 'late', linked: [] })
    const L = late.root
    result.paths.L = 'late'
    const fe = { steps: [] }
    const createdAt = Date.now()
    const created = await backendRpc(iso, 'workspace.create', { cwd: L, focus: false })
    const pL = findKey(created, 'root_pane')?.pane_id ?? findKey(created, 'pane_id')
    if (pL === undefined) throw new Error(`F-E: workspace.create 응답에 pane id 없음 ${JSON.stringify(created).slice(0, 200)}`)
    // ① 새 pane 까지 덮은 상태 구독 — workspace.create 뒤에 열린 agent.sub.open.
    fe.steps.push({ step: 'agent.sub.open after create', ok: await waitLog('F-E sub open', createdAt, (e) => e.tag === 'agent.sub.open') })
    // ② idle(정체 감지) → working → idle, 매번 거울 반영(agent.push.applied note) 확인 뒤 다음.
    for (const [state, arrow] of [['idle', '→ idle'], ['working', '→ working'], ['idle', '→ idle']]) {
      const from = Date.now()
      await report(pL, state)
      fe.steps.push({ step: `report ${state}`, ok: await waitLog(`F-E ${state}`, from, (e) => e.tag === 'agent.push.applied' && String(e.note ?? '').includes(arrow)) })
    }
    fe.mirrorLog = logSince(createdAt)
      .filter((e) => e.tag === 'agent.sub.open' || e.tag === 'agent.push.applied')
      .map((e) => ({ t: e.at - createdAt, tag: e.tag, note: e.note ?? null, panes: e.panes ?? null }))
    const addedL = await ctl({ cmd: 'add-repo', root: L })
    if (!addedL.ok) throw new Error(`add-repo late: ${JSON.stringify(addedL)}`)
    await until(() => app.cdp.evaluate((id) => document.querySelector(`[data-agent-row="${id}"]`) !== null, pL), 'late row', 60_000)
    await pause(1500)
    const lateState = (await state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === L)
    const latePane = lateState?.workspace?.tabs.flatMap((t) => t.panes).find((pane) => pane.paneId === pL)
    const historyOnFirstSight = latePane?.agentState.history.map((step) => step.status) ?? null
    s = await snap()
    const first = { row: s.rows[pL], bell: s.cards[L]?.bell, herdr: await herdr(pL), status: latePane?.agentStatus ?? null, historyOnFirstSight }
    const c = await complete(pL, 'F-E late new transition')
    s = await snap()
    const after = { row: s.rows[pL], bell: s.cards[L]?.bell, herdr: c.herdrAfter }
    const premise = Array.isArray(historyOnFirstSight) && historyOnFirstSight.includes('working')
    result.fe = { ...fe, premise }
    check('FE-late-pane', 'r2 F-E 세션 중 추가한 레포의 pane(전제: 처음 볼 때 이력에 working → idle 이 있음) → 처음 볼 때 벨·굵기 없음 · 그 뒤 새 완료는 벨 + 굵기',
      premise && first.row?.unseen === false && first.bell === 'read' && after.row?.unseen === true && after.bell === 'unread',
      { premise, steps: fe.steps, first, after })
    // 벨을 꺼 둔다(control 에 레포 제거가 없어 late 는 남는다 — 이후 재시작 검사는 A·B 만 본다).
    await menuAction(L, 'toggle-unread')
  }

  // ── 재시작 준비: 벨 B(수동) · 비활성 탭 done(p5, B) · 456 R3-F3 「활성 탭 + done」(A) ──
  await menuAction(B, 'toggle-unread')
  const tB = await backendRpc(iso, 'tab.create', { workspace_id: b.workspaceId })
  const t5 = findKey(tB, 'tab_id')
  await until(async () => (await wsOf(B)).tabs.length === 2, 'B tab2', 20_000)
  const p5 = (await wsOf(B)).tabs.find((t) => t.tabId === t5).panes[0].paneId
  await report(p5, 'idle')
  await decoyFront('K9-prep')
  await complete(p5, 'K9-prep-p5-inactive-tab')
  // A: 새 탭 t3 에서 완료(비활성 탭 → herdr done) → 활성 탭 t1 을 닫아 t3 이 「활성 탭 + done」 이 되게.
  const tA = await backendRpc(iso, 'tab.create', { workspace_id: a.workspaceId })
  const t3 = findKey(tA, 'tab_id')
  await until(async () => (await wsOf(A)).tabs.some((t) => t.tabId === t3), 'A t3', 20_000)
  const p6 = (await wsOf(A)).tabs.find((t) => t.tabId === t3).panes[0].paneId
  await report(p6, 'idle')
  await complete(p6, 'K9-prep-p6')
  await focusCorral('K9-prep-back')
  result.ids = { ...result.ids, p5, p6, t3, t5 }
  result.k9Prep = { herdrP5: await herdr(p5), herdrP6BeforeClose: await herdr(p6) }

  // ── 재시작 ×N — K8ⓐ 벨 유지 · K8ⓔ herdr done 에서 행 굵기 다시 · K9 시간축 ──
  const restartRows = []
  let p7 = null
  for (let round = 1; round <= restarts; round += 1) {
    if (round === 1) {
      // 456 R3-F3: 활성 탭(t1) 을 닫아 t3 을 「활성 탭 + done」 으로.
      await backendRpc(iso, 'tab.close', { tab_id: t1 })
      await pause(800)
      result.k9Prep.herdrP6AfterClose = await herdr(p6)
      result.k9Prep.activeTabAfterClose = findKey(await backendRpc(iso, 'session.snapshot'), 'focused_tab_id') ?? null
      // fix1 M2: A 의 새 비활성 탭 t4 pane p7 완료(herdr done, 벨 A 켜짐) → Mark Read(벨 끔 — herdr 는 done 그대로) → 재기동마다
      // p7 은 처음 보는 done 이라 굵게 서지만 A 벨은 새로 켜지지 않아야 한다(01-criteria 변경 기록).
      const t4 = findKey(await backendRpc(iso, 'tab.create', { workspace_id: a.workspaceId, focus: false }), 'tab_id')
      await until(async () => (await wsOf(A)).tabs.some((t) => t.tabId === t4), 'A t4', 20_000)
      p7 = (await wsOf(A)).tabs.find((t) => t.tabId === t4).panes[0].paneId
      await report(p7, 'idle')
      await complete(p7, 'M2-prep-p7-inactive-tab')
      const bellBeforeRead = (await snap()).cards[A].bell
      await menuAction(A, 'toggle-unread')
      result.m2Prep = { herdrP7: await herdr(p7), bellBeforeRead, bellAfterRead: (await snap()).cards[A].bell, prefs: readPrefs()?.unreadWorktrees?.map((p) => path.basename(p)) ?? null }
      result.ids = { ...result.ids, p7, t4 }
    }
    const before = { prefs: readPrefs()?.unreadWorktrees?.map((p) => path.basename(p)) ?? null, herdr: { p5: await herdr(p5), p6: await herdr(p6), p7: await herdr(p7) } }
    // 둘째 회차는 미끼가 앞인 채 기동한다(창이 포커스가 아닌 시작 복원 — K3ⓑ·K9ⓑ 의 다른 갈래).
    if (round === 2) await decoyFront(`restart-${round}-before`)
    ownEvent(`quit:R${round}`)
    await quitCorral({ iso, app })
    const launchAt = Date.now()
    await launch(`R${round}`)
    const series = []
    for (let i = 0; i < 24; i += 1) {
      const snapNow = await snap()
      series.push({ t: Date.now() - launchAt, attention: snapNow.attention, herdr: { p5: await herdr(p5), p6: await herdr(p6), p7: await herdr(p7) }, rows: { p5: snapNow.rows[p5] ?? null, p6: snapNow.rows[p6] ?? null, p7: snapNow.rows[p7] ?? null }, bells: Object.fromEntries(Object.entries(snapNow.cards).map(([k, v]) => [path.basename(k), v.bell])), status: Object.fromEntries(Object.entries(snapNow.cards).map(([k, v]) => [path.basename(k), v.status])) })
      await pause(250)
    }
    const last = series.at(-1)
    await shot(`restart-${round}`)
    restartRows.push({ round, before, series })
    check(`K8a-restart-${round}`, `K8ⓐ 재시작 ${round}: 벨 B 유지(ui-prefs·화면) · K8ⓔ 비활성 탭 herdr done(p5) 행이 다시 굵게`, last.bells['wt-b'] === 'unread' && (readPrefs()?.unreadWorktrees ?? []).includes(B) && last.rows.p5?.unseen === true, { before, last: { bells: last.bells, p5: last.rows.p5, herdrP5: last.herdr.p5 } })
    // fix1 M2 — 시간축 전 구간에서 A 벨이 한 번도 안 켜지고, Mark Read 한 herdr done(p7)은 굵게 선다.
    const aBellEver = series.some((row) => row.bells.iso === 'unread')
    check(`M2-restart-${round}`, `M2 재시작 ${round}: Mark Read 한 비활성 탭 herdr done(p7) → 행은 굵게, A 벨은 새로 안 켜짐(저장값 = 꺼짐) · prefs 에 A 없음`, result.m2Prep?.herdrP7 === 'done' && result.m2Prep?.bellAfterRead === 'read' && last.herdr.p7 === 'done' && last.rows.p7?.unseen === true && !aBellEver && !(readPrefs()?.unreadWorktrees ?? []).includes(A), { prep: result.m2Prep, aBellEver, last: { p7: last.rows.p7, herdrP7: last.herdr.p7, bellA: last.bells.iso }, prefs: readPrefs()?.unreadWorktrees?.map((p) => path.basename(p)) ?? null })
    if (round === 2) await focusCorral(`restart-${round}-after`)
  }
  result.restarts = restartRows
  result.restartsDone = restartRows.length
  const r1 = restartRows[0]
  check('K9-recorded', 'K9ⓐ 「활성 탭 + done」(p6)·비활성 탭 done(p5) 으로 재기동 → herdr 값과 corral 표시를 한 시간축에 기록(판정은 RESULT 에서 — 기대: 보이고 포커스인 선택 pane 만 확인)', r1 !== undefined && r1.series.length > 0, { prep: result.k9Prep, r1First: r1?.series[0], r1Last: r1?.series.at(-1) })

  const failed = checks.filter((item) => !item.pass)
  result.ok = failed.length === 0
  exitCode = result.ok ? 0 : 1
} catch (error) {
  if (error instanceof UserActive) {
    result.aborted = String(error.message)
    exitCode = 3
  } else {
    result.error = String(error?.stack ?? error)
    exitCode = 2
  }
  log('STOP', result.aborted ?? result.error)
} finally {
  if (app !== null) await quitCorral({ iso, app }).catch(() => {})
  if (decoy !== null) {
    try {
      process.kill(decoy.pid, 'SIGTERM')
    } catch {
      // 이미 끝났다.
    }
  }
  await stopPid(backend?.pid, 'backend').catch(() => {})
  result.load.after = loadSample()
  await pause(500)
  result.cleanup = spawned.filter((s) => s.pid).map((s) => {
    let alive = false
    try {
      process.kill(s.pid, 0)
      alive = true
    } catch {
      alive = false
    }
    return { ...s, aliveAfter: alive }
  })
  result.frontAtEnd = (() => {
    try {
      return winctl('front')
    } catch {
      return null
    }
  })()
  // 원자료에 다른 앱 이름을 싣지 않는다(G7) — 이 회차의 것(corral·미끼)이 아니면 이름을 지운다.
  for (const key of ['frontAtStart', 'frontAtEnd']) if (result[key] !== null && result[key] !== undefined) result[key] = { pid: result[key].pid, ours: result[key].pid === corralPid || result[key].pid === decoy?.pid }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  if (typeof args.ledger === 'string') {
    const rel = (p) => path.relative(repoRoot, p)
    appendRun({
      ledger: args.ledger,
      criterion: `K1~K9 격리 (unread-isolated ${args.label ?? 'run'}, 재시작 ${result.restartsDone})`,
      command: `node app/scripts/l471/unread-isolated.mjs --out ${rel(out)} --work ${work} --restarts ${restarts}`,
      expected: 0,
      actual: exitCode,
      raw: rel(out),
      pass: exitCode === 0,
    })
  }
  log('done exit', exitCode, `checks ${checks.filter((c) => c.pass).length}/${checks.length}`)
  process.exit(exitCode)
}
