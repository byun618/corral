// LIFE-471 K10 네이티브 관문 드라이버 — 사용자 네이티브 corral(구현 빌드, herdr `default`)에서 **실제 OS 입력**으로 안 읽음을 본다.
// 보호·탐침·도착 확인은 LIFE-478 `native-k11.mjs` 를 그대로 따른다: 입력마다 ⓐ pid 활성화 → ⓑ 맨 앞 앱 = corral ⓒ 입력 점의 맨 위 창 =
// corral 창 ⓓ 창이 현재 Space · bounds 가 활성화 직후와 같다 → 누르기 없는 커서 이동 탐침(앱에 mousemove 도착) → 다시 보호 → 입력 →
// 도착 확인(isTrusted). 하나라도 어긋나면 입력하지 않고 멈춘다(exit 4). 재시도 상한은 입력 종류마다 2회 — 넘으면 멈춘다.
// 예외 「다른 앱이 앞」: 관문이 띄운 미끼 창(`decoy`, 글자 칸 없음)만 앞에 두고, 그 창에는 입력하지 않는다.
// 제어 소켓은 **읽기**(화면·캡처·add-repo)만 쓴다. 창 숨김 = 실제 ⌘H, 복귀 = pid 활성화, 앱 종료 = 실제 ⌘Q.
// 완료는 provider 없는 `herdr pane report-agent`(셸 pane working→idle) + 실제 claude 1회(`corral terminal create --agent claude`, 한 줄 프롬프트).
// **G7**: 화면 읽기는 관문 레포(<ROOT>/repos) 카드와 관문 pane 행만. 캡처는 비공개(/tmp/l471-private)에 두고 해시만 적는다.
//
// 사용: node native-k10.mjs <ROOT=/tmp/l471n*> <raw 폴더> <app 디렉터리> [e]
//   e = ⓔ 만(관문 레포·배치가 이미 있을 때). 원자료는 k10e.json.
//   m2 = fix1 짧은 재실행 — K10ⓓ(재기동 뒤 벨 유지) + M2(Mark Read 한 비활성 탭 herdr done 이 재기동 뒤 굵게 서되 벨은 새로 안 켜짐). 원자료 k10m2.json.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { makeRepo } from './lib.mjs'

