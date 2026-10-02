// LIFE-478 K11 네이티브 관문 드라이버 — LIFE-477 `native-k10.mjs` 의 보호·탐침·도착 확인(ⓐ~ⓓ)을 그대로 옮기고 화면 읽기·입력 종류만 K11 용으로 바꿨다.
// 제어 소켓으로 **읽기**(화면 상태·캡처)만 하고, 입력은 **실제 OS 입력(cliclick)** 으로 한다. CDP 없음.
// 입력마다 ⓐ pid 활성화 → ⓑ 맨 앞 앱 = corral ⓒ 입력 점의 맨 위 창 = corral 창 ⓓ 창이 현재 Space · bounds 가 직전 읽기와 같다 →
// 누르기 없는 커서 이동 탐침(앱에 mousemove 도착) → 다시 보호 → 입력 → 도착 확인(isTrusted 이벤트). 하나라도 어긋나면 입력하지 않고 멈춘다.
// 예외는 `unfocused`(K2ⓕ · Orca #14545) 하나 — 관문이 띄운 TextEdit 새 문서를 맨 앞에 두고(ⓑ 기대 = TextEdit), corral 카드 점이 맨 위
// corral 창인지 확인한 뒤 우클릭한다. 절차·관측은 그 단계 JSON 에.
// **G7**: 사용자 레포·워크트리는 개수·익명 키만, 카드 글자(표시 이름·comment·브랜치)는 관문 레포(<ROOT>/repos 아래) 카드만 읽는다.
// 캡처는 비공개 위치(`/tmp/l478-private`)에만, 해시만 적는다. 경로는 470 `anon.mjs` 키로(대응표도 비공개).
// **진단 입력도 이 드라이버(guard)로만 보낸다** — 드라이버 밖에서 cliclick·keypost 를 직접 부르지 않는다(R029 보호 규칙 위반 15키가 그 경로였다).
// 직전 단계가 실패로 끝났으면 다음 입력 단계는 거절된다(`native-k11-gate.mjs` — R030 type-06 뒤 Enter 재발 방지). 실패를 본 뒤 `ack` 로 확인한다.
//
// 사용: L470_PRIVATE_DIR=/tmp/l478-private node native-k11.mjs <ROOT> <raw 폴더> <단계> <꼬리표> [인자…]
//   state <꼬리표>                     화면 상태 + 캡처
//   hover|click|rclick|dblclick <꼬리표> <selector> [fx fy]   그 요소(비율 점, 기본 가운데)에 OS 입력
//   altclick <꼬리표> <hover selector> <click selector>        Option 을 누른 채 hover 한 카드의 단추를 누른다(K7ⓗ 휴지통)
//   key <꼬리표> <esc|enter|shift-enter|down|up|left|right|backspace|cmd-alt-r|cmd-shift-backspace|select-all>
//   type <꼬리표> <글자>               포커스된 입력란에 클립보드 붙여넣기로 글자 입력(백업·원복·해시 대조)
//   vscode <꼬리표>                     VS Code 창 개수·관문 창 수(읽기만)
//   ack <꼬리표> <실패한 꼬리표>          직전 실패를 확인했다고 기록 — 그 뒤에야 입력 단계가 다시 나간다
//   unfocused <꼬리표> <selector>       K2ⓕ — TextEdit 를 앞에 둔 채 corral 카드를 우클릭 → hover 강조 → ↓ 키 → Esc

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { anonymizeValue, loadMap, PRIVATE_DIR, registerRead, saveMap } from '../l470/anon.mjs'
import { clipboardVerdict, readLastStep, stepGate, writeLastStep } from './native-k11-gate.mjs'

