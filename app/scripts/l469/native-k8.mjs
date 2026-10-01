// LIFE-469 K8 네이티브 관문 드라이버 — 제어 소켓으로 **읽기**(순서·창 기하·캡처)만 하고, 끌기는 **실제 OS 입력(cliclick)** 으로 한다.
// CDP 를 쓰지 않는다(디버깅 포트 없이 띄운다). OS 입력 전마다 그 화면 점의 맨 위 창이 우리 앱 pid 인지 CoreGraphics 로 확인하고,
// 아니면 입력하지 않고 실패로 멈춘다(킥오프 격리 5 — 다른 앱 창 위로 입력 금지).
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

/** 우리 창(가장 큰 레이어 0 창)의 화면 위 내용 원점. 제목 막대 높이 = 창 높이 − innerHeight. */
function contentOrigin(geo) {
  const windows = win('windows', appPid).filter((w) => w.layer === 0)
  if (windows.length === 0) throw new Error(`pid ${appPid} 의 화면 위 창이 없다`)
  const main = windows.reduce((a, b) => (a.bounds.w * a.bounds.h >= b.bounds.w * b.bounds.h ? a : b))
  return { x: main.bounds.x + (main.bounds.w - geo.win.innerWidth), y: main.bounds.y + (main.bounds.h - geo.win.innerHeight), window: main.bounds }
}

/** 창 안 좌표 → 화면 좌표. 정수로 내린다(cliclick 은 정수 포인트). */
const toScreen = (origin, p) => ({ x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y) })

/** 그 화면 점의 맨 위 창이 우리 앱인지 — 아니면 입력하지 않는다. */
function assertOurs(point, label) {
  const top = win('top', point.x, point.y)
  if (top.pid !== appPid) throw new Error(`✘ 입력 중단 — ${label} (${point.x},${point.y}) 맨 위 창 = ${JSON.stringify(top)} (우리 앱 ${appPid} 아님)`)
  return top
}

const fmt = (p) => `=${p.x},=${p.y}`

/** 실제 OS 드래그 — 누르기 · 몇 걸음 옮기기 · 놓기. 걸음 사이 30ms. */
function osDrag(from, to, steps = 10) {
  const moves = []
  for (let index = 1; index <= steps; index++) moves.push(`dm:${fmt({ x: Math.round(from.x + ((to.x - from.x) * index) / steps), y: Math.round(from.y + ((to.y - from.y) * index) / steps) })}`, 'w:30')
  const cmd = ['-e', '20', `m:${fmt(from)}`, 'w:150', `dd:${fmt(from)}`, 'w:120', ...moves, 'w:200', `du:${fmt(to)}`, 'w:300']
  execFileSync('/opt/homebrew/bin/cliclick', cmd, { encoding: 'utf8' })
  return cmd.join(' ')
}

/** 입력이 실제로 이 창에 왔는지 — 수동 기록기(상태를 바꾸지 않는다)를 걸어 OS 이벤트 좌표를 받는다. */
const ARM_RECORDER = `(() => { window.__l469 = []; for (const type of ['mousedown','mouseup']) window.addEventListener(type, (e) => window.__l469.push({ type, x: e.clientX, y: e.clientY, trusted: e.isTrusted }), { capture: true, passive: true }); return true })()`

async function activate() {
  const front = win('front')
  if (front.pid !== appPid) {
    win('activate', appPid)
    await pause(600)
  }
  return win('front')
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
      out.front = await activate()
      if (out.front.pid !== appPid) throw new Error(`✘ 우리 앱이 앞으로 오지 않았다: ${JSON.stringify(out.front)}`)
      const before = await read()
      const origin = contentOrigin(before)
      out.origin = origin
      // 잡을 점·놓을 점 (창 안 좌표)
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
      out.topAtFrom = assertOurs(from, '잡는 점')
      out.topAtTo = assertOurs(to, '놓는 점')
      await evaluate(ARM_RECORDER)
      out.before = before
      out.shotBefore = await shot(`${step}-before`)
      out.cliclick = osDrag(from, to)
      await pause(500)
      out.events = await evaluate('window.__l469')
      out.after = await read()
      out.shotAfter = await shot(`${step}-after`)
      out.frontAfter = win('front')
      break
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