const [root, rawd, appDir, phase = 'all'] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l471n')) throw new Error(`ROOT 는 /tmp/l471n*: ${root}`)
const PRIVATE = '/tmp/l471-private'
const ctl = path.join(root, 'ctl.sock')
const winctl = '/tmp/l471-bin/winctl'
const keypost = '/tmp/l471-bin/keypost'
const decoyBin = '/tmp/l471-bin/decoy'
const cliclick = '/opt/homebrew/bin/cliclick'
const HERDR = '/opt/homebrew/bin/herdr'
const shots = path.join(PRIVATE, 'native-shots', path.basename(rawd))
fs.mkdirSync(shots, { recursive: true, mode: 0o700 })
fs.mkdirSync(rawd, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const log = (...parts) => console.log(`[k10 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
const win = (...args) => JSON.parse(execFileSync(winctl, args.map(String), { encoding: 'utf8' }))
let appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))

const out = { at: new Date().toISOString(), steps: [], checks: [], attempts: {}, spawned: [], stopped: null }
const outFile = path.join(rawd, { e: 'k10e.json', m2: 'k10m2.json' }[phase] ?? 'k10.json')
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n')
function check(id, criterion, pass, observed) {
  out.checks.push({ id, criterion, pass, observed })
  log(pass ? '✔' : '✘', id)
  save()
}

async function evaluate(code) {
  const res = await rpc(ctl, { cmd: 'eval', code }, 20_000)
  if (!res.ok) throw new Error(`eval: ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}
async function until(fn, label, timeout = 15_000, every = 200) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timeout: ${label}`)
    await pause(every)
  }
}

// ── 화면 읽기(관문 카드·관문 pane 행만) ──
let gatePrefix = null
let gatePanes = []
const READ = `((gate, panes) => {
  const ours = (p) => p !== null && p.startsWith(gate)
  const cards = {}
  for (const el of document.querySelectorAll('[data-worktree]')) {
    const p = el.getAttribute('data-worktree')
    if (!ours(p)) continue
    const toggle = el.querySelector('[data-worktree-unread-toggle]')
    cards[p] = { bell: toggle?.getAttribute('data-worktree-unread-toggle') ?? null, title: toggle?.getAttribute('title') ?? null, status: el.querySelector('[data-worktree-status]')?.getAttribute('data-worktree-status') ?? null, selected: el.querySelector('[data-worktree-card-active="primary"]') !== null }
  }
  const rows = {}
  for (const id of panes) {
    const el = document.querySelector('[data-agent-row="' + id + '"]')
    if (el === null) { rows[id] = null; continue }
    rows[id] = { unseen: el.getAttribute('data-unseen-done') === 'true', dot: el.querySelector('[data-agent-dot]')?.getAttribute('data-agent-dot') ?? null, weight: getComputedStyle(el.querySelector('.session-row-title, .agent-full-label') ?? el).fontWeight, focused: el.getAttribute('data-focused-agent-pane') === 'true' }
  }
  const menu = document.querySelector('[data-card-menu]')
  const menuFor = menu?.getAttribute('data-card-menu') ?? null
  return {
    attention: document.documentElement.dataset.windowAttention ?? null,
    hasFocus: document.hasFocus(), visibility: document.visibilityState,
    cards, rows,
    menu: menu === null ? null : { ours: ours(menuFor), items: [...menu.querySelectorAll(':scope > [data-menu-action]')].map((item) => ({ action: item.getAttribute('data-menu-action'), label: item.querySelector('.ctx-menu-text')?.textContent ?? null, disabled: item.getAttribute('aria-disabled') === 'true' })) },
    win: { innerWidth, innerHeight },
  }
})`
const read = () => evaluate(`${READ}(${JSON.stringify(gatePrefix)}, ${JSON.stringify(gatePanes)})`)
async function shot(name) {
  const res = await rpc(ctl, { cmd: 'shot', name }, 20_000)
  if (!res.ok || !res.file || !fs.existsSync(res.file)) return null
  const dest = path.join(shots, `${name}.png`)
  fs.copyFileSync(res.file, dest)
  fs.chmodSync(dest, 0o600)
  return { private: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') }
}
const prefsFile = path.join(process.env.HOME, 'Library/Application Support/corral/ui-prefs.json')
/** 벨 칸 중 관문 경로만 — 다른 사용자 값은 개수만. */
function prefsBells() {
  const all = JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
  const list = Array.isArray(all.unreadWorktrees) ? all.unreadWorktrees : null
  return list === null ? null : { gate: list.filter((p) => p.startsWith(gatePrefix)), others: list.filter((p) => !p.startsWith(gatePrefix)).length }
}

// ── 보호 ⓐ~ⓓ · 탐침 · 도착 확인 (478 native-k11 그대로) ──
const fmt = (p) => `=${p.x},=${p.y}`
const ARM = `(() => { window.__l471 = []; if (!window.__l471armed) { window.__l471armed = true; for (const type of ['mousemove','mousedown','mouseup','click','contextmenu','keydown']) window.addEventListener(type, (e) => { if (type === 'mousemove' && window.__l471.length > 400) return; window.__l471.push({ type, button: e.button, sx: e.screenX, sy: e.screenY, key: e.key, meta: e.metaKey, trusted: e.isTrusted }) }, { capture: true, passive: true }) } return true })()`
function ourWindow() {
  const windows = win('windows', appPid).filter((w) => w.layer === 0)
  if (windows.length === 0) return null
  return windows.reduce((a, b) => (a.bounds.w * a.bounds.h >= b.bounds.w * b.bounds.h ? a : b))
}
const sameBounds = (a, b) => a !== null && b !== null && ['x', 'y', 'w', 'h'].every((key) => a.bounds[key] === b.bounds[key])
class GuardStop extends Error {}
/** 가드 지점별 로그(r3 L-10) — 통과·중단과 입력·재기동 표지를 한 시간축에. 결과 원자료 `guardLog`. */
const mark = (event, detail = {}) => {
  out.guardLog = out.guardLog ?? []
  out.guardLog.push({ t: Date.now() - t0, event, ...detail })
}
function guard(label, expected, points) {
  try {
    const result = guardChecks(label, expected, points)
    mark('guard-pass', { label, points: points.length })
    return result
  } catch (error) {
    mark('guard-stop', { label, reason: String(error?.message ?? error).slice(0, 160) })
    throw error
  }
}
function guardChecks(label, expected, points) {
  const front = win('front')
  if (front.pid !== appPid) throw new GuardStop(`GUARD ${label}: 맨 앞 앱 pid ${front.pid} ≠ corral ${appPid} — 사용자가 Mac 을 쓰는 신호일 수 있다`)
  const now = ourWindow()
  if (now === null) throw new GuardStop(`GUARD ${label}: corral 창이 현재 화면(Space)에 없다`)
  if (!sameBounds(now, expected)) throw new GuardStop(`GUARD ${label}: 창 bounds 가 바뀌었다 ${JSON.stringify(expected.bounds)} → ${JSON.stringify(now.bounds)}`)
  for (const p of points) {
    const top = win('top', p.x, p.y)
    if (top.pid !== appPid || !sameBounds(top, expected)) throw new GuardStop(`GUARD ${label}: (${p.x},${p.y}) 맨 위 창 pid ${top.pid} ≠ corral 창`)
  }
  return { front: front.pid === appPid, window: now.bounds }
}
async function activate() {
  win('activate', appPid)
  await pause(900)
  const expected = ourWindow()
  if (expected === null) throw new GuardStop('GUARD 활성화 뒤: corral 창이 현재 화면(Space)에 없다')
  const r = await read()
  return { expected, origin: { x: expected.bounds.x + (expected.bounds.w - r.win.innerWidth), y: expected.bounds.y + (expected.bounds.h - r.win.innerHeight) } }
}
async function pointIn(selector) {
  const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (p === null) throw new Error(`요소 없음: ${selector}`)
  return p
}
const events = async () => evaluate('window.__l471')

/** 재시도 상한 2회(입력 종류마다) — 실패 회차는 out.steps 에 남는다. */
function countAttempt(kind) {
  out.attempts[kind] = (out.attempts[kind] ?? 0) + 1
}
async function withRetry(kind, label, run) {
  let failures = 0
  for (;;) {
    countAttempt(kind)
    const step = { kind, label, at: Date.now() - t0 }
    out.steps.push(step)
    try {
      Object.assign(step, await run())
      step.ok = true
      save()
      return step
    } catch (error) {
      step.ok = false
      step.error = String(error?.message ?? error)
      save()
      if (error instanceof GuardStop) throw error
      failures += 1
      if (failures >= 2) throw new GuardStop(`${kind} ${label}: 재시도 상한(2) — ${step.error}`)
      log('retry', kind, label, step.error)
      await pause(800)
    }
  }
}
/** 실제 마우스 입력 — click | rclick. */
function mouse(kind, label, selector) {
  return withRetry(kind, label, async () => {
    const { expected, origin } = await activate()
    const rel = await pointIn(selector)
    const target = { x: Math.round(origin.x + rel.x), y: Math.round(origin.y + rel.y) }
    const guard1 = guard(`${label} 탐침 전`, expected, [target])
    await evaluate(ARM)
    execFileSync(cliclick, ['-e', '20', `m:${fmt(target)}`, 'w:250'], { encoding: 'utf8' })
    await pause(150)
    const probe = (await events()).find((e) => e.type === 'mousemove' && Math.abs(e.sx - target.x) <= 2 && Math.abs(e.sy - target.y) <= 2)
    if (!probe) throw new Error(`PROBE ${label}: mousemove 가 앱에 오지 않았다`)
    const guard2 = guard(`${label} 입력 직전`, expected, [target])
    await evaluate(ARM)
    execFileSync(cliclick, ['-e', '20', `${kind === 'rclick' ? 'rc' : 'c'}:${fmt(target)}`, 'w:200'], { encoding: 'utf8' })
    await pause(350)
    const want = kind === 'rclick' ? 'contextmenu' : 'click'
    const arrived = (await events()).some((e) => e.type === want && e.trusted)
    if (!arrived) throw new Error(`ARRIVAL ${label}: ${want} 가 앱에 오지 않았다`)
    return { target, guard1, guard2, probe: true, arrived }
  })
}
/** 실제 ⌘ 키 — ⌘H(4) · ⌘Q(12). 도착 확인은 keydown(⌘ 조합은 메뉴가 먹을 수 있어 결과로도 본다). */
function cmdKey(label, keycode, keyName) {
  return withRetry(`cmd-${keyName}`, label, async () => {
    const { expected, origin } = await activate()
    const center = { x: Math.round(origin.x + 400), y: Math.round(origin.y + 300) }
    const guard1 = guard(`${label} 키 전`, expected, [center])
    await evaluate(ARM)
    const guard2 = guard(`${label} 키 직전`, expected, [center])
    execFileSync(keypost, [String(keycode), 'cmd'], { encoding: 'utf8' })
    return { guard1, guard2 }
  })
}

// ── herdr default (provider 없는 보고) ──
const herdrCli = (...args) => execFileSync(HERDR, ['--session', 'default', ...args], { encoding: 'utf8', timeout: 20_000 })
const report = (paneId, state) => herdrCli('pane', 'report-agent', '--source', 'l471-native', '--agent', 'claude', '--state', state, paneId)
const herdrRpc = async (method, params) => {
  const res = await rpc(path.join(process.env.HOME, '.config/herdr/herdr.sock'), { id: `l471n-${Date.now()}`, method, params })
  if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`)
  return res.result
}
const timeline = []
out.timeline = timeline
async function complete(paneId, label) {
  report(paneId, 'working')
  await until(async () => (await read()).rows[paneId]?.dot === 'working', `working ${label}`, 8000, 150).catch(() => {})
  await pause(300)
  report(paneId, 'idle')
  await pause(1500)
  const entry = { label, paneId, at: Date.now() - t0 }
  timeline.push(entry)
  return entry
}
const state = async () => (await rpc(ctl, { cmd: 'state' }, 20_000)).state
const wsOf = async (p) => (await state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === p)?.workspace ?? null
const cardSel = (p) => `[data-worktree="${p}"] [data-worktree-card-surface]`
const rowSel = (id) => `[data-agent-row="${id}"]`
const bellSel = (p) => `[data-worktree="${p}"] [data-worktree-unread-toggle]`

