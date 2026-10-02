// LIFE-477 K10 네이티브 관문 드라이버 — LIFE-470 `native-k11.mjs` 의 보호·탐침·도착 확인(ⓐ~ⓓ)을 그대로 옮기고 화면 읽기만 K10 용으로 바꿨다.
// 제어 소켓으로 **읽기**(화면 상태·캡처)만 하고, 입력은 **실제 OS 입력(cliclick)** 으로 한다. CDP 없음.
// 입력마다 ⓐ pid 활성화 → ⓑ 맨 앞 앱 = corral ⓒ 입력 점의 맨 위 창 = corral 창 ⓓ 창이 현재 Space · bounds 가 직전 읽기와 같다 →
// 누르기 없는 커서 이동 탐침(앱에 mousemove 도착) → 다시 보호 → 입력. 하나라도 어긋나면 입력하지 않고 멈춘다(exit 1, stopped 기록).
// **G7**: Full list 행의 라벨·도구 입력·메시지(실제 에이전트 대화)는 원문을 비공개 위치(`/tmp/l477-private`)에만 두고, 결과 JSON 에는
// 유무·길이·sha256 만 적는다. 경로·브랜치는 470 `anon.mjs` 키로(대응표도 비공개 — `L470_PRIVATE_DIR=/tmp/l477-private` 로 돌린다).
// 캡처는 비공개 위치에만, 해시만 적는다.
//
// 사용: L470_PRIVATE_DIR=/tmp/l477-private node native-k10.mjs <ROOT> <raw 폴더> <단계> <꼬리표> [인자]
//   state <꼬리표>                 화면 상태 + ui-prefs(옵션 칸만) + 캡처
//   hover <꼬리표> <selector>      그 요소 가운데로 커서만 옮긴다(서브메뉴·제목 hover) — 누르지 않는다
//   click <꼬리표> <selector>      그 요소 가운데를 OS 클릭
//   key <꼬리표> esc               OS 키 입력
//   watch <꼬리표> <초>            입력 없이 Full list 행을 0.25초마다 읽어 2줄(도구)·3줄(메시지) 전이를 기록한다

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { anonymizeValue, loadMap, PRIVATE_DIR, registerRead, saveMap } from '../l470/anon.mjs'

if (!PRIVATE_DIR.startsWith('/tmp/l477-private')) throw new Error(`L470_PRIVATE_DIR=/tmp/l477-private 로 돌린다 (지금 ${PRIVATE_DIR})`)
const [root, rawd, step, tag, arg] = process.argv.slice(2)
const ctl = path.join(root, 'ctl.sock')
const winctl = process.env.L477_WINCTL ?? '/tmp/l477nbin/winctl'
const cliclick = '/opt/homebrew/bin/cliclick'
const prefsFile = path.join(process.env.HOME, 'Library/Application Support/corral/ui-prefs.json')
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
const shots = path.join(PRIVATE_DIR, 'native-shots', path.basename(rawd))
const texts = path.join(PRIVATE_DIR, 'native-texts', path.basename(rawd))
fs.mkdirSync(shots, { recursive: true, mode: 0o700 })
fs.mkdirSync(texts, { recursive: true, mode: 0o700 })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log('[k10]', ...parts)
const win = (...rest) => JSON.parse(execFileSync(winctl, rest.map(String), { encoding: 'utf8' }))
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')