if (!PRIVATE_DIR.startsWith('/tmp/l478-private')) throw new Error(`L470_PRIVATE_DIR=/tmp/l478-private 로 돌린다 (지금 ${PRIVATE_DIR})`)
const [root, rawd, step, tag, ...rest] = process.argv.slice(2)
if (!root.startsWith('/tmp/l478n')) throw new Error(`ROOT 는 /tmp/l478n*: ${root}`)
const ctl = path.join(root, 'ctl.sock')
const winctl = process.env.L478_WINCTL ?? '/tmp/l478nbin/winctl'
const cliclick = process.env.L478_CLICLICK ?? '/opt/homebrew/bin/cliclick'
/** 키코드를 정확히 싣는 키 입력(keypost.swift) — ⌘ 조합은 이것으로(cliclick t: 는 키코드 0 이라 ⌘A 로 읽혔다). */
const keypost = process.env.L478_KEYPOST ?? '/tmp/l478nbin/keypost'
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
const gatePrefix = fs.realpathSync(path.join(root, 'repos'))
const shots = path.join(PRIVATE_DIR, 'native-shots', path.basename(rawd))
fs.mkdirSync(shots, { recursive: true, mode: 0o700 })
fs.mkdirSync(rawd, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log('[k11]', ...parts)
const win = (...args) => JSON.parse(execFileSync(winctl, args.map(String), { encoding: 'utf8' }))

async function evaluate(code) {
  const res = await rpc(ctl, { cmd: 'eval', code }, 20_000)
  if (!res.ok) throw new Error(`eval: ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}

/** 화면 읽기 — 상태를 바꾸지 않는다. 관문 레포 밖 카드는 경로·선택 여부만(글자 없음). */
const READ = `((gate) => {
  const list = document.querySelector('[data-repo-list]')
  if (!list) return null
  const ours = (p) => p !== null && p.startsWith(gate)
  const cards = Object.fromEntries([...list.querySelectorAll('[data-worktree]')].filter((row) => ours(row.getAttribute('data-worktree'))).map((row) => [row.getAttribute('data-worktree'), {
    title: row.querySelector('[data-worktree-title]')?.textContent ?? null,
    metaBranch: row.querySelector('[data-worktree-meta-branch]')?.textContent ?? null,
    note: row.querySelector('[data-worktree-note-badge]') !== null,
    parentPath: row.querySelector('[data-worktree-parent]')?.getAttribute('data-worktree-parent') ?? null,
    pinned: row.hasAttribute('data-worktree-pinned'),
    reorder: row.hasAttribute('data-reorder-card'),
    deleting: row.querySelector('[data-worktree-deleting]') !== null,
    trash: row.querySelector('[data-worktree-trash]') !== null,
    renaming: row.querySelector('[data-inline-rename]') !== null,
    renameValue: row.querySelector('[data-inline-rename]')?.value ?? null,
    flash: row.querySelector('.card-reveal-flash') !== null,
    repoLabel: (row.querySelector('[data-worktree-repo-chip]') ?? row.querySelector('[data-worktree-repo-label]'))?.textContent ?? null,
    selected: row.querySelector('[data-worktree-card-active="primary"]') !== null,
  }]))
  const menuEl = document.querySelector('[data-card-menu]')
  const dlg = document.querySelector('[data-delete-worktree-dialog]')
  const pinned = list.querySelector(':scope > [data-pinned-section]')
  const hover = document.querySelector('[data-hover-card]')
  return {
    groups: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({ root: group.getAttribute('data-repo'), worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')) })),
    pinned: pinned === null ? null : [...pinned.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
    selectedPath: list.querySelector('[data-worktree-card-active="primary"]')?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null,
    cards,
    cardMenu: menuEl === null ? null : {
      for: menuEl.getAttribute('data-card-menu'),
      items: [...menuEl.querySelectorAll(':scope > [data-menu-action]')].map((el) => ({ action: el.getAttribute('data-menu-action'), label: el.querySelector('.ctx-menu-text')?.textContent ?? null, disabled: el.getAttribute('aria-disabled') === 'true' })),
      active: document.querySelector('[data-context-submenu] [data-menu-active]')?.getAttribute('data-menu-action') ?? menuEl.querySelector('[data-menu-active]')?.getAttribute('data-menu-action') ?? null,
      submenu: document.querySelector('[data-context-submenu]')?.getAttribute('data-context-submenu') ?? null,
    },
    menus: { card: document.querySelectorAll('[data-card-menu]').length, options: document.querySelectorAll('[data-sidebar-options-menu]').length, repo: document.querySelectorAll('[data-repo-menu]').length, worktree: document.querySelectorAll('[data-worktree-menu]').length, help: document.querySelectorAll('[data-help-menu]').length },
    metaDialog: document.querySelector('[data-worktree-meta-dialog]')?.getAttribute('data-worktree-meta-dialog') ?? null,
    metaError: document.querySelector('[data-meta-error]')?.textContent ?? null,
    picker: document.querySelector('[data-parent-picker]') === null ? null : { for: document.querySelector('[data-parent-picker]').getAttribute('data-parent-picker'), candidates: [...document.querySelectorAll('[data-parent-candidate]')].map((c) => c.getAttribute('data-parent-candidate')) },
    deleteDialog: dlg === null ? null : { path: dlg.getAttribute('data-delete-worktree-dialog'), decision: dlg.getAttribute('data-delete-decision'), dirty: dlg.querySelector('[data-delete-dirty]')?.getAttribute('data-delete-dirty') ?? null, sessions: dlg.querySelector('[data-delete-sessions]')?.getAttribute('data-delete-sessions') ?? null, confirm: dlg.querySelector('[data-delete-confirm]')?.getAttribute('data-delete-confirm') ?? null },
    notice: (() => { const t = document.querySelector('[data-add-notice] .inline-notice-text')?.textContent ?? null; return t === null ? null : (t.includes(gate) || /l478n|gate-/.test(t) ? t : '(관문 밖 알림 — 글자 생략)') })(),
    revealConfirm: document.querySelector('[data-reveal-confirm]')?.getAttribute('data-reveal-confirm') ?? null,
    shortcuts: document.querySelector('[data-shortcut-settings]') !== null,
    shortcutRows: document.querySelector('[data-shortcut-settings]') === null ? null : ['workspace.rename', 'workspace.delete'].map((id) => document.querySelector('[data-shortcut-action="' + id + '"]')?.textContent ?? null),
    helpItems: [...document.querySelectorAll('[data-help-menu] [data-menu-action]')].map((el) => el.textContent),
    hoverCard: hover === null ? null : { for: hover.getAttribute('data-hover-card'), ours: ours(hover.getAttribute('data-hover-card')), text: ours(hover.getAttribute('data-hover-card')) ? hover.textContent : null },
    footer: (() => { const f = document.querySelector('[data-sidebar-footer]'); return f === null ? null : { text: f.textContent, help: f.querySelector('[data-help-menu-toggle]') !== null, reveal: f.querySelector('[data-reveal-active]') !== null } })(),
    focus: document.activeElement?.tagName ?? null,
    hasFocus: document.hasFocus(),
    win: { innerWidth, innerHeight, screenX, screenY, dpr: devicePixelRatio },
  }
})(${JSON.stringify('__GATE__')})`

const readCode = () => READ.replace('"__GATE__"', JSON.stringify(gatePrefix))
async function read() {
  const value = await evaluate(readCode())
  if (value === null) throw new Error('사이드바가 아직 없다')
  return value
}
const prefsFile = path.join(process.env.HOME, 'Library/Application Support/corral/ui-prefs.json')
/** 관문이 바꾸는 칸만 — 고정 경로(관문 레포 것만 남긴다)·필터. 그 밖의 사용자 ui-prefs 칸은 읽지 않는다. */
const prefs = () => {
  const all = JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
  const pins = Array.isArray(all.pinnedWorktrees) ? all.pinnedWorktrees : null
  return { pinnedWorktrees: pins === null ? null : { gate: pins.filter((p) => p.startsWith(gatePrefix)), others: pins.filter((p) => !p.startsWith(gatePrefix)).length }, sidebarRepoFilterCount: Array.isArray(all.sidebarRepoFilter) ? all.sidebarRepoFilter.length : null }
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
const ARM_RECORDER = `(() => { window.__l478 = []; if (!window.__l478armed) { window.__l478armed = true; for (const type of ['mousemove','mousedown','mouseup','click','dblclick','contextmenu','keydown']) window.addEventListener(type, (e) => { if (type === 'mousemove' && window.__l478.length > 400) return; window.__l478.push({ type, button: e.button, x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, key: e.key, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, trusted: e.isTrusted, t: Date.now() }) }, { capture: true, passive: true }) } return true })()`

function ourWindow() {
  const windows = win('windows', appPid).filter((w) => w.layer === 0)
  if (windows.length === 0) return null
  return windows.reduce((a, b) => (a.bounds.w * a.bounds.h >= b.bounds.w * b.bounds.h ? a : b))
}
const sameBounds = (a, b) => a !== null && b !== null && ['x', 'y', 'w', 'h'].every((key) => a.bounds[key] === b.bounds[key])

/** 입력 보호 ⓑ·ⓒ·ⓓ — 하나라도 어긋나면 던진다(입력하지 않는다). `frontPid` = 맨 앞이어야 할 앱(보통 corral, K2ⓕ 는 TextEdit). */
function guard(label, expected, points, frontPid = appPid) {
  const front = win('front')
  if (front.pid !== frontPid) throw new Error(`GUARD ${label}: 맨 앞 앱 ${JSON.stringify(front)} ≠ 기대 ${frontPid}`)
  const now = ourWindow()
  if (now === null) throw new Error(`GUARD ${label}: corral 창이 현재 화면(Space)에 없다`)
  if (!sameBounds(now, expected)) throw new Error(`GUARD ${label}: 창 bounds 가 바뀌었다 ${JSON.stringify(expected.bounds)} → ${JSON.stringify(now.bounds)}`)
  const tops = points.map((p) => ({ p, top: win('top', p.x, p.y) }))
  for (const { p, top } of tops) if (top.pid !== appPid || !sameBounds(top, expected)) throw new Error(`GUARD ${label}: (${p.x},${p.y}) 맨 위 창 ${JSON.stringify(top)} ≠ corral 창`)
  return { front, window: now.bounds, tops }
}

async function probeMove(p, label) {
  await evaluate(ARM_RECORDER)
  execFileSync(cliclick, ['-e', '20', `m:${fmt(p)}`, 'w:250'], { encoding: 'utf8' })
  await pause(150)
  const events = await evaluate('window.__l478')
  const hit = events.find((e) => e.type === 'mousemove' && Math.abs(e.sx - p.x) <= 2 && Math.abs(e.sy - p.y) <= 2)
  if (!hit) throw new Error(`PROBE ${label}: (${p.x},${p.y}) 의 mousemove 가 앱에 오지 않았다 — 받은 것 ${JSON.stringify(events.slice(-3))}`)
  return hit
}

async function originOf(expected) {
  const before = await read()
  return { before, origin: { x: expected.bounds.x + (expected.bounds.w - before.win.innerWidth), y: expected.bounds.y + (expected.bounds.h - before.win.innerHeight) } }
}
async function activate(out) {
  out.activate = win('activate', appPid)
  await pause(900)
  const expected = ourWindow()
  if (expected === null) throw new Error('GUARD 활성화 뒤: corral 창이 현재 화면(Space)에 없다')
  out.window = expected.bounds
  const { before, origin } = await originOf(expected)
  out.origin = origin
  out.before = before
  return { expected, origin }
}
async function pointIn(selector, fx = 0.5, fy = 0.5) {
  const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; let r = el.getBoundingClientRect(); const list = el.closest('[data-repo-list]'); if (list) { const lr = list.getBoundingClientRect(); if (r.top < lr.top + 40 || r.bottom > lr.bottom) { el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect() } } return { x: r.left + r.width * ${Number(fx)}, y: r.top + r.height * ${Number(fy)} } })()`)
  if (p === null) throw new Error(`요소 없음: ${selector}`)
  return p
}
async function events(kind) {
  const all = await evaluate('window.__l478')
  return all.filter((e) => (kind === 'mouse' ? e.type !== 'mousemove' && e.type !== 'keydown' : e.type === 'keydown'))
}

const KEYS = {
  esc: { args: ['kp:esc'], key: 'Escape' },
  enter: { args: ['kp:return'], key: 'Enter' },
  'shift-enter': { post: ['36', 'shift'], key: 'Enter', shift: true },
  down: { args: ['kp:arrow-down'], key: 'ArrowDown' },
  up: { args: ['kp:arrow-up'], key: 'ArrowUp' },
  left: { args: ['kp:arrow-left'], key: 'ArrowLeft' },
  right: { args: ['kp:arrow-right'], key: 'ArrowRight' },
  backspace: { args: ['kp:delete'], key: 'Backspace' },
  'cmd-alt-r': { post: ['15', 'cmd', 'alt'], key: null, meta: true, alt: true },
  'cmd-shift-backspace': { post: ['51', 'cmd', 'shift'], key: 'Backspace', meta: true, shift: true },
  'select-all': { post: ['0', 'cmd'], key: 'a', meta: true },
}

async function main() {
  const out = { step, tag, args: rest, at: new Date().toISOString(), appPid }
  const file = path.join(rawd, `${step}-${tag}.json`)
  const save = () => {
    const map = loadMap()
    for (const value of [out.before, out.after, out.read]) if (value) registerRead({ map, read: { ...value, branches: {} } })
    const safe = anonymizeValue({ value: out, map })
    saveMap(map)
    fs.writeFileSync(file, JSON.stringify(safe, null, 2) + '\n')
  }
  // 문지기 — 어떤 활성화·입력보다 먼저. 거절은 원자료로 남기되 직전 단계 기록은 건드리지 않는다(실패한 단계의 꼬리표가 그대로 남게).
  const gate = stepGate({ last: readLastStep(root), step, ackTag: step === 'ack' ? rest[0] : undefined })
  out.gate = gate
  if (gate.kind === 'refuse') {
    out.stopped = gate.reason
    save()
    throw new Error(gate.reason)
  }
  try {
    switch (step) {
      case 'ack': {
        writeLastStep({ root, step, tag, ok: true, ack: rest[0] })
        save()
        log('ack', rest[0])
        return
      }
      case 'state': {
        for (let i = 0; i < 60; i++) {
          const geo = await read().catch(() => null)
          if (geo && geo.groups.length > 0) break
          await pause(500)
        }
        await pause(600)
        out.read = await read()
        out.prefs = prefs()
        out.shot = await shot(`state-${tag}`)
        break
      }
      case 'hover':
      case 'click':
      case 'rclick':
      case 'dblclick': {
        const [selector, fx, fy] = rest
        const { expected, origin } = await activate(out)
        const target = toScreen(origin, await pointIn(selector, fx ?? 0.5, fy ?? 0.5))
        out.point = target
        out.guard1 = guard('탐침 전', expected, [target])
        out.probe = await probeMove(target, step)
        if (step !== 'hover') {
          out.guard2 = guard('입력 직전', expected, [target])
          await evaluate(ARM_RECORDER)
          const verb = { click: 'c', rclick: 'rc', dblclick: 'dc' }[step]
          execFileSync(cliclick, ['-e', '20', `${verb}:${fmt(target)}`, 'w:200'], { encoding: 'utf8' })
          await pause(300)
          out.events = await events('mouse')
          const want = step === 'rclick' ? 'contextmenu' : step === 'dblclick' ? 'dblclick' : 'click'
          out.arrived = out.events.some((e) => e.type === want && e.trusted)
          if (!out.arrived) throw new Error(`ARRIVAL: ${want} 가 앱에 오지 않았다 ${JSON.stringify(out.events)}`)
        }
        await pause(700)
        out.after = await read()
        out.prefs = prefs()
        out.shot = await shot(`${step}-${tag}`)
        break
      }
      case 'altclick': {
        const [hoverSel, clickSel] = rest
        const { expected, origin } = await activate(out)
        const hoverPoint = toScreen(origin, await pointIn(hoverSel, 0.5, 0.5))
        out.guard1 = guard('탐침 전', expected, [hoverPoint])
        out.probe = await probeMove(hoverPoint, 'hover 점')
        await evaluate(ARM_RECORDER)
        execFileSync(cliclick, ['-e', '20', 'kd:alt', `m:${fmt({ x: hoverPoint.x + 1, y: hoverPoint.y })}`, 'w:400'], { encoding: 'utf8' })
        await pause(300)
        const mid = await read()
        out.withAlt = { trash: Object.entries(mid.cards).filter(([, c]) => c.trash).map(([p]) => p) }
        try {
          const clickPoint = toScreen(origin, await pointIn(clickSel, 0.5, 0.5))
          out.guard2 = guard('누르기 직전', expected, [clickPoint])
          execFileSync(cliclick, ['-e', '20', `m:${fmt(clickPoint)}`, 'w:150', `c:${fmt(clickPoint)}`, 'w:200'], { encoding: 'utf8' })
        } finally {
          execFileSync(cliclick, ['ku:alt'], { encoding: 'utf8' })
        }
        await pause(400)
        out.events = await events('mouse')
        out.keys = await events('key')
        out.arrived = out.events.some((e) => e.type === 'click' && e.trusted && e.alt)
        if (!out.arrived) throw new Error(`ARRIVAL: Option 클릭이 앱에 오지 않았다 ${JSON.stringify(out.events)}`)
        out.after = await read()
        out.shot = await shot(`altclick-${tag}`)
        break
      }
      case 'key':
      case 'type': {
        const { expected, origin } = await activate(out)
        const center = toScreen(origin, { x: out.before.win.innerWidth / 2, y: out.before.win.innerHeight / 2 })
        out.guard1 = guard('키 전', expected, [center])
        await evaluate(ARM_RECORDER)
        out.guard2 = guard('키 직전', expected, [center])
        if (step === 'key') {
          const spec = KEYS[rest[0]]
          if (spec === undefined) throw new Error(`키 모름: ${rest[0]}`)
          if (spec.post !== undefined) execFileSync(keypost, spec.post, { encoding: 'utf8' })
          else execFileSync(cliclick, ['-e', '20', ...spec.args, 'w:200'], { encoding: 'utf8' })
          await pause(300)
          out.keys = await events('key')
          out.arrived = out.keys.some((e) => e.trusted && (spec.key === null || e.key === spec.key || e.key.toLowerCase() === spec.key) && (!spec.meta || e.meta) && (!spec.alt || e.alt) && (!spec.shift || e.shift))
        } else {
          // 글자 입력 = 클립보드 붙여넣기(코디 답 msg_2231e631eff4 조건 2) — cliclick t: 는 macOS 길게 누르기 선택기에 키를 먹혔다(stop-incident.md).
          // 클립보드 백업(텍스트만 — 다른 형식이 있으면 멈춘다) → pbcopy → (위 보호 확인 뒤) ⌘V → 입력값 대조 → 클립보드 원복·해시 대조.
          const text = rest[0]
          const info = execFileSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' })
          // 허용 목록(평문 텍스트 형식만, 리뷰 r1 C-06) — 서식·이미지·파일이 하나라도 있으면 텍스트 원복이 그것을 잃는다.
          const clip = clipboardVerdict(info)
          if (clip.kind === 'refuse') throw new Error(clip.reason)
          const backup = execFileSync('pbpaste')
          const backupHash = crypto.createHash('sha256').update(backup).digest('hex')
          fs.writeFileSync(path.join(PRIVATE_DIR, `clipboard-${tag}.bin`), backup, { mode: 0o600 })
          const focusedBefore = await evaluate('document.activeElement?.value ?? null')
          try {
            execFileSync('pbcopy', { input: text })
            out.guard3 = guard('붙여넣기 직전', expected, [center])
            execFileSync(keypost, ['9', 'cmd'], { encoding: 'utf8' })
            await pause(300)
          } finally {
            execFileSync('pbcopy', { input: backup })
          }
          const restoredHash = crypto.createHash('sha256').update(execFileSync('pbpaste')).digest('hex')
          out.clipboard = { backupSha256: backupHash.slice(0, 16), restored: restoredHash === backupHash }
          if (!out.clipboard.restored) throw new Error('클립보드 원복 해시가 다르다')
          out.keys = (await events('key')).filter((e) => e.trusted && e.meta && e.key.toLowerCase() === 'v').length
          const valueAfter = await evaluate('document.activeElement?.value ?? null')
          out.value = { before: focusedBefore, after: valueAfter }
          out.arrived = out.keys >= 1 && typeof valueAfter === 'string' && valueAfter.includes(text)
        }
        if (!out.arrived) throw new Error(`ARRIVAL: 키가 앱에 오지 않았다 ${JSON.stringify(out.keys)}`)
        await pause(600)
        out.after = await read()
        out.prefs = prefs()
        out.shot = await shot(`${step}-${tag}`)
        break
      }
      case 'unfocused': {
        // K2ⓕ (#14545) — 관문이 띄운 TextEdit 새 문서를 맨 앞에. TextEdit 가 원래 떠 있으면(사용자 것) 쓰지 않는다.
        const [selector] = rest
        const already = spawnSync('pgrep', ['-x', 'TextEdit']).status === 0
        if (already) throw new Error('TextEdit 가 이미 떠 있다 — 사용자 앱이라 쓰지 않는다')
        const expected = ourWindow()
        if (expected === null) throw new Error('corral 창이 현재 화면에 없다')
        const { before, origin } = await originOf(expected)
        out.before = before
        const target = toScreen(origin, await pointIn(selector, 0.4, 0.3))
        out.point = target
        // 새 문서 창을 corral 창 오른쪽 아래 구석으로 — 카드 점을 덮지 않게.
        const bounds = { left: expected.bounds.x + expected.bounds.w - 420, top: expected.bounds.y + expected.bounds.h - 300 }
        execFileSync('osascript', ['-e', `tell application "TextEdit" to activate\ntell application "TextEdit" to make new document\ndelay 0.6\ntell application "TextEdit" to set bounds of front window to {${bounds.left}, ${bounds.top}, ${bounds.left + 360}, ${bounds.top + 240}}`], { encoding: 'utf8' })
        await pause(1200)
        const textEdit = Number(execFileSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' }).trim().split('\n')[0])
        out.textEdit = { pid: textEdit, launchedByGate: true, bounds }
        out.guard1 = guard('TextEdit 앞 · 우클릭 전', expected, [target], textEdit)
        out.pageFocusBefore = (await read()).hasFocus
        await evaluate(ARM_RECORDER)
        execFileSync(cliclick, ['-e', '20', `m:${fmt(target)}`, 'w:200', `rc:${fmt(target)}`, 'w:300'], { encoding: 'utf8' })
        await pause(500)
        out.rclickEvents = await events('mouse')
        out.afterRclick = await read()
        out.frontAfterRclick = win('front')
        if (out.afterRclick.cardMenu === null) throw new Error('ARRIVAL: 다른 앱 포커스에서 우클릭 — 카드 메뉴가 안 열렸다')
        // hover 강조 — 메뉴 「경로 복사」 항목 위로 커서만.
        const itemPoint = toScreen(origin, await pointIn('[data-card-menu] [data-menu-action="copy-path"]'))
        execFileSync(cliclick, ['-e', '20', `m:${fmt(itemPoint)}`, 'w:300'], { encoding: 'utf8' })
        await pause(300)
        out.afterHover = (await read()).cardMenu
        // 키보드 — ↓ 한 번(강조가 다음 항목으로).
        execFileSync(cliclick, ['-e', '20', 'kp:arrow-down', 'w:250'], { encoding: 'utf8' })
        await pause(300)
        out.afterDown = (await read()).cardMenu
        out.keys = await events('key')
        out.shot = await shot(`unfocused-${tag}`)
        execFileSync(cliclick, ['-e', '20', 'kp:esc', 'w:200'], { encoding: 'utf8' })
        await pause(300)
        out.afterEsc = (await read()).cardMenu
        // TextEdit 새 문서는 저장하지 않고 닫고 앱을 끝낸다(관문이 띄운 것).
        execFileSync('osascript', ['-e', 'tell application "TextEdit" to close every document saving no\ntell application "TextEdit" to quit'], { encoding: 'utf8' })
        await pause(800)
        out.textEditLeft = spawnSync('pgrep', ['-x', 'TextEdit']).status === 0
        out.verdict = {
          menuOpened: out.afterRclick.cardMenu?.for !== undefined,
          hoverHighlights: out.afterHover?.active === 'copy-path',
          keyboardMoves: out.afterDown?.active !== null && out.afterDown?.active !== out.afterHover?.active,
          escCloses: out.afterEsc === null,
        }
        break
      }
      case 'vscode': {
        // VS Code 창 목록 읽기만(코디 답 조건 4) — 창 이름에 사용자 폴더명이 있어 개수와 「관문 이름(gate-)이 든 창 수」 만 남긴다.
        const pid = Number(execFileSync('pgrep', ['-x', 'Code'], { encoding: 'utf8' }).trim().split('\n')[0])
        const windows = win('windows', pid).filter((w) => w.layer === 0)
        out.vscode = { pid, windows: windows.length, gateWindows: windows.filter((w) => /gate-/.test(w.name ?? '')).length }
        break
      }
      default:
        throw new Error(`단계 모름: ${step}`)
    }
  } catch (error) {
    out.stopped = String(error?.message ?? error)
    save()
    writeLastStep({ root, step, tag, ok: false })
    throw error
  }
  save()
  writeLastStep({ root, step, tag, ok: true })
  log('wrote', file)
}

main().catch((error) => {
  console.error(String(error?.stack ?? error))
  process.exit(1)
})