let decoy = null
async function decoyFront(label) {
  if (decoy === null) {
    decoy = spawn(decoyBin, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    out.spawned.push({ pid: decoy.pid, label: 'decoy window (harmless, gate-launched)' })
    await pause(1200)
  } else process.kill(decoy.pid, 'SIGUSR1')
  await pause(900)
  const front = win('front')
  const r = await read()
  const step = { kind: 'decoy-front', label, frontIsDecoy: front.pid === decoy.pid, attention: r.attention, procedure: '관문이 띄운 미끼 창(l471 decoy, 글자 칸 없음)을 pid 활성화 — 입력 없음', at: Date.now() - t0 }
  out.steps.push(step)
  save()
  if (!step.frontIsDecoy) throw new GuardStop(`GUARD ${label}: 미끼 활성화 뒤 맨 앞 앱 pid ${front.pid} — 미끼가 아니다`)
  return step
}
async function backToCorral(label) {
  const { expected } = await activate()
  guard(`${label} 복귀`, expected, [])
  await until(async () => (await read()).attention === 'watched', `watched ${label}`, 8000).catch(() => {})
  await pause(800)
}

/**
 * ⓔ 실제 claude 완료 1회 — B 에서(보지 않는 카드). corral `terminal create` 는 설치본 herdr 에서 `unsupported_backend`
 * (atomic terminal guards 없음)라 herdr 로 B 에 새 탭(포커스 이동 없음)을 만들고 그 pane 에서 claude 를 한 줄 프롬프트로 띄운다.
 * 관문이 만든 pane 에만 입력한다(복구된 사용자 세션 입력 0). 답이 끝나면(herdr idle/done + B 벨) pane 을 닫는다.
 * `blocked`(입력 대기)가 되면 그 관문 pane 화면을 비공개에만 저장하고 멈춘다 — 답하지 않는다.
 */
async function claudeCompletion({ A, B, p4 }) {
  if ((await read()).cards[B]?.bell === 'unread') await mouse('click', 'e-bell-off', bellSel(B))
  await pause(600)
  if ((await read()).cards[A]?.selected !== true) await mouse('click', 'e-select-A', cardSel(A))
  await pause(600)
  const before = await read()
  const wsB = await wsOf(B)
  const known = new Set(wsB.tabs.flatMap((t) => t.panes.map((p) => p.paneId)))
  await herdrRpc('tab.create', { workspace_id: wsB.workspaceId, focus: false })
  const claudePane = await until(async () => (await wsOf(B))?.tabs.flatMap((t) => t.panes).find((p) => !known.has(p.paneId))?.paneId ?? null, 'B new tab pane', 20_000)
  gatePanes = [...gatePanes, claudePane]
  await pause(1500)
  // 신뢰된 폴더로 옮겨 띄운다(L471_CLAUDE_CWD — 실행 전 ~/.claude.json 에 정확한 신뢰 항목이 있는지 부르는 쪽이 읽기로 확인).
  const trusted = process.env.L471_CLAUDE_CWD
  if (trusted === undefined) throw new Error('L471_CLAUDE_CWD 가 없다 — 신뢰된 폴더를 지정한다')
  const command = `cd '${trusted}' && claude --model haiku 'Reply with exactly: ok'`
  const ran = spawnSync(HERDR, ['--session', 'default', 'pane', 'run', claudePane, command], { encoding: 'utf8', timeout: 20_000 })
  out.claude = { pane: claudePane, command: command.replace(process.env.HOME, '~'), run: { status: ran.status, stderr: ran.stderr.slice(0, 200) }, cliCreate: 'corral terminal create → unsupported_backend (설치본 herdr, k10-attempt2.json)' }
  save()
  const seen = []
  const deadline = Date.now() + 180_000
  let claudeDone = null
  while (Date.now() < deadline) {
    const r = await read()
    const pane = (await wsOf(B))?.tabs.flatMap((t) => t.panes).find((p) => p.paneId === claudePane) ?? null
    const status = pane === null ? 'gone' : `${pane.agent ?? '-'}:${pane.agentStatus}`
    if (seen.at(-1) !== status) seen.push(status)
    // B 의 에이전트가 둘이 되면 묶음이 접힐 수 있다 — 행 굵기를 보려면 실제 클릭으로 편다(한 번).
    const groupB = `[data-agent-group="${B}"][data-agent-group-expanded="false"]`
    if (out.claude.expandedB === undefined && (await evaluate(`document.querySelector(${JSON.stringify(groupB)}) !== null`))) {
      await mouse('click', 'e-expand-agents-B', groupB)
      out.claude.expandedB = true
    }
    if (status.endsWith(':blocked')) {
      const screen = spawnSync(HERDR, ['--session', 'default', 'pane', 'read', claudePane], { encoding: 'utf8', timeout: 20_000 })
      fs.writeFileSync(path.join(PRIVATE, `claude-blocked-${Date.now()}.txt`), screen.stdout, { mode: 0o600 })
      out.claude.blockedScreen = { savedPrivately: true, status: screen.status }
      break
    }
    if (pane?.agent === 'claude' && seen.some((x) => x.endsWith(':working')) && (pane.agentStatus === 'idle' || pane.agentStatus === 'done') && r.cards[B]?.bell === 'unread') {
      claudeDone = { status: pane.agentStatus, row: r.rows[claudePane] ?? null, bell: r.cards[B]?.bell, aSelected: r.cards[A]?.selected, attention: r.attention, at: Date.now() - t0 }
      break
    }
    await pause(1000)
  }
  out.claude.statuses = seen
  check('K10e-claude', 'K10ⓔ 실제 claude 한 줄 프롬프트 완료(보지 않는 카드 B, 관문 pane) → B 벨 켜짐 · 그 행 굵기', claudeDone !== null && claudeDone.row?.unseen === true, { before: before.cards[B], claudeDone, statuses: seen, p4Excluded: p4 })
  out.eShot = await shot('e-claude')
  // 관문 pane 닫기(claude 프로세스도 함께 끝난다). 대화 내용은 원자료에 싣지 않는다.
  const closed = spawnSync(HERDR, ['--session', 'default', 'pane', 'close', claudePane], { encoding: 'utf8', timeout: 20_000 })
  out.claude.closed = { status: closed.status }
}

/**
 * ⓔ 만 (코디 답 msg_e47030ec7153 — 「이미 신뢰된 폴더에서 1회」). 새 ROOT 면 관문 레포를 만들고 카드를 실제 클릭으로 연다(B 워크스페이스 + A 선택).
 * claude 는 B 워크스페이스의 새 탭 pane 에서 돌리되 cwd 는 ~/.claude.json 에 **이미 신뢰 항목이 있는** 폴더로 옮긴다(관문 경로에서 띄우면 새 항목이 생긴다).
 */
async function onlyE() {
  const reposDir = path.join(root, 'repos')
  const fresh = !fs.existsSync(path.join(reposDir, 'gate'))
  const { root: A, worktrees } = fresh
    ? makeRepo({ reposDir, name: 'gate', linked: ['gate-b'] })
    : { root: fs.realpathSync(path.join(reposDir, 'gate')), worktrees: { 'gate-b': fs.realpathSync(path.join(reposDir, 'gate-wt', 'gate-b')) } }
  const B = worktrees['gate-b']
  gatePrefix = fs.realpathSync(reposDir)
  out.paths = { A: 'gate', B: 'gate-wt/gate-b' }
  if (Object.keys((await read()).cards).length < 2) {
    const added = await rpc(ctl, { cmd: 'add-repo', root: A }, 30_000)
    if (!added.ok) throw new Error(`add-repo: ${JSON.stringify(added).slice(0, 200)}`)
  }
  await until(async () => Object.keys((await read()).cards).length === 2, 'gate cards', 60_000)
  for (const [name, p] of [['B', B], ['A', A]]) {
    if ((await wsOf(p))?.tabs?.length > 0) continue
    await mouse('click', `open-${name}`, cardSel(p))
    await until(async () => (await wsOf(p))?.tabs?.length > 0, `workspace ${name}`, 60_000)
  }
  const p4 = (await wsOf(B)).tabs[0].panes[0].paneId
  gatePanes = [p4]
  out.ids = { p4 }
  out.start = await read()
  await claudeCompletion({ A, B, p4 })
  out.final = await read()
  out.finalPrefs = prefsBells()
}

/** 접혀 있으면 실제 클릭으로 에이전트 묶음을 편다. */
async function expandAgents(name, p) {
  const group = `[data-agent-group="${p}"]`
  if (await evaluate(`document.querySelector(${JSON.stringify(`${group}[data-agent-group-expanded="false"]`)}) !== null`)) await mouse('click', `expand-agents-${name}`, group)
}

/** fix1 짧은 재실행 (수정 명세 8) — K10ⓓ + M2. 실제 OS 입력: 카드 클릭·우클릭·메뉴 클릭·벨 클릭·⌘Q. */
async function onlyM2() {
  const reposDir = path.join(root, 'repos')
  const { root: A, worktrees } = makeRepo({ reposDir, name: 'gate', linked: ['gate-b'] })
  const B = worktrees['gate-b']
  gatePrefix = fs.realpathSync(reposDir)
  out.paths = { A: 'gate', B: 'gate-wt/gate-b' }
  const added = await rpc(ctl, { cmd: 'add-repo', root: A }, 30_000)
  if (!added.ok) throw new Error(`add-repo: ${JSON.stringify(added).slice(0, 200)}`)
  await until(async () => Object.keys((await read()).cards).length === 2, 'gate cards', 60_000)
  for (const [name, p] of [['B', B], ['A', A]]) {
    await mouse('click', `open-${name}`, cardSel(p))
    await until(async () => (await wsOf(p))?.tabs?.length > 0, `workspace ${name}`, 60_000)
  }
  // A 의 비활성 탭 pane p7 — 보지 않는 중의 완료(herdr done) → A 벨.
  const wsA = await wsOf(A)
  const known = new Set(wsA.tabs.flatMap((t) => t.panes.map((p) => p.paneId)))
  await herdrRpc('tab.create', { workspace_id: wsA.workspaceId, focus: false })
  const p7 = await until(async () => (await wsOf(A))?.tabs.flatMap((t) => t.panes).find((p) => !known.has(p.paneId))?.paneId ?? null, 'A t2 pane', 20_000)
  gatePanes = [p7]
  out.ids = { p7 }
  report(p7, 'idle')
  await pause(800)
  await expandAgents('A', A)
  await complete(p7, 'm2-p7-inactive-tab')
  const findStatus = (value) => {
    if (value === null || typeof value !== 'object') return null
    if (typeof value.agent_status === 'string') return value.agent_status
    for (const child of Object.values(value)) {
      const found = findStatus(child)
      if (found !== null) return found
    }
    return null
  }
  const herdrP7 = () => findStatus(JSON.parse(herdrCli('pane', 'get', p7)))
  const afterDone = await read()
  // 실제 우클릭 → 「읽음으로 표시」 → A 벨 꺼짐(herdr 는 done 그대로).
  await mouse('rclick', 'm2-menu-A', cardSel(A))
  await until(async () => (await read()).menu !== null, 'menu', 5000)
  const menu = (await read()).menu
  await mouse('click', 'm2-mark-read-A', '[data-card-menu] [data-menu-action="toggle-unread"]')
  await pause(600)
  const afterRead = await read()
  // B 벨 — 실제 벨 클릭(K10ⓓ 재기동 유지용).
  await mouse('click', 'm2-bell-B', bellSel(B))
  await pause(600)
  const beforeQuit = { read: await read(), prefs: prefsBells(), herdrP7: herdrP7() }
  out.prep = { afterDone: { p7: afterDone.rows[p7], bellA: afterDone.cards[A]?.bell }, menu: menu?.items.map((i) => i.label), afterRead: { p7: afterRead.rows[p7], bellA: afterRead.cards[A]?.bell }, beforeQuit: { bellA: beforeQuit.read.cards[A]?.bell, bellB: beforeQuit.read.cards[B]?.bell, prefs: beforeQuit.prefs === null ? null : { gate: beforeQuit.prefs.gate.map((p) => (p === B ? 'B' : p === A ? 'A' : '?')), others: beforeQuit.prefs.others }, herdrP7: beforeQuit.herdrP7 } }
  save()
  // 실제 ⌘Q → 재기동.
  await cmdKey('m2-cmd-q', 12, 'q')
  mark('os-input-last', { label: 'm2-cmd-q — 이 단계의 마지막 OS 입력, 이후는 제어 소켓 읽기만' })
  const oldPid = appPid
  await until(() => {
    try {
      process.kill(oldPid, 0)
      return false
    } catch {
      return true
    }
  }, 'app exit after ⌘Q', 30_000)
  mark('app-exited', { oldPid })
  const relaunch = spawnSync('sh', [path.join(path.dirname(new URL(import.meta.url).pathname), '../l470/native-app.sh'), root, appDir, rawd, 'second'], { encoding: 'utf8' })
  if (relaunch.status !== 0) throw new Error(`relaunch: ${relaunch.stdout}\n${relaunch.stderr}`)
  appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
  mark('relaunched', { newPid: appPid })
  await until(async () => Object.keys((await read().catch(() => ({ cards: {} }))).cards).length === 2, 'gate cards after restart', 60_000)
  mark('series-start', { input: 'none — read only' })
  // 재기동 뒤 10초 시간축 — A 벨이 한 번이라도 켜지는지, p7 행이 굵게 서는지.
  const series = []
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    const r = await read()
    series.push({ t: Date.now() - startedAt, bellA: r.cards[A]?.bell ?? null, bellB: r.cards[B]?.bell ?? null, p7: r.rows[p7] ?? null })
    await pause(500)
  }
  if (series.at(-1)?.p7 === null) {
    await expandAgents('A-after', A)
    await pause(600)
    const r = await read()
    series.push({ t: Date.now() - startedAt, bellA: r.cards[A]?.bell ?? null, bellB: r.cards[B]?.bell ?? null, p7: r.rows[p7] ?? null, afterExpand: true })
  }
  const last = series.at(-1)
  mark('series-end', { samples: series.length })
  out.series = series
  out.herdrP7After = herdrP7()
  check('K10d-restart-fix1', 'K10ⓓ(fix1) 실제 ⌘Q → 재기동 → B 벨 유지 · prefs 그대로', last?.bellB === 'unread' && prefsBells()?.gate.length === 1 && prefsBells()?.gate[0] === B, { oldPid, newPid: appPid, last: { bellB: last?.bellB }, prefsGate: prefsBells()?.gate.length })
  check('M2-native', 'M2(fix1) 실제 우클릭 Mark Read 한 비활성 탭 herdr done(p7) → 재기동 뒤 행은 굵게, A 벨은 10초 동안 한 번도 안 켜짐', out.prep.afterRead.bellA === 'read' && out.prep.beforeQuit.herdrP7 === 'done' && out.herdrP7After === 'done' && last?.p7?.unseen === true && series.every((row) => row.bellA === 'read'), { prep: out.prep, herdrP7After: out.herdrP7After, last, bellAValues: [...new Set(series.map((row) => row.bellA))] })
  out.shot = await shot('m2-after-restart')
  out.final = await read()
  out.finalPrefs = prefsBells()
}