async function evaluate(code) {
  const res = await rpc(ctl, { cmd: 'eval', code }, 20_000)
  if (!res.ok) throw new Error(`eval: ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}

/** 화면 읽기 — 상태를 바꾸지 않는다. 대화 원문이 섞인 칸(라벨·도구 입력·메시지·hover 카드 글)은 `private` 로 따로 모은다. */
const READ = `(() => {
  const list = document.querySelector('[data-repo-list]')
  if (!list) return null
  const menu = document.querySelector('[data-sidebar-options-menu]')
  const checked = [...document.querySelectorAll('[data-options-radio], [data-group-by], [data-options-filter], [data-options-property]')].filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.getAttribute('data-options-radio') ?? el.getAttribute('data-group-by') ?? el.getAttribute('data-options-filter') ?? ('property:' + el.getAttribute('data-options-property')))
  const card = document.querySelector('[data-hover-card]')
  const cards = [...list.querySelectorAll('[data-worktree]')]
  const fullRows = [...list.querySelectorAll('[data-agent-full-row]')].map((row) => {
    const header = row.querySelector('[data-agent-row-tool-header]')
    const message = row.querySelector('[data-agent-row-message]')
    return {
      worktree: row.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null,
      pane: row.getAttribute('data-pane'),
      source: row.getAttribute('data-agent-row-source'),
      kind: row.querySelector('[data-agent-kind]')?.getAttribute('data-agent-kind') ?? null,
      dot: row.querySelector('[data-agent-dot]')?.getAttribute('data-agent-dot') ?? null,
      model: row.querySelector('.agent-row-model')?.textContent ?? null,
      time: row.querySelector('[data-elapsed]')?.getAttribute('data-elapsed') ?? null,
      tool: header !== null ? 'tool' : row.querySelector('[data-agent-row-tool-placeholder]') !== null ? 'placeholder' : 'none',
      toolName: header?.querySelector('.agent-full-tool-name')?.textContent ?? null,
      messageKind: message?.getAttribute('data-agent-row-message') === 'empty' ? 'empty' : 'text',
      interrupted: row.querySelector('.agent-full-interrupted') !== null,
      height: Math.round(row.getBoundingClientRect().height * 100) / 100,
      private: {
        label: row.querySelector('[data-agent-full-label]')?.textContent ?? '',
        toolInput: header?.querySelector('.agent-full-tool-input')?.textContent ?? null,
        message: row.querySelector('.agent-full-message-text')?.textContent ?? null,
      },
    }
  })
  return {
    menuOpen: menu !== null,
    submenu: document.querySelector('[data-options-submenu]')?.getAttribute('data-options-submenu') ?? null,
    menuChecked: menu === null ? null : checked,
    menuSections: menu === null ? null : [...menu.querySelectorAll('.options-menu-section-label, [data-submenu-trigger]')].map((el) => el.getAttribute('data-submenu-trigger') ?? el.textContent),
    triggerValues: menu === null ? null : Object.fromEntries([...menu.querySelectorAll('[data-submenu-trigger]')].map((el) => [el.getAttribute('data-submenu-trigger'), el.querySelector('.options-submenu-value, .options-menu-value')?.textContent ?? null])),
    groups: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({ root: group.getAttribute('data-repo'), worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')) })),
    all: (() => { const all = list.querySelector(':scope > [data-reorder-all]'); return all === null ? null : [...all.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')) })(),
    layouts: Object.fromEntries(cards.map((row) => [row.getAttribute('data-worktree'), (row.closest('[data-card-layout]') ?? row.querySelector('[data-card-layout]'))?.getAttribute('data-card-layout') ?? null])),
    metaRows: cards.filter((row) => row.querySelector('[data-worktree-card-meta-row]') !== null).length,
    gitMarks: cards.filter((row) => row.querySelector('[data-worktree-card-meta-row] .worktree-mark') !== null).map((row) => row.getAttribute('data-worktree')),
    hoverTriggers: [...list.querySelectorAll('[data-hover-card-trigger]')].map((el) => el.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null),
    hoverCard: card === null ? null : (() => { const r = card.getBoundingClientRect(); return { rect: { left: r.left, top: r.top, width: r.width, height: r.height }, hasBranch: card.querySelector('.hover-card-branch') !== null, hasTitle: card.querySelector('.hover-card-title') !== null, hasGit: card.querySelector('[data-hover-git]') !== null, privateText: card.textContent } })(),
    compactAgentLists: list.querySelectorAll('[data-compact-agent-list]').length,
    fullAgentLists: list.querySelectorAll('[data-full-agent-list]').length,
    agentGroups: list.querySelectorAll('[data-agent-group]').length,
    compactRows: list.querySelectorAll('[data-agent-row]:not([data-agent-full-row])').length,
    statusDots: list.querySelectorAll('[data-worktree-card-status-slot]').length,
    fullRows,
    win: { innerWidth, innerHeight, screenX, screenY, dpr: devicePixelRatio },
  }
})()`

/** 대화 원문 칸을 떼어 비공개 파일로 — 결과에는 유무·길이·해시만. */
function redact(read, name) {
  if (read === null || read === undefined) return read
  const privateOut = { hoverCard: read.hoverCard?.privateText ?? null, rows: read.fullRows.map((row) => row.private) }
  fs.writeFileSync(path.join(texts, `${name}.json`), JSON.stringify(privateOut, null, 2), { mode: 0o600 })
  const field = (text) => (text === null ? null : { length: text.length, sha256: sha(text) })
  return {
    ...read,
    hoverCard: read.hoverCard === null ? null : { ...read.hoverCard, privateText: field(read.hoverCard.privateText) },
    fullRows: read.fullRows.map(({ private: secret, ...row }) => ({ ...row, label: field(secret.label), toolInput: field(secret.toolInput), message: field(secret.message) })),
  }
}

async function read() {
  const value = await evaluate(READ)
  if (value === null) throw new Error('사이드바가 아직 없다')
  return value
}
/** 표시·배치 옵션 칸만(관문이 바꾸는 열거값). 수동 순서·그 밖의 사용자 ui-prefs 칸은 읽지 않는다. */
const VIEW_FIELDS = ['sidebarGroupBy', 'sidebarSortBy', 'sidebarProjectOrderBy', 'sidebarHideDefaultBranch', 'sidebarHideDetachedHead', 'sidebarCardLayout', 'sidebarCardProperties', 'sidebarAgentActivityLayout']
const prefs = () => {
  const all = JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
  return Object.fromEntries(Object.entries(all).filter(([key]) => VIEW_FIELDS.includes(key)))
}
async function shot(name) {
  const res = await rpc(ctl, { cmd: 'shot', name }, 20_000)
  if (!res.ok || !res.file || !fs.existsSync(res.file)) return null
  const dest = path.join(shots, `${name}.png`)
  fs.copyFileSync(res.file, dest)
  fs.chmodSync(dest, 0o600)
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
    for (const value of [out.before, out.after, out.read]) if (value) registerRead({ map, read: { ...value, branches: {} } })
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
        out.read = redact(await read(), `state-${tag}`)
        out.prefs = prefs()
        out.shot = await shot(`state-${tag}`)
        break
      }
      case 'hover':
      case 'click': {
        const { expected, origin } = await activate(out)
        out.before = redact(out.before, `${step}-${tag}-before`)
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
        out.after = redact(await read(), `${step}-${tag}-after`)
        out.prefs = prefs()
        out.shot = await shot(`${step}-${tag}`)
        break
      }
      case 'key': {
        const { expected, origin } = await activate(out)
        out.before = redact(out.before, `key-${tag}-before`)
        const center = toScreen(origin, { x: out.before.win.innerWidth / 2, y: out.before.win.innerHeight / 2 })
        out.guard1 = guard('키 전', expected, [center])
        await evaluate(ARM_RECORDER)
        if (arg !== 'esc') throw new Error(`키 모름: ${arg}`)
        out.guard2 = guard('키 직전', expected, [center])
        execFileSync(cliclick, ['-e', '20', 'kp:esc', 'w:200'], { encoding: 'utf8' })
        await pause(300)
        const events = await evaluate('window.__l470')
        out.events = events.filter((e) => e.type === 'keydown')
        out.arrived = out.events.some((e) => e.trusted && e.key === 'Escape')
        if (!out.arrived) throw new Error(`ARRIVAL: 키가 앱에 오지 않았다 ${JSON.stringify(out.events)}`)
        await pause(700)
        out.after = redact(await read(), `key-${tag}-after`)
        out.prefs = prefs()
        out.shot = await shot(`key-${tag}`)
        break
      }
      case 'watch': {
        // 입력 없음 — Full list 행의 (pane, 점, 2줄, 3줄) 조합이 바뀔 때마다 한 줄. 도구 줄을 처음 본 순간·끝 상태를 캡처한다.
        const until = Date.now() + Number(arg ?? 60) * 1000
        const seen = []
        let last = ''
        let toolShot = false
        let n = 0
        while (Date.now() < until) {
          const now = await read().catch(() => null)
          if (now !== null) {
            const key = JSON.stringify(now.fullRows.map((row) => [row.pane, row.kind, row.dot, row.tool, row.toolName, row.messageKind, row.private.message !== null]))
            if (key !== last) {
              last = key
              n += 1
              seen.push({ at: new Date().toISOString(), read: redact(now, `watch-${tag}-${String(n).padStart(3, '0')}`) })
              if (!toolShot && now.fullRows.some((row) => row.tool === 'tool')) {
                toolShot = true
                seen[seen.length - 1].shot = await shot(`watch-${tag}-tool`)
              }
            }
          }
          await pause(250)
        }
        out.transitions = seen.map((item) => ({ at: item.at, shot: item.shot ?? null, rows: item.read.fullRows }))
        out.read = redact(await read(), `watch-${tag}-end`)
        out.shot = await shot(`watch-${tag}-end`)
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
