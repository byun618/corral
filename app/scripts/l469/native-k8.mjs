// LIFE-469 K8 네이티브 관문 드라이버 — 제어 소켓으로 **읽기**(순서·창 기하·캡처)만 하고, 끌기는 **실제 OS 입력(cliclick)** 으로 한다.
// CDP 를 쓰지 않는다(디버깅 포트 없이 띄운다). 끌기마다 pid 활성화 → 맨 앞 앱·두 점의 맨 위 창·창 bounds 확인(guard) →
// 누르기 없는 커서 이동 탐침(앱에 mousemove 도착) → 다시 guard → 누르기. 하나라도 어긋나면 입력하지 않고 멈춘다(킥오프 격리 5,
// 1차 회차 사건 뒤 코디네이터 재시도 조건 2~4). 결과는 <raw>/<단계>-try<L469_ATTEMPT>.json.
//
// 사용: node native-k8.mjs <ROOT> <raw 폴더> <단계> [인자]
//   order <꼬리표>          순서·창 기하 읽기 + 캡처 → <raw>/order-<꼬리표>.json
//   fixture <레포 경로>      fixture 레포 등록(add-repo) + 그려질 때까지 대기
//   drag-repo <root>        그 레포 헤더를 맨 위 경계로 OS 드래그
//   drag-card <repoRoot>    그 레포의 화면에 보이는 세 번째 연결 카드를 맨 위(주 체크아웃 바로 아래)로 OS 드래그

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [root, rawd, step, arg] = process.argv.slice(2)
const ctl = path.join(root, 'ctl.sock')
const winctl = process.env.L469_WINCTL ?? '/tmp/l469nbin/winctl'
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
const shots = path.join(rawd, 'shots')
fs.mkdirSync(shots, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log('[k8]', ...parts)
const win = (...rest) => JSON.parse(execFileSync(winctl, rest.map(String), { encoding: 'utf8' }))

async function evaluate(code) {
  const res = await rpc(ctl, { cmd: 'eval', code }, 20_000)
  if (!res.ok) throw new Error(`eval: ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}

/** 화면 읽기 — 레포·카드 순서와 창 안 기하. 상태를 바꾸지 않는다. */
const READ = `(() => {
  const list = document.querySelector('[data-repo-list]')
  if (!list) return null
  return {
    repos: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({
      root: group.getAttribute('data-repo'),
      collapsed: group.querySelector('[data-repo-caret] .is-collapsed') !== null,
      worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
      selected: [...group.querySelectorAll('[data-worktree-card-active="primary"]')].map((el) => el.closest('[data-worktree]').getAttribute('data-worktree')),
    })),
    reordering: document.querySelector('.sidebar.is-reordering') !== null,
    indicator: document.querySelector('[data-reorder-indicator]') !== null,
    win: { innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, dpr: devicePixelRatio },
    list: (() => { const r = list.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scrollTop: list.scrollTop } })(),
  }
})()`

async function read() {
  const value = await evaluate(READ)
  if (value === null) throw new Error('사이드바가 아직 없다')
  return value
}

async function shot(name) {
  const res = await rpc(ctl, { cmd: 'shot', name }, 20_000)
  if (res.ok && res.file && fs.existsSync(res.file)) fs.copyFileSync(res.file, path.join(shots, `${name}.png`))
  return res.ok ? path.join('shots', `${name}.png`) : null
}

/** 드래그 뒤 기대 순서 — 레포: 끈 레포가 맨 위. 카드: 끈 카드가 연결 워크트리 맨 위(주 체크아웃 바로 아래). 나머지는 원래 상대 순서. */
function expectedOrder({ step, before, moving, key }) {
  if (step === 'drag-repo') {
    const roots = before.repos.map((repo) => repo.root)
    return [moving, ...roots.filter((root) => root !== moving)]
  }
  const rows = before.repos.find((repo) => repo.root === key)?.worktrees ?? []
  const [main, ...linked] = rows
  return [main, moving, ...linked.filter((row) => row !== moving)]
}
function observedOrder({ step, after, key }) {
  if (step === 'drag-repo') return after.repos.map((repo) => repo.root)
  return after.repos.find((repo) => repo.root === key)?.worktrees ?? []
}

/** 창 안 좌표 → 화면 좌표. 정수로 내린다(cliclick 은 정수 포인트). */
const toScreen = (origin, p) => ({ x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y) })

const fmt = (p) => `=${p.x},=${p.y}`

/** 실제 OS 드래그 — 누르기 · 몇 걸음 옮기기 · 놓기. 걸음 사이 30ms. */
function osDrag(from, to, steps = 10) {
  const moves = []
  for (let index = 1; index <= steps; index++) moves.push(`dm:${fmt({ x: Math.round(from.x + ((to.x - from.x) * index) / steps), y: Math.round(from.y + ((to.y - from.y) * index) / steps) })}`, 'w:30')
  const cmd = ['-e', '20', `m:${fmt(from)}`, 'w:150', `dd:${fmt(from)}`, 'w:120', ...moves, 'w:200', `du:${fmt(to)}`, 'w:300']
  execFileSync('/opt/homebrew/bin/cliclick', cmd, { encoding: 'utf8' })
  return cmd.join(' ')
}

/**
 * 입력이 실제로 이 창에 왔는지 — 수동 기록기(상태를 바꾸지 않는다, passive capture 리스너)를 걸어 OS 이벤트의 창 안·화면 좌표를 받는다.
 * 한 번만 건다(`__l469armed`) — 기록 배열만 비운다. 탐침(누르기 없는 커서 이동)의 도착 확인에도 쓴다(코디네이터 재시도 조건 3).
 */
const ARM_RECORDER = `(() => { window.__l469 = []; if (!window.__l469armed) { window.__l469armed = true; for (const type of ['mousemove','mousedown','mouseup']) window.addEventListener(type, (e) => { if (type === 'mousemove' && window.__l469.length > 400) return; window.__l469.push({ type, x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, buttons: e.buttons, trusted: e.isTrusted, t: Date.now() }) }, { capture: true, passive: true }) } return true })()`

/** 우리 앱의 화면 위(현재 Space) 레이어 0 주 창 — 없으면 null. */
function ourWindow() {
  const windows = win('windows', appPid).filter((w) => w.layer === 0)
  if (windows.length === 0) return null
  return windows.reduce((a, b) => (a.bounds.w * a.bounds.h >= b.bounds.w * b.bounds.h ? a : b))
}
const sameBounds = (a, b) => a !== null && b !== null && ['x', 'y', 'w', 'h'].every((key) => a.bounds[key] === b.bounds[key])

/** 입력 보호 (코디네이터 재시도 조건 2) — 하나라도 어긋나면 던진다(입력하지 않는다). */
function guard(label, expected, points) {
  const front = win('front')
  if (front.pid !== appPid) throw new Error(`GUARD ${label}: 맨 앞 앱 ${JSON.stringify(front)} ≠ corral ${appPid}`)
  const now = ourWindow()
  if (now === null) throw new Error(`GUARD ${label}: corral 창이 현재 화면(Space)에 없다`)
  if (!sameBounds(now, expected)) throw new Error(`GUARD ${label}: 창 bounds 가 바뀌었다 ${JSON.stringify(expected.bounds)} → ${JSON.stringify(now.bounds)}`)
  const tops = points.map((p) => ({ p, top: win('top', p.x, p.y) }))
  for (const { p, top } of tops) {
    if (top.pid !== appPid || !sameBounds(top, expected)) throw new Error(`GUARD ${label}: (${p.x},${p.y}) 맨 위 창 ${JSON.stringify(top)} ≠ corral 창`)
  }
  return { front, window: now.bounds, tops }
}

/** 누르기 없는 커서 이동 탐침 — 앱에 그 화면 좌표의 mousemove 가 도착해야 통과(조건 3). */
async function probeMove(p, label) {
  await evaluate(ARM_RECORDER)
  execFileSync('/opt/homebrew/bin/cliclick', ['-e', '20', `m:${fmt(p)}`, 'w:250'], { encoding: 'utf8' })
  await pause(150)
  const events = await evaluate('window.__l469')
  const hit = events.find((e) => e.type === 'mousemove' && Math.abs(e.sx - p.x) <= 2 && Math.abs(e.sy - p.y) <= 2)
  if (!hit) throw new Error(`PROBE ${label}: (${p.x},${p.y}) 의 mousemove 가 앱에 오지 않았다 — 받은 것 ${JSON.stringify(events.slice(-3))}`)
  return hit
}

async function main() {
  const out = { step, arg: arg ?? null, at: new Date().toISOString(), appPid }
  switch (step) {
    case 'order': {
      for (let i = 0; i < 60; i++) {
        const geo = await read().catch(() => null)
        if (geo && geo.repos.length > 0 && geo.repos.every((repo) => repo.collapsed || repo.worktrees.length > 0)) break
        await pause(500)
      }
      await pause(800)
      out.read = await read()
      out.shot = await shot(`order-${arg}`)
      break
    }
    case 'fixture': {
      out.add = await rpc(ctl, { cmd: 'add-repo', root: arg })
      const real = fs.realpathSync(arg)
      for (let i = 0; i < 80; i++) {
        await rpc(ctl, { cmd: 'rebuild-tree' }, 30_000).catch(() => null)
        const geo = await read()
        if (geo.repos.find((repo) => repo.root === real)?.worktrees.length >= 2) break
        await pause(500)
      }
      out.read = await read()
      out.shot = await shot('fixture-added')
      break
    }
    case 'drag-repo':
    case 'drag-card': {
      const tag = process.env.L469_ATTEMPT ?? '1'
      const outFile = path.join(rawd, `${step}-try${tag}.json`)
      const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
      try {
        // ⓐ pid 로 활성화
        out.activate = win('activate', appPid)
        await pause(900)
        const expected = ourWindow()
        if (expected === null) throw new Error('GUARD 활성화 뒤: corral 창이 현재 화면(Space)에 없다')
        out.window = expected.bounds
        const before = await read()
        // 창 안 좌표 원점 = CG 창 원점 + (창 크기 − inner 크기). 페이지가 아는 screenX·screenY 와도 대조해 둔다.
        const origin = { x: expected.bounds.x + (expected.bounds.w - before.win.innerWidth), y: expected.bounds.y + (expected.bounds.h - before.win.innerHeight) }
        out.origin = { ...origin, pageScreenX: before.win.screenX, pageScreenY: before.win.screenY }
        const pts = await evaluate(`(() => {
          const step = ${JSON.stringify(step)}, key = ${JSON.stringify(arg)}
          const groups = [...document.querySelectorAll('[data-repo-list] > [data-repo]')]
          const center = (el, fx = 0.5, fy = 0.5) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy } }
          if (step === 'drag-repo') {
            const group = groups.find((g) => g.getAttribute('data-repo') === key)
            const first = groups[0].querySelector('[data-repo-head]').getBoundingClientRect()
            return { from: center(group.querySelector('.repo-row-name'), 0.4), to: { x: first.left + first.width * 0.4, y: first.top + first.height * 0.2 }, moving: key }
          }
          const group = groups.find((g) => g.getAttribute('data-repo') === key)
          const list = document.querySelector('[data-repo-list]').getBoundingClientRect()
          const cards = [...group.querySelectorAll('[data-reorder-card]')].filter((c) => { const r = c.getBoundingClientRect(); return r.top >= list.top && r.bottom <= list.bottom })
          const moving = cards[2] ?? cards[cards.length - 1]
          const first = cards[0].getBoundingClientRect()
          return { from: center(moving.querySelector('.worktree-name'), 0.3), to: { x: first.left + first.width * 0.3, y: first.top + 4 }, moving: moving.getAttribute('data-reorder-card') }
        })()`)
        const from = toScreen(origin, pts.from)
        const to = toScreen(origin, pts.to)
        out.points = { client: pts, screen: { from, to } }
        // ⓑ·ⓒ·ⓓ 보호 → 탐침(누르기 없이 두 점) → 다시 보호 → 누르기
        out.guard1 = guard('탐침 전', expected, [from, to])
        out.probeTo = await probeMove(to, '놓는 점')
        out.probeFrom = await probeMove(from, '잡는 점')
        out.guard2 = guard('누르기 직전', expected, [from, to])
        await evaluate(ARM_RECORDER)
        out.before = before
        out.shotBefore = await shot(`${step}-try${tag}-before`)
        out.cliclick = osDrag(from, to)
        await pause(500)
        const events = await evaluate('window.__l469')
        out.events = { down: events.filter((e) => e.type === 'mousedown'), up: events.filter((e) => e.type === 'mouseup'), moves: events.filter((e) => e.type === 'mousemove').length }
        out.after = await read()
        out.shotAfter = await shot(`${step}-try${tag}-after`)
        out.frontAfter = win('front')
        out.arrived = out.events.down.length > 0 && out.events.up.length > 0
        if (!out.arrived) throw new Error(`ARRIVAL: 누르기·놓기가 앱에 오지 않았다 ${JSON.stringify(out.events)}`)
        // 판정은 이벤트 도착이 아니라 **기대 순서**로 한다(수정 라운드 1 R1-07) — 끈 항목이 첫 자리로 가고 나머지 상대 순서는 그대로.
        out.expected = expectedOrder({ step, before, moving: pts.moving, key: arg })
        out.observed = observedOrder({ step, after: out.after, key: arg })
        out.orderAsExpected = JSON.stringify(out.expected) === JSON.stringify(out.observed)
        if (!out.orderAsExpected) throw new Error(`ORDER: 기대 ${JSON.stringify(out.expected)} ≠ 관측 ${JSON.stringify(out.observed)}`)
      } catch (error) {
        out.stopped = String(error?.message ?? error)
        save()
        throw error
      }
      save()
      log('wrote', outFile)
      return
    }
    default:
      throw new Error(`단계 모름: ${step}`)
  }
  const file = path.join(rawd, `${step}${arg && step === 'order' ? `-${arg}` : ''}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  log('wrote', file)
}

main().catch((error) => {
  console.error(String(error?.stack ?? error))
  fs.writeFileSync(path.join(rawd, `${step}-error.txt`), String(error?.stack ?? error))
  process.exit(1)
})