async function main() {
  // ── 준비: 관문 레포(A = 메인, B = linked) ──
  // 다시 돌려도 되게(1차 시도가 행 대기에서 멈췄다) — 관문 레포·카드·배치가 이미 있으면 그대로 쓴다.
  const reposDir = path.join(root, 'repos')
  const reuse = fs.existsSync(path.join(reposDir, 'gate'))
  const { root: A, worktrees } = reuse
    ? { root: fs.realpathSync(path.join(reposDir, 'gate')), worktrees: { 'gate-b': fs.realpathSync(path.join(reposDir, 'gate-wt', 'gate-b')) } }
    : makeRepo({ reposDir, name: 'gate', linked: ['gate-b'] })
  const B = worktrees['gate-b']
  gatePrefix = fs.realpathSync(reposDir)
  out.paths = { A: 'gate', B: 'gate-wt/gate-b' }
  out.reuse = reuse
  out.frontAtStart = win('front').pid === appPid ? 'corral' : '(다른 앱)'
  if (Object.keys((await read()).cards).length < 2) {
    const added = await rpc(ctl, { cmd: 'add-repo', root: A }, 30_000)
    if (!added.ok) throw new Error(`add-repo: ${JSON.stringify(added).slice(0, 200)}`)
  }
  await until(async () => Object.keys((await read()).cards).length === 2, 'gate cards', 60_000)

  // 두 카드를 실제 클릭으로 열어 workspace 를 만든다.
  for (const [name, p] of [['B', B], ['A', A]]) {
    if ((await wsOf(p))?.tabs?.length > 0) continue
    await mouse('click', `open-${name}`, cardSel(p))
    await until(async () => (await wsOf(p))?.tabs?.length > 0, `workspace ${name}`, 60_000)
  }
  // A: t1 = p1 | p2 (split, 포커스 이동 없음) · t2 = p3. B: p4.
  const wsA = await wsOf(A)
  if (wsA.tabs[0].panes.length < 2) await herdrRpc('pane.split', { target_pane_id: wsA.tabs[0].panes[0].paneId, direction: 'right', focus: false })
  if (wsA.tabs.length < 2) await herdrRpc('tab.create', { workspace_id: wsA.workspaceId, focus: false })
  await until(async () => {
    const ws = await wsOf(A)
    return ws?.tabs.length === 2 && ws.tabs[0].panes.length === 2
  }, 'A layout', 30_000)
  const a = await wsOf(A)
  const b = await wsOf(B)
  const [p1, p2] = a.tabs[0].panes.map((p) => p.paneId)
  const p3 = a.tabs[1].panes[0].paneId
  const p4 = b.tabs[0].panes[0].paneId
  gatePanes = [p1, p2, p3, p4]
  out.ids = { p1, p2, p3, p4 }
  for (const id of gatePanes) report(id, 'idle')
  // 활성 = A · 탭 t1(그 탭으로 돌아가게 카드 클릭) · p1 선택.
  await mouse('click', 'select-A', cardSel(A))
  // 에이전트 묶음이 접혀 있으면(사용자 prefs 기본) 실제 클릭으로 펼친다 — 행이 있어야 굵기·선택을 본다(1차 시도가 여기서 멈췄다).
  for (const [name, p] of [['A', A], ['B', B]]) {
    const group = `[data-agent-group="${p}"]`
    await until(async () => evaluate(`document.querySelector(${JSON.stringify(group)}) !== null || document.querySelector(${JSON.stringify(`[data-worktree="${p}"] [data-agent-row]`)}) !== null`), `agent list ${name}`, 15_000)
    if (await evaluate(`document.querySelector(${JSON.stringify(`${group}[data-agent-group-expanded="false"]`)}) !== null`)) await mouse('click', `expand-agents-${name}`, group)
  }
  await until(async () => (await read()).rows[p1] !== null, 'row p1', 30_000)
  await mouse('click', 'select-p1', rowSel(p1))
  await pause(800)
  out.start = await read()
  out.startShot = await shot('00-start')

  // ── ⓐ① ⌘H 숨김 중 선택 pane 완료 → 행 굵기 + 벨 → 복귀로 자동 확인 ──
  await cmdKey('a1-cmd-h', 4, 'h')
  await until(async () => (await read()).attention === 'away', 'away after ⌘H', 8000).catch(() => {})
  const hiddenAttention = (await read()).attention
  const hiddenFront = win('front').pid === appPid
  let c = await complete(p1, 'a1-hidden-selected')
  let s = await read()
  const hiddenShot = await shot('a1-hidden')
  await backToCorral('a1')
  let s2 = await read()
  check('K10a1-cmd-h', 'K10ⓐ① 실제 ⌘H 숨김 중 선택 pane 완료 → 행 굵기 + 카드 벨 → 창 복귀(pid 활성화)로 자동 확인 → 벨 꺼짐', hiddenAttention === 'away' && s.rows[p1]?.unseen === true && s.cards[A]?.bell === 'unread' && s2.rows[p1]?.unseen === false && s2.cards[A]?.bell === 'read', { hiddenAttention, hiddenFront, hidden: { row: s.rows[p1], bell: s.cards[A]?.bell }, back: { row: s2.rows[p1], bell: s2.cards[A]?.bell, attention: s2.attention }, hiddenShot, at: c.at })

  // ── ⓐ② 다른 앱(관문 미끼) 앞 ──
  await decoyFront('a2-decoy')
  const awayAttention = (await read()).attention
  c = await complete(p1, 'a2-other-app-selected')
  s = await read()
  const otherShot = await shot('a2-other-app')
  await backToCorral('a2')
  s2 = await read()
  check('K10a2-other-app', 'K10ⓐ② 다른 앱(관문 미끼 창)이 앞인 채 선택 pane 완료 → 행 굵기 + 벨 → 포커스 복귀로 자동 확인', awayAttention === 'away' && s.rows[p1]?.unseen === true && s.cards[A]?.bell === 'unread' && s2.rows[p1]?.unseen === false && s2.cards[A]?.bell === 'read', { awayAttention, away: { row: s.rows[p1], bell: s.cards[A]?.bell }, back: { row: s2.rows[p1], bell: s2.cards[A]?.bell, attention: s2.attention }, otherShot, at: c.at })

  // ── ⓑ 같은 탭 split pane 완료(보는 중) → 안 읽음 + 벨 → 실제 클릭으로 그 pane 선택 = 확인 ──
  c = await complete(p2, 'b-split-sibling')
  s = await read()
  const splitShot = await shot('b-split')
  await mouse('click', 'b-select-p2', rowSel(p2))
  await pause(800)
  s2 = await read()
  check('K10b-split', 'K10ⓑ 보는 중 같은 탭 split pane 완료 → 그 행만 굵기 + 벨 · 실제 클릭으로 선택 → 확인·벨 꺼짐', s.rows[p2]?.unseen === true && s.rows[p1]?.unseen === false && s.cards[A]?.bell === 'unread' && s2.rows[p2]?.unseen === false && s2.cards[A]?.bell === 'read', { before: { p1: s.rows[p1], p2: s.rows[p2], bell: s.cards[A]?.bell }, after: { p2: s2.rows[p2], bell: s2.cards[A]?.bell }, splitShot })
  await mouse('click', 'b-reselect-p1', rowSel(p1))
  await pause(500)

  // ── ⓒ 실제 우클릭 Mark Unread → Mark Read · 벨 클릭 ──
  await mouse('rclick', 'c-menu-unread', cardSel(A))
  await until(async () => (await read()).menu !== null, 'menu', 5000)
  const menu1 = (await read()).menu
  await mouse('click', 'c-mark-unread', '[data-card-menu] [data-menu-action="toggle-unread"]')
  await pause(600)
  s = await read()
  await mouse('rclick', 'c-menu-read', cardSel(A))
  await until(async () => (await read()).menu !== null, 'menu', 5000)
  const menu2 = (await read()).menu
  await mouse('click', 'c-mark-read', '[data-card-menu] [data-menu-action="toggle-unread"]')
  await pause(600)
  s2 = await read()
  const labelAfterPin = (m) => {
    const labels = m?.items.map((i) => i.label) ?? []
    return labels[labels.indexOf('고정') + 1] ?? null
  }
  check('K10c-menu', 'K10ⓒ 실제 우클릭 메뉴: 벨 꺼짐 → Pin 아래 「안 읽음으로 표시」 → 누르면 벨 켜짐(보는 카드여도 유지) → 「읽음으로 표시」 → 꺼짐', menu1?.ours === true && labelAfterPin(menu1) === '안 읽음으로 표시' && s.cards[A]?.bell === 'unread' && labelAfterPin(menu2) === '읽음으로 표시' && s2.cards[A]?.bell === 'read', { menu1: menu1?.items.map((i) => i.label), afterUnread: s.cards[A], menu2: menu2?.items.map((i) => i.label), afterRead: s2.cards[A] })
  // 벨 클릭(B — 보이지 않는 카드): 켜짐 → 끔 → 다시 켜짐(재시작 유지 확인용으로 켠 채 둔다).
  const bellRuns = []
  for (const label of ['c-bell-on', 'c-bell-off', 'c-bell-on-again']) {
    const before = (await read()).cards[B]?.bell
    await mouse('click', label, bellSel(B))
    await pause(600)
    const after = await read()
    bellRuns.push({ label, before, after: after.cards[B]?.bell, selectedB: after.cards[B]?.selected, selectedA: after.cards[A]?.selected })
  }
  const prefsOn = prefsBells()
  check('K10c-bell', 'K10ⓒ 실제 벨 클릭 = 토글(켜짐→꺼짐→켜짐), 카드 활성화 없음(A 그대로 선택) · prefs unreadWorktrees 에 B', bellRuns.map((r) => r.after).join(',') === 'unread,read,unread' && bellRuns.every((r) => r.selectedA === true && r.selectedB === false) && prefsOn?.gate.length === 1 && prefsOn.gate[0] === B, { bellRuns, prefs: prefsOn === null ? null : { gate: prefsOn.gate.map((p) => (p === B ? 'B' : p === A ? 'A' : '?')), others: prefsOn.others } })
  out.cShot = await shot('c-bell')

  // ── ⓓ 실제 ⌘Q → 재기동 → 벨 유지 ──
  await cmdKey('d-cmd-q', 12, 'q')
  const oldPid = appPid
  await until(() => {
    try {
      process.kill(oldPid, 0)
      return false
    } catch {
      return true
    }
  }, 'app exit after ⌘Q', 30_000)
  const relaunch = spawnSync('sh', [path.join(path.dirname(new URL(import.meta.url).pathname), '../l470/native-app.sh'), root, appDir, rawd, 'second'], { encoding: 'utf8' })
  if (relaunch.status !== 0) throw new Error(`relaunch: ${relaunch.stdout}\n${relaunch.stderr}`)
  appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
  await until(async () => Object.keys((await read().catch(() => ({ cards: {} }))).cards).length === 2, 'gate cards after restart', 60_000)
  await pause(1500)
  s = await read()
  check('K10d-restart', 'K10ⓓ 실제 ⌘Q 로 앱 종료 → 재기동 → 벨 유지(B 켜짐 · A 꺼짐)', s.cards[B]?.bell === 'unread' && s.cards[A]?.bell === 'read', { oldPid, newPid: appPid, cards: { A: s.cards[A], B: s.cards[B] }, prefs: prefsBells()?.gate.length })
  out.dShot = await shot('d-restart')

  await claudeCompletion({ A, B, p4 })
  out.final = await read()
  out.finalPrefs = prefsBells()
}

;(phase === 'e' ? onlyE() : phase === 'm2' ? onlyM2() : main())
  .then(() => {
    out.ok = out.checks.every((c) => c.pass)
    out.attempts.total = Object.values(out.attempts).reduce((a, b) => a + b, 0)
  })
  .catch((error) => {
    out.stopped = String(error?.message ?? error)
    out.guardStop = error instanceof GuardStop
    out.ok = false
    console.error(String(error?.stack ?? error))
  })
  .finally(() => {
    if (decoy !== null) decoy.kill('SIGTERM')
    save()
    log('wrote', outFile, 'ok', out.ok)
    process.exit(out.ok ? 0 : out.guardStop ? 4 : 1)
  })
