// LIFE-470 K11 네이티브 관문 드라이버 — LIFE-469 `native-k8.mjs` 의 보호·탐침·도착 확인을 그대로 옮겼다.
// 제어 소켓으로 **읽기**(화면 상태·캡처)만 하고, 입력은 **실제 OS 입력(cliclick)** 으로 한다. CDP 없음(디버깅 포트 없이 띄운다).
// 입력마다 ⓐ pid 활성화 → ⓑ 맨 앞 앱 = corral ⓒ 입력 점의 맨 위 창 = corral 창 ⓓ 창이 현재 Space · bounds 가 직전 읽기와 같다 →
// 누르기 없는 커서 이동 탐침(앱에 mousemove 도착) → 다시 보호 → 입력. 하나라도 어긋나면 입력하지 않고 멈춘다(exit 1, stopped 기록).
// 결과는 <raw>/<단계>-<꼬리표>.json. 상태를 바꾸는 것은 옵션 값·표시 순서뿐이다(git·herdr 상태를 만들거나 지우지 않는다).
// 키 입력에는 커서 탐침이 없다 — 맨 앞 앱·창 점을 다시 확인한 뒤 보내고, 앱이 받은 trusted keydown 으로 도착을 본다.
// **원자료 익명화(수정 라운드 1 R1-01)**: 사용자 레포·워크트리 path·브랜치 이름은 `anon.mjs` 키로, ui-prefs 는 옵션 6칸(관문이 바꾸는
// 열거값)과 수동 순서 칸(익명 키)만 적는다. 캡처(사용자 실제 화면)는 raw 에 두지 않고 비공개 위치에 두며 해시만 적는다.
// 자기점검: `node native-k11.mjs --self-check` — 드래그 판정이 「순서는 맞는데 Manual 이 아님」 을 실패로 세는지(R1-09).
//
// 사용: node native-k11.mjs <ROOT> <raw 폴더> <단계> <꼬리표> [인자]
//   state <꼬리표>                 화면 상태 + ui-prefs 읽기 + 캡처
//   hover <꼬리표> <selector>      그 요소 가운데로 커서만 옮긴다(서브메뉴 hover 열기) — 누르지 않는다
//   click <꼬리표> <selector>      그 요소 가운데를 OS 클릭
//   key <꼬리표> cmd+j|esc         OS 키 입력 (창 가운데를 보호 점으로)
//   drag-all <꼬리표>              Group None 의 「전체」 묶음에서 화면에 보이는 세 번째 카드를 첫 카드 윗변으로 OS 드래그

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { anonymizeValue, loadMap, PRIVATE_DIR, registerRead, saveMap } from './anon.mjs'

/** 드래그 단계 판정 — 기대 순서 **그리고** Sort by = manual(K11ⓒ). 하나라도 아니면 던진다(R1-09: 예전에는 순서만 봤다). */
export function dragVerdict(input) {
  if (!input.orderAsExpected) throw new Error(`ORDER: 기대 ${JSON.stringify(input.expected)} ≠ 관측 ${JSON.stringify(input.observed)}`)
  if (!input.sortManual) throw new Error(`SORT: 끌어 놓은 뒤 sidebarSortBy 가 manual 이 아니다 (${JSON.stringify(input.sortBy)})`)
}

if (process.argv[2] === '--self-check') {
  const cases = [
    { name: 'order+manual', input: { orderAsExpected: true, sortManual: true }, shouldThrow: false },
    { name: 'order-only (Manual 전환 실패)', input: { orderAsExpected: true, sortManual: false, sortBy: 'recent' }, shouldThrow: true },
    { name: 'manual-only (순서 틀림)', input: { orderAsExpected: false, sortManual: true }, shouldThrow: true },
  ]
  const results = cases.map((item) => {
    let threw = false
    try {
      dragVerdict(item.input)
    } catch {
      threw = true
    }
    return { name: item.name, threw, pass: threw === item.shouldThrow }
  })
  console.log(JSON.stringify({ selfCheck: results.every((r) => r.pass) ? 'pass' : 'fail', results }))
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

const [root, rawd, step, tag, arg] = process.argv.slice(2)
const ctl = path.join(root, 'ctl.sock')
const winctl = process.env.L470_WINCTL ?? '/tmp/l470nbin/winctl'
const cliclick = '/opt/homebrew/bin/cliclick'
const prefsFile = path.join(process.env.HOME, 'Library/Application Support/corral/ui-prefs.json')
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
/** 캡처는 비공개 위치에만(사용자 실제 화면 — R1-01). raw 에는 해시만. */
const shots = path.join(PRIVATE_DIR, 'native-shots', path.basename(rawd))
fs.mkdirSync(shots, { recursive: true, mode: 0o700 })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log('[k11]', ...parts)
const win = (...rest) => JSON.parse(execFileSync(winctl, rest.map(String), { encoding: 'utf8' }))

async function evaluate(code) {
  const res = await rpc(ctl, { cmd: 'eval', code }, 20_000)
  if (!res.ok) throw new Error(`eval: ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}

/** 화면 읽기 — 상태를 바꾸지 않는다. */
const READ = `(() => {
  const list = document.querySelector('[data-repo-list]')
  if (!list) return null
  const all = list.querySelector(':scope > [data-reorder-all]')
  const menu = document.querySelector('[data-sidebar-options-menu]')
  const checked = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.getAttribute('data-options-radio') ?? el.getAttribute('data-group-by') ?? el.getAttribute('data-options-filter'))
  return {
    title: document.querySelector('[data-sidebar-section-title]')?.textContent ?? null,
    badge: document.querySelector('[data-sidebar-options-badge]')?.textContent ?? null,
    menuOpen: menu !== null,
    submenu: document.querySelector('[data-options-submenu]')?.getAttribute('data-options-submenu') ?? null,
    menuChecked: menu === null ? null : checked('[data-options-radio], [data-group-by], [data-options-filter]'),
    menuSections: menu === null ? null : [...menu.querySelectorAll('.options-menu-section-label, [data-submenu-trigger]')].map((el) => el.getAttribute('data-submenu-trigger') ?? el.textContent),
    projectsSection: document.querySelector('[data-submenu-trigger="projects"]') !== null,
    paletteOpen: document.querySelector('[data-command-palette]') !== null,
    search: (() => { const b = document.querySelector('[data-sidebar-search]'); return b === null ? null : { tag: b.tagName, text: b.querySelector('.sidebar-search-label')?.textContent ?? null } })(),
    groups: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({ root: group.getAttribute('data-repo'), worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')) })),
    all: all === null ? null : [...all.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
    allCount: all?.querySelector('[data-all-group-count]')?.textContent ?? null,
    branches: Object.fromEntries([...list.querySelectorAll('[data-worktree]')].map((row) => [row.getAttribute('data-worktree'), row.querySelector('[data-worktree-meta-branch], .worktree-branch')?.textContent ?? null])),
    emptyFiltered: list.querySelector('[data-empty-filtered]') !== null,
    win: { innerWidth, innerHeight, screenX, screenY, dpr: devicePixelRatio },
  }
})()`

async function read() {
  const value = await evaluate(READ)
  if (value === null) throw new Error('사이드바가 아직 없다')
  return value
}
/** 옵션 6칸(관문이 바꾼 열거값 — 판정 근거) + 수동 순서 칸(경로는 저장 때 익명 키로). 그 밖의 사용자 ui-prefs 칸은 읽지 않는다. */
const VIEW_FIELDS = ['sidebarGroupBy', 'sidebarSortBy', 'sidebarProjectOrderBy', 'sidebarRepoFilter', 'sidebarHideDefaultBranch', 'sidebarHideDetachedHead']
const prefs = () => {
  const all = JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
  return Object.fromEntries(Object.entries(all).filter(([key]) => VIEW_FIELDS.includes(key) || key.startsWith('manual')))
}
async function shot(name) {
  const res = await rpc(ctl, { cmd: 'shot', name }, 20_000)
  if (!res.ok || !res.file || !fs.existsSync(res.file)) return null
  const dest = path.join(shots, `${name}.png`)
  fs.copyFileSync(res.file, dest)
  return { private: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') }
}

const toScreen = (origin, p) => ({ x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y) })
const fmt = (p) => `=${p.x},=${p.y}`

/** 수동 기록기(passive capture) — OS 입력이 이 창에 왔는지 본다. 한 번만 걸고 배열만 비운다. */
const ARM_RECORDER = `(() => { window.__l470 = []; if (!window.__l470armed) { window.__l470armed = true; for (const type of ['mousemove','mousedown','mouseup','click','keydown']) window.addEventListener(type, (e) => { if (type === 'mousemove' && window.__l470.length > 400) return; window.__l470.push({ type, x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, key: e.key, meta: e.metaKey, trusted: e.isTrusted, t: Date.now() }) }, { capture: true, passive: true }) } return true })()`

function ourWindow() {
  const windows = win('windows', appPid).filter((w) => w.layer === 0)
  if (windows.length === 0) return null
  return windows.reduce((a, b) => (a.bounds.w * a.bounds.h >= b.bounds.w * b.bounds.h ? a : b))
}
const sameBounds = (a, b) => a !== null && b !== null && ['x', 'y', 'w', 'h'].every((key) => a.bounds[key] === b.bounds[key])

/** 입력 보호 ⓑ·ⓒ·ⓓ — 하나라도 어긋나면 던진다(입력하지 않는다). */
function guard(label, expected, points) {
  const front = win('front')
  if (front.pid !== appPid) throw new Error(`GUARD ${label}: 맨 앞 앱 ${JSON.stringify(front)} ≠ corral ${appPid}`)
  const now = ourWindow()
  if (now === null) throw new Error(`GUARD ${label}: corral 창이 현재 화면(Space)에 없다`)
  if (!sameBounds(now, expected)) throw new Error(`GUARD ${label}: 창 bounds 가 바뀌었다 ${JSON.stringify(expected.bounds)} → ${JSON.stringify(now.bounds)}`)
  const tops = points.map((p) => ({ p, top: win('top', p.x, p.y) }))
  for (const { p, top } of tops) if (top.pid !== appPid || !sameBounds(top, expected)) throw new Error(`GUARD ${label}: (${p.x},${p.y}) 맨 위 창 ${JSON.stringify(top)} ≠ corral 창`)
  return { front, window: now.bounds, tops }
}

/** 누르기 없는 커서 이동 탐침 — 앱에 그 화면 좌표의 mousemove 가 도착해야 통과. */
async function probeMove(p, label) {
  await evaluate(ARM_RECORDER)
  execFileSync(cliclick, ['-e', '20', `m:${fmt(p)}`, 'w:250'], { encoding: 'utf8' })
  await pause(150)
  const events = await evaluate('window.__l470')
  const hit = events.find((e) => e.type === 'mousemove' && Math.abs(e.sx - p.x) <= 2 && Math.abs(e.sy - p.y) <= 2)
  if (!hit) throw new Error(`PROBE ${label}: (${p.x},${p.y}) 의 mousemove 가 앱에 오지 않았다 — 받은 것 ${JSON.stringify(events.slice(-3))}`)
  return hit
}

/** ⓐ 활성화 + 창 원점(창 안 좌표 → 화면 좌표). */
async function activate(out) {
  out.activate = win('activate', appPid)
  await pause(900)
  const expected = ourWindow()
  if (expected === null) throw new Error('GUARD 활성화 뒤: corral 창이 현재 화면(Space)에 없다')
  out.window = expected.bounds
  const before = await read()
  const origin = { x: expected.bounds.x + (expected.bounds.w - before.win.innerWidth), y: expected.bounds.y + (expected.bounds.h - before.win.innerHeight) }
  out.origin = { ...origin, pageScreenX: before.win.screenX, pageScreenY: before.win.screenY }
  out.before = before
  return { expected, origin }
}

async function centerOf(selector) {
  const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (p === null) throw new Error(`요소 없음: ${selector}`)
  return p
}

async function main() {
  const out = { step, tag, arg: arg ?? null, at: new Date().toISOString(), appPid }
  const file = path.join(rawd, `${step}-${tag}.json`)
  const save = () => {
    const map = loadMap()
    for (const read of [out.before, out.after, out.read]) if (read) registerRead({ map, read })
    const safe = anonymizeValue({ value: out, map })
    saveMap(map)
    fs.writeFileSync(file, JSON.stringify(safe, null, 2) + '\n')
  }
  try {
    switch (step) {
      case 'state': {
        for (let i = 0; i < 60; i++) {
          const geo = await read().catch(() => null)
          if (geo && (geo.all !== null || geo.groups.some((group) => group.worktrees.length > 0))) break
          await pause(500)
        }
        await pause(800)
        out.read = await read()
        out.prefs = prefs()
        out.shot = await shot(`state-${tag}`)
        break
      }
      case 'hover':
      case 'click': {
        const { expected, origin } = await activate(out)
        const target = toScreen(origin, await centerOf(arg))
        out.point = target
        out.guard1 = guard('탐침 전', expected, [target])
        out.probe = await probeMove(target, step === 'hover' ? 'hover 점' : '누르는 점')
        if (step === 'click') {
          out.guard2 = guard('누르기 직전', expected, [target])
          await evaluate(ARM_RECORDER)
          execFileSync(cliclick, ['-e', '20', `c:${fmt(target)}`, 'w:200'], { encoding: 'utf8' })
          await pause(300)
          const events = await evaluate('window.__l470')
          out.events = events.filter((e) => e.type !== 'mousemove')
          out.arrived = out.events.some((e) => e.type === 'mousedown' && e.trusted) && out.events.some((e) => e.type === 'mouseup' && e.trusted)
          if (!out.arrived) throw new Error(`ARRIVAL: 클릭이 앱에 오지 않았다 ${JSON.stringify(out.events)}`)
        }
        await pause(700)
        out.after = await read()
        out.prefs = prefs()
        out.shot = await shot(`${step}-${tag}`)
        break
      }
      case 'key': {
        const { expected, origin } = await activate(out)
        // 키는 맨 앞 앱의 key 창으로 간다 — 보호 점은 창 안 사이드바 위쪽 빈 곳(검색 줄 오른쪽 끝 바깥이 아닌 창 가운데).
        const center = toScreen(origin, { x: out.before.win.innerWidth / 2, y: out.before.win.innerHeight / 2 })
        out.guard1 = guard('키 전', expected, [center])
        await evaluate(ARM_RECORDER)
        const spec = arg === 'cmd+j' ? ['kd:cmd', 't:j', 'ku:cmd'] : arg === 'esc' ? ['kp:esc'] : null
        if (spec === null) throw new Error(`키 모름: ${arg}`)
        out.guard2 = guard('키 직전', expected, [center])
        execFileSync(cliclick, ['-e', '20', ...spec, 'w:200'], { encoding: 'utf8' })
        await pause(300)
        const events = await evaluate('window.__l470')
        out.events = events.filter((e) => e.type === 'keydown')
        out.arrived = out.events.some((e) => e.trusted && (arg === 'esc' ? e.key === 'Escape' : e.meta && e.key.toLowerCase() === 'j'))
        if (!out.arrived) throw new Error(`ARRIVAL: 키가 앱에 오지 않았다 ${JSON.stringify(out.events)}`)
        await pause(700)
        out.after = await read()
        out.prefs = prefs()
        out.shot = await shot(`key-${tag}`)
        break
      }
      case 'drag-all': {
        const { expected, origin } = await activate(out)
        const pts = await evaluate(`(() => {
          const all = document.querySelector('[data-repo-list] > [data-reorder-all]')
          if (!all) return null
          const list = document.querySelector('[data-repo-list]').getBoundingClientRect()
          const cards = [...all.querySelectorAll('[data-reorder-card]')].filter((c) => { const r = c.getBoundingClientRect(); return r.top >= list.top && r.bottom <= list.bottom })
          const moving = cards[2] ?? cards[cards.length - 1]
          const first = cards[0].getBoundingClientRect()
          const center = (el, fx, fy) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy } }
          return { from: center(moving.querySelector('.worktree-name') ?? moving, 0.3, 0.5), to: { x: first.left + first.width * 0.3, y: first.top + 4 }, moving: moving.getAttribute('data-reorder-card') }
        })()`)
        if (pts === null) throw new Error('「전체」 묶음이 없다 — Group None 이 아니다')
        const from = toScreen(origin, pts.from)
        const to = toScreen(origin, pts.to)
        out.points = { client: pts, screen: { from, to } }
        out.guard1 = guard('탐침 전', expected, [from, to])
        out.probeTo = await probeMove(to, '놓는 점')
        out.probeFrom = await probeMove(from, '잡는 점')
        out.guard2 = guard('누르기 직전', expected, [from, to])
        await evaluate(ARM_RECORDER)
        const moves = []
        for (let index = 1; index <= 10; index++) moves.push(`dm:${fmt({ x: Math.round(from.x + ((to.x - from.x) * index) / 10), y: Math.round(from.y + ((to.y - from.y) * index) / 10) })}`, 'w:30')
        out.cliclick = ['-e', '20', `m:${fmt(from)}`, 'w:150', `dd:${fmt(from)}`, 'w:120', ...moves, 'w:200', `du:${fmt(to)}`, 'w:300']
        execFileSync(cliclick, out.cliclick, { encoding: 'utf8' })
        await pause(500)
        const events = await evaluate('window.__l470')
        out.events = { down: events.filter((e) => e.type === 'mousedown'), up: events.filter((e) => e.type === 'mouseup'), moves: events.filter((e) => e.type === 'mousemove').length }
        out.arrived = out.events.down.length > 0 && out.events.up.length > 0
        if (!out.arrived) throw new Error(`ARRIVAL: 누르기·놓기가 앱에 오지 않았다 ${JSON.stringify(out.events)}`)
        await pause(800)
        out.after = await read()
        out.prefs = prefs()
        // 기대: 끈 카드가 첫 자리로, 나머지 상대 순서는 그대로(화면에 보이던 순서 기준) · Sort 가 manual 로 바뀐다(198 `useWorktreeDrag` 의 setSortBy).
        const beforeAll = out.before.all ?? []
        out.expected = [pts.moving, ...beforeAll.filter((key) => key !== pts.moving)]
        out.orderAsExpected = JSON.stringify(out.expected) === JSON.stringify(out.after.all)
        out.sortManual = out.prefs.sidebarSortBy === 'manual'
        out.shot = await shot(`drag-all-${tag}`)
        dragVerdict({ orderAsExpected: out.orderAsExpected, sortManual: out.sortManual, sortBy: out.prefs.sidebarSortBy, expected: out.expected, observed: out.after.all })
        break
      }
      default:
        throw new Error(`단계 모름: ${step}`)
    }
  } catch (error) {
    out.stopped = String(error?.message ?? error)
    save()
    throw error
  }
  save()
  log('wrote', file)
}

main().catch((error) => {
  console.error(String(error?.stack ?? error))
  process.exit(1)
})
