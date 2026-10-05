// LIFE-495 G4 네이티브 관문 — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션에서 돈다.
// fixture 워크스페이스(/private/tmp/l495nfx*) 안에서만 탭을 만들고 닫는다. 모든 키 입력은 fixture 셸 pane 에만 간다(assertOnlyFixture).
//
// 입력 경로:
//   · 관문 키(⌘R·⌘⇧T·⌘W·⌘⇧[ ]·⌘⌥[ ]·⌃PgUp/Dn·⌃1–9·⌘T·⌘D·⌃Tab·⌘K·Esc·글자) = CGEvent(keypost — 맨 앞 앱이 이 corral 일 때만, 아니면 보내지 않고 실패로 적는다)
//   · 준비 입력(fixture 셸에 `sleep`·`cd`) = `herdr pane run` — 제품 경로 아님, 관문 대상 아님
//   · 메뉴 열기·항목 누르기·탭 클릭 = 제어 소켓의 좌표 마우스(sendInputEvent — 크로미움이 히트테스트)
// 관측: 렌더러 DOM(eval 읽기) · herdr state(제어 소켓 state) · `herdr pane read`(화면 텍스트) · 선택자 캡처(shots)
// 필수 조건이 하나라도 어긋나면 종료코드 1(lib.requirements). 예외 2.
//
// 사용: node native-t3.mjs <ROOT=/tmp/l495n*> <raw 폴더> <fixture 경로(realpath)> <phase,...>
//   phase: setup · u1k7 · k2 · k3k4 · k5 · k6 · k8e · k9 · persist-check
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { keypost, pause, requirements, run } from './lib.mjs'

const [root, rawd, fixture, phasesArg] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l495n')) throw new Error('ROOT 는 /tmp/l495n*')
if (!fixture?.startsWith('/private/tmp/l495nfx')) throw new Error('fixture 는 /private/tmp/l495nfx*')
const phases = (phasesArg ?? 'setup').split(',')
const ctl = path.join(root, 'ctl.sock')
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
const HERDR = '/opt/homebrew/bin/herdr'
const shotsOut = path.join(rawd, 'shots')
fs.mkdirSync(shotsOut, { recursive: true })
const tag = phases.join('+')
const log = []
const req = requirements((row) => {
  log.push({ at: new Date().toISOString(), ...row })
  save()
  console.log(`[t3] ${row.pass ? '✔' : '✘'} ${row.name}`, JSON.stringify(row).slice(0, 300))
})
const notes = []
const note = (step, detail) => {
  notes.push({ step, at: new Date().toISOString(), ...detail })
  save()
  console.log(`[t3] · ${step}`, JSON.stringify(detail).slice(0, 300))
}
function save() {
  fs.writeFileSync(path.join(rawd, `t3-${tag}.json`), `${JSON.stringify({ phases, appPid, fixture, requirements: log, notes }, null, 1)}\n`)
}

const control = (request, timeout = 30_000) => rpc(ctl, request, timeout)
const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
const herdr = (...args) => {
  try {
    return execFileSync(HERDR, args, { encoding: 'utf8' })
  } catch (error) {
    return `herdr 실패: ${error.message}`
  }
}
const screenOf = (paneId) => herdr('pane', 'read', paneId, '--source', 'visible', '--format', 'text')

async function until(fn, label, timeout = 15_000, every = 150) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}
const soft = (promise) => promise.then((value) => value, () => false)

// --- 상태 읽기 ---------------------------------------------------------------------
async function fixtureWs() {
  const state = (await control({ cmd: 'state' })).state
  for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === fixture) return row.workspace
  return null
}
const fixtureTabIds = async () => (await fixtureWs())?.tabs.map((tab) => tab.tabId) ?? []
/** 화면 — 영역별 탭(시각 순서)·활성·핀·색·편집·× 유무 + 포커스 요소. */
const read = () =>
  evaluate(() => {
    const groups = [...document.querySelectorAll('[data-group-header]')].map((header) => ({
      groupId: header.dataset.groupHeader,
      tabs: [...header.querySelectorAll('[data-main-tab]')].map((tab) => ({
        id: tab.dataset.mainTab,
        active: tab.dataset.active === 'true',
        pinned: tab.dataset.tabPinned === 'true',
        color: tab.dataset.tabColor ?? null,
        dot: tab.querySelector('[data-tab-color-dot]')?.dataset.tabColorDot ?? null,
        pinIcon: tab.querySelector('.main-tab-pin') !== null,
        editing: tab.dataset.tabEditing === 'true',
        hasClose: tab.querySelector('[data-main-tab-close]') !== null,
        label: tab.querySelector('.main-tab-label')?.textContent ?? null,
      })),
    }))
    const el = document.activeElement
    const term = el?.closest?.('[data-term-pane]')?.dataset.termPane ?? null
    return {
      groups,
      focus: { tag: el?.tagName ?? null, cls: (el?.className ?? '').toString().slice(0, 40), termPane: term, rename: el?.dataset?.tabRename ?? null },
      modal: document.querySelector('[data-confirm-close-modal]') === null ? null : {
        kind: document.querySelector('[data-confirm-close-modal]').dataset.confirmCloseKind,
        title: document.querySelector('[data-confirm-close-title]')?.textContent ?? null,
        body: [...document.querySelectorAll('[data-confirm-close-body]')].map((node) => node.textContent),
        tabs: [...document.querySelectorAll('[data-confirm-close-tab]')].map((node) => node.textContent),
        fg: [...document.querySelectorAll('[data-confirm-close-fg] .modal-code-block')].map((node) => node.textContent),
        ok: document.querySelector('[data-close-confirm-ok]')?.textContent ?? null,
      },
      mark: window.__l495mark ?? null,
    }
  })

async function assertOnlyFixture() {
  const mine = new Set(await fixtureTabIds())
  const dom = await evaluate(() => [...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab))
  if (dom.length === 0 || !dom.every((id) => mine.has(id))) throw new Error('화면에 fixture 밖 탭이 있다 — 멈춘다')
}
async function shot(name, selector) {
  try {
    const res = await control({ cmd: 'shot', name: `l495-${name}`, ...(selector === undefined ? {} : { selector }) })
    if (!res.ok || !res.file) return null
    const target = path.join(shotsOut, `${name}.png`)
    fs.copyFileSync(res.file, target)
    return path.relative(rawd, target)
  } catch {
    return null
  }
}

// --- 입력 ---------------------------------------------------------------------------
const KEY = { ' ': 49, b: 11, f: 3, g: 5, h: 4, i: 34, j: 38, m: 46, c: 8, v: 9, q: 12, e: 14, o: 31, p: 35, y: 16, a: 0, s: 1, d: 2, k: 40, r: 15, t: 17, w: 13, u: 32, l: 37, x: 7, n: 45, '[': 33, ']': 30, esc: 53, enter: 36, tab: 48, pgup: 116, pgdn: 121, 1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25 }
/** CGEvent 한 번 — 먼저 corral 을 맨 앞으로. 보호(맨 앞 앱 ≠ corral)에 걸리면 보내지 않는다. */
async function key(name, mods = []) {
  const front = run('activate', [appPid])
  await pause(120)
  const sent = keypost({ pid: appPid, keycode: KEY[name], mods })
  await pause(250)
  return { key: name, mods, sent: sent.parsed?.sent === true, front: front.out, code: sent.code }
}
/** 글자 몇 개를 CGEvent 로(포커스된 곳이 받는다). */
async function typeKeys(text) {
  const out = []
  for (const ch of text) out.push((await key(ch)).sent)
  return out.every(Boolean)
}
async function rightClickTab(tabId) {
  const rect = (await control({ cmd: 'rect', selector: `[data-main-tab="${tabId}"]` })).rect
  const x = Math.round(rect.left + Math.min(40, rect.width / 2))
  const y = Math.round(rect.top + rect.height / 2)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x, y, button: 'right' })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x, y, button: 'right' })
  await until(async () => evaluate((id) => document.querySelector(`[data-tab-menu="${id}"]`) !== null, tabId), '메뉴 열림', 5_000)
}
async function menuItem(selector) {
  const disabled = await evaluate((sel) => document.querySelector(sel)?.dataset.disabled ?? null, selector)
  const clicked = await control({ cmd: 'click', selector })
  await pause(300)
  return { disabled, clicked: clicked.ok === true }
}
async function newTab() {
  const before = new Set(await fixtureTabIds())
  const sent = await key('t', ['cmd'])
  const id = await until(async () => (await fixtureTabIds()).find((tabId) => !before.has(tabId)) ?? null, '새 탭(⌘T)')
  await until(async () => (await read()).groups.some((group) => group.tabs.some((tab) => tab.id === id && tab.active)), '새 탭 활성')
  return { id, sent: sent.sent }
}
const paneOf = async (tabId) => (await fixtureWs())?.tabs.find((tab) => tab.tabId === tabId)?.panes ?? []
async function closeModal(confirm) {
  await control({ cmd: 'click', selector: confirm ? '[data-close-confirm-ok]' : '[data-close-confirm-cancel]' })
  await until(async () => (await read()).modal === null, '모달 닫힘', 10_000)
}
/** 화면의 fixture 탭이 n 개가 되게 맞춘다(⌘T 로 늘리고, 실행 중 없는 셸 탭을 × 로 줄인다). */
async function ensureTabs(count) {
  while ((await fixtureTabIds()).length < count) await newTab()
  for (;;) {
    const ids = await fixtureTabIds()
    if (ids.length <= count) break
    const screen = await read()
    const victim = screen.groups.flatMap((group) => group.tabs).reverse().find((tab) => tab.hasClose)
    if (victim === undefined) break
    await control({ cmd: 'click', selector: `[data-main-tab-close="${victim.id}"]` })
    await pause(400)
    if ((await read()).modal !== null) await closeModal(true)
    await until(async () => !(await fixtureTabIds()).includes(victim.id), `탭 닫기 ${victim.id}`)
  }
}

/**
 * fixture 셸에 명령 한 줄 — 그 탭을 눌러 활성으로 만든 뒤 CGEvent 로 친다(Enter 포함). 실행 중 판정은 herdr process-info 로 확인.
 * `herdr pane run` 은 r2 에서 bracketed paste 가 zsh 에 `[200~sleep` 로 들어가 실패했다(t3-k3k4.log) — 준비 입력도 타이핑으로 바꿨다.
 */
async function shellLine(tabId, line, expectProcess = null) {
  await control({ cmd: 'click', selector: `[data-main-tab="${tabId}"]` })
  await pause(500)
  const pane = (await paneOf(tabId))[0]?.paneId
  await typeKeys(line)
  await key('enter')
  if (expectProcess === null) return { pane, ok: true }
  const ok = await soft(until(() => JSON.stringify(JSON.parse(herdr('pane', 'process-info', '--pane', pane)).result.process_info.foreground_processes.map((proc) => proc.name)).includes(expectProcess), `${expectProcess} 실행`, 6_000, 300))
  return { pane, ok: ok === true }
}

/** 앞 phase 가 남긴 핀을 푼다(자리 기대값을 단순하게) — 메뉴 「탭 고정 해제」로. */
async function unpinAll() {
  for (const tab of (await read()).groups.flatMap((group) => group.tabs).filter((row) => row.pinned)) {
    await rightClickTab(tab.id)
    await menuItem(`[data-tab-menu-pin="${tab.id}"]`)
  }
}

async function openFixture() {
  await control({ cmd: 'add-repo', root: fixture })
  await control({ cmd: 'rebuild-tree' })
  await until(async () => ((await control({ cmd: 'query', selector: `[data-worktree="${fixture}"]` })).found ?? []).length > 0, 'fixture 카드')
  let clicks = 0
  await until(async () => {
    const mine = new Set(await fixtureTabIds())
    const dom = await evaluate(() => [...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab))
    if (mine.size > 0 && dom.length > 0 && dom.every((id) => mine.has(id))) return true
    if (clicks < 6) {
      clicks += 1
      await control({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
      await pause(1500)
    }
    return false
  }, 'fixture 화면', 40_000, 500)
  return clicks
}
/** 활성 터미널에 마커 글자를 CGEvent 로 쳐서 그 pane 화면에 나오는지(K8ⓔ) — 끝나면 Ctrl+U 로 지운다. */
async function typedInto(expectPane, marker) {
  const screen = await read()
  const focusOk = screen.focus.termPane === expectPane && screen.focus.cls.includes('xterm-helper-textarea')
  const sent = await typeKeys(marker)
  const shown = await soft(until(async () => screenOf(expectPane).includes(marker), `마커 ${marker}`, 5_000))
  await key('u', ['ctrl'])
  return { focus: screen.focus, focusOk, sent, shown: shown === true }
}
const activePane = async () => (await read()).focus.termPane

// --- 단계 -------------------------------------------------------------------------
async function phaseSetup() {
  const clicks = await openFixture()
  await ensureTabs(5)
  await assertOnlyFixture()
  const screen = await read()
  note('setup', { cardClicks: clicks, groups: screen.groups.map((group) => ({ groupId: group.groupId, tabs: group.tabs.map((tab) => tab.id) })) })
  req.require('setup-fixture-5-tabs', screen.groups.flatMap((group) => group.tabs).length === 5, { groups: screen.groups.length })
}

/** U1 실측 + K7 단축키(영문·한글) + ⌘R(창 새로고침 없음) + 메뉴 가속키 덤프. */
async function phaseU1K7() {
  await assertOnlyFixture()
  const original = run('inputsource', ['current']).out
  note('input-source-original', { original })
  const keyLog = () => evaluate(() => (window.__l495keys ?? []).splice(0))
  await evaluate(() => {
    if (window.__l495keys) return
    window.__l495keys = []
    // 창 캡처 — 단축키 처리기(document 캡처)보다 먼저 본다. 읽기만 한다.
    window.addEventListener('keydown', (event) => window.__l495keys.push({ key: event.key, code: event.code, keyCode: event.keyCode, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey, ctrl: event.ctrlKey, isComposing: event.isComposing, repeat: event.repeat, target: (event.target?.className ?? '').toString().slice(0, 30) }), true)
  })
  const cases = [
    { name: '⌘⇧]', key: ']', mods: ['cmd', 'shift'], dir: 1 },
    { name: '⌘⇧[', key: '[', mods: ['cmd', 'shift'], dir: -1 },
    { name: '⌘⌥]', key: ']', mods: ['cmd', 'alt'], dir: 1 },
    { name: '⌘⌥[', key: '[', mods: ['cmd', 'alt'], dir: -1 },
    { name: '⌃PgDn', key: 'pgdn', mods: ['ctrl'], dir: 1 },
    { name: '⌃PgUp', key: 'pgup', mods: ['ctrl'], dir: -1 },
    { name: '⌃1', key: 1, mods: ['ctrl'], index: 0 },
    { name: '⌃3', key: 3, mods: ['ctrl'], index: 2 },
    { name: '⌃9(없음)', key: 9, mods: ['ctrl'], index: 8 },
  ]
  const u1 = []
  for (const source of ['com.apple.keylayout.ABC', 'com.apple.inputmethod.Korean.2SetKorean']) {
    const selected = run('inputsource', ['select', source])
    note(`input-source-${source}`, { selected: selected.out })
    // 활성 탭에 포커스를 둔다(xterm 포커스 중에도 동작해야 한다 — K7ⓔ).
    const start = (await read()).groups[0]
    await control({ cmd: 'click', selector: `[data-main-tab="${start.tabs[1].id}"]` })
    await pause(500)
    for (const one of cases) {
      const before = await read()
      const group = before.groups.find((row) => row.tabs.some((tab) => tab.active)) ?? before.groups[0]
      const order = group.tabs.map((tab) => tab.id)
      const activeIndex = order.findIndex((id) => group.tabs.find((tab) => tab.id === id)?.active)
      const expected = one.index !== undefined ? (order[one.index] ?? order[activeIndex]) : order[(activeIndex + one.dir + order.length) % order.length]
      const focusBefore = before.focus
      const sent = await key(one.key, one.mods)
      await pause(300)
      const after = await read()
      const nowActive = after.groups.flatMap((row) => row.tabs).find((tab) => tab.active && group.tabs.some((t) => t.id === tab.id))?.id ?? null
      const events = await keyLog()
      const row = { source, case: one.name, sent: sent.sent, focusBefore, expected, nowActive, focusAfter: after.focus, keydown: events.filter((event) => !['Meta', 'Shift', 'Alt', 'Control'].includes(event.key)) }
      u1.push(row)
      req.require(`k7-${source.includes('Korean') ? 'ko' : 'en'}-${one.name}`, sent.sent && nowActive === expected && focusBefore.cls.includes('xterm-helper-textarea'), { expected, nowActive, focusBefore: focusBefore.cls })
    }
  }
  fs.writeFileSync(path.join(rawd, 'u1-keydown.json'), `${JSON.stringify(u1, null, 1)}\n`)

  // ⌘R — 활성 탭 이름 편집이 열리고 창이 새로고침되지 않는다(마커가 남는다). 영문·한글 각각.
  for (const source of ['com.apple.keylayout.ABC', 'com.apple.inputmethod.Korean.2SetKorean']) {
    run('inputsource', ['select', source])
    await evaluate(() => { window.__l495mark = `m${Date.now()}` })
    const mark = (await read()).mark
    const before = await read()
    const activeId = before.groups.flatMap((group) => group.tabs).find((tab) => tab.active)?.id
    const sent = await key('r', ['cmd'])
    const after = await soft(until(async () => { const s = await read(); return s.groups.flatMap((group) => group.tabs).find((tab) => tab.editing) ? s : null }, '⌘R 편집', 4_000))
    const screen = after === false ? await read() : after
    const editing = screen.groups.flatMap((group) => group.tabs).find((tab) => tab.editing)?.id ?? null
    req.require(`k7-cmdR-${source.includes('Korean') ? 'ko' : 'en'}`, sent.sent && editing === activeId && screen.mark === mark && screen.focus.rename === activeId, { activeId, editing, markKept: screen.mark === mark, focus: screen.focus })
    await key('esc')
    await pause(300)
    const back = await read()
    req.require(`k7-cmdR-esc-returns-terminal-${source.includes('Korean') ? 'ko' : 'en'}`, back.groups.flatMap((group) => group.tabs).every((tab) => !tab.editing) && back.focus.cls.includes('xterm-helper-textarea'), { focus: back.focus })
  }
  // 타이핑 phase 들을 위해 ABC 로 돌려 둔다 — 사용자 원래 입력기는 main 이 끝에 되돌린다.
  run('inputsource', ['select', 'com.apple.keylayout.ABC'])

  // 메뉴 가속키 — 기본 메뉴는 그대로(⌘R 은 메뉴에 남아 있고 main 이 가로챈다). 덤프만.
  const menu = await control({ cmd: 'menu-dump' })
  fs.writeFileSync(path.join(rawd, 'menu-dump.json'), `${JSON.stringify(menu, null, 1)}\n`)
}

/** K2 — 다른/오른쪽/왼쪽 탭 닫기, 실행 중 섞인 회차는 모달 한 번(취소 = 하나도 안 닫힘). */
async function phaseK2() {
  await ensureTabs(5)
  await unpinAll()
  await assertOnlyFixture()
  const tabs = () => read().then((screen) => screen.groups[0].tabs.map((tab) => tab.id))
  let order = await tabs()
  // ① 오른쪽 탭 닫기 + 실행 중(sleep) 섞임 → 모달 한 번 → 취소 → 하나도 안 닫힘.
  const busy = order[2]
  const busyRun = await shellLine(busy, 'sleep 600', 'sleep')
  note('k2-busy', busyRun)
  await rightClickTab(order[0])
  const right1 = await menuItem(`[data-tab-menu-close-right="${order[0]}"]`)
  const modal1 = await soft(until(async () => (await read()).modal, '모달(오른쪽, 실행 중)', 10_000))
  const modalShot = modal1 === false ? null : await shot('k2-close-right-running-modal', '[data-confirm-close-modal]')
  if (modal1 !== false) await closeModal(false)
  await pause(500)
  const afterCancel = await tabs()
  req.require('k2-right-running-one-modal-cancel-keeps-all', right1.disabled === 'false' && modal1 !== false && modal1.kind === 'command' && modal1.tabs.length === 1 && afterCancel.length === 5, { modal: modal1, afterCancel, shot: modalShot })
  // ② 같은 것을 확인 → 오른쪽 4개 닫힘, 기준 탭은 남고 활성.
  await rightClickTab(order[0])
  await menuItem(`[data-tab-menu-close-right="${order[0]}"]`)
  const modal2 = await soft(until(async () => (await read()).modal, '모달(오른쪽, 실행 중) 2', 10_000))
  if (modal2 !== false) await closeModal(true)
  await soft(until(async () => (await fixtureTabIds()).length === 1, '오른쪽 4개 닫힘', 15_000))
  const afterRight = await read()
  req.require('k2-close-right-confirmed', modal2 !== false && afterRight.groups[0].tabs.map((tab) => tab.id).join() === order[0] && afterRight.groups[0].tabs[0].active, { left: afterRight.groups[0].tabs.map((tab) => tab.id) })
  // ③ 왼쪽 탭 닫기(실행 중 없음 → 모달 없음).
  await ensureTabs(4)
  order = await tabs()
  await rightClickTab(order[3])
  const left = await menuItem(`[data-tab-menu-close-left="${order[3]}"]`)
  await soft(until(async () => (await fixtureTabIds()).length === 1, '왼쪽 3개 닫힘', 15_000))
  const afterLeft = await read()
  req.require('k2-close-left-no-modal', left.disabled === 'false' && afterLeft.modal === null && afterLeft.groups[0].tabs.map((tab) => tab.id).join() === order[3], { left: afterLeft.groups[0].tabs.map((tab) => tab.id) })
  // ④ 다른 탭 닫기 — 핀 탭은 남는다.
  await ensureTabs(4)
  order = await tabs()
  await rightClickTab(order[1])
  await menuItem(`[data-tab-menu-pin="${order[1]}"]`)
  await pause(400)
  order = await tabs()
  const pinnedId = (await read()).groups[0].tabs.find((tab) => tab.pinned)?.id
  const anchor = order[2]
  await rightClickTab(anchor)
  const others = await menuItem(`[data-tab-menu-close-others="${anchor}"]`)
  await soft(until(async () => (await fixtureTabIds()).length === 2, '다른 탭 닫힘(핀 남음)', 15_000))
  const afterOthers = await read()
  const leftIds = afterOthers.groups[0].tabs.map((tab) => tab.id)
  req.require('k2-close-others-keeps-pinned', others.disabled === 'false' && leftIds.length === 2 && leftIds.includes(pinnedId) && leftIds.includes(anchor), { leftIds, pinnedId, anchor })
  // ⑤ 이제 핀 1 + 기준 1 — 다른 탭 닫기는 닫을 대상이 없어 비활성.
  await rightClickTab(anchor)
  const othersDisabled = await evaluate((id) => document.querySelector(`[data-tab-menu-close-others="${id}"]`)?.dataset.disabled, anchor)
  await key('esc')
  req.require('k2-others-disabled-when-only-pinned-left', othersDisabled === 'true', { othersDisabled })
  // 정리 — 핀 풀기.
  await rightClickTab(pinnedId)
  await menuItem(`[data-tab-menu-pin="${pinnedId}"]`)
}

/** K3·K4·K5 — 핀(아이콘·× 없음·중클릭 무시·접두부·⌘W 확인)·색(점·swatch)·실행 중 문구. 재시작 유지는 persist-check. */
async function phaseK3K4() {
  await ensureTabs(4)
  await unpinAll()
  await assertOnlyFixture()
  let screen = await read()
  const order = screen.groups[0].tabs.map((tab) => tab.id)
  // 핀 — 셋째 탭을 고정 → 맨 앞(핀 구간 끝)으로.
  await rightClickTab(order[2])
  const pinItem = await menuItem(`[data-tab-menu-pin="${order[2]}"]`)
  screen = await read()
  const after = screen.groups[0].tabs
  req.require('k3-pin-moves-to-prefix-with-icon-no-close', pinItem.clicked && after[0].id === order[2] && after[0].pinned && after[0].pinIcon && !after[0].hasClose, { order: after.map((tab) => `${tab.id}${tab.pinned ? '*' : ''}`) })
  const pinShot = await shot('k3-pinned-tab', `[data-group-header="${screen.groups[0].groupId}"]`)
  // 중클릭 무시.
  const rect = (await control({ cmd: 'rect', selector: `[data-main-tab="${order[2]}"]` })).rect
  const mx = Math.round(rect.left + rect.width / 2)
  const my = Math.round(rect.top + rect.height / 2)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: mx, y: my, button: 'middle' })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: mx, y: my, button: 'middle' })
  await pause(600)
  req.require('k3-middle-click-ignored', (await fixtureTabIds()).includes(order[2]) && (await read()).modal === null, { shot: pinShot })
  // 메뉴 「닫기」 비활성.
  await rightClickTab(order[2])
  const closeDisabled = await evaluate((id) => document.querySelector(`[data-tab-menu-close="${id}"]`)?.dataset.disabled, order[2])
  await key('esc')
  req.require('k3-menu-close-disabled', closeDisabled === 'true', {})
  // 드래그 — 핀 탭을 핀 아닌 탭 뒤로 끌어도 경계에 붙는다(접두부). 좌표 마우스(useTabDrag 의 mousedown/move/up).
  const first = (await control({ cmd: 'rect', selector: `[data-main-tab="${order[2]}"]` })).rect
  const last = (await control({ cmd: 'rect', selector: `[data-main-tab="${order[3]}"]` })).rect
  const sx = Math.round(first.left + 30)
  const sy = Math.round(first.top + first.height / 2)
  const tx = Math.round(last.left + last.width - 10)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: sx, y: sy })
  for (let step = 1; step <= 8; step += 1) await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(sx + ((tx - sx) * step) / 8), y: sy })
  await pause(150)
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: tx, y: sy })
  await pause(600)
  const dragged = (await read()).groups[0].tabs
  req.require('k3-drag-pinned-past-boundary-clamps', dragged[0].id === order[2] && dragged[0].pinned, { order: dragged.map((tab) => `${tab.id}${tab.pinned ? '*' : ''}`) })
  // 색 — 둘째 탭(핀 아님)을 초록으로 → 제목 뒤 점, swatch 선택 표시.
  const colorTab = dragged[1].id
  await rightClickTab(colorTab)
  await menuItem(`[data-tab-menu-color="#22c55e"]`)
  screen = await read()
  const colored = screen.groups[0].tabs.find((tab) => tab.id === colorTab)
  const dotShot = await shot('k4-color-dot', `[data-main-tab="${colorTab}"]`)
  await rightClickTab(colorTab)
  const selected = await evaluate(() => document.querySelector('[data-tab-menu-color="#22c55e"]')?.dataset.selected)
  const menuShot = await shot('k1-menu-full', '.tab-context-menu')
  await key('esc')
  req.require('k4-color-dot-and-swatch-selected', colored?.dot === '#22c55e' && selected === 'true', { colored, shots: [dotShot, menuShot] })
  // ⌘W 로 핀 탭 닫기 → 핀 확인(실행 중 아님) → 취소 → 남음.
  await control({ cmd: 'click', selector: `[data-main-tab="${order[2]}"]` })
  await pause(500)
  await key('w', ['cmd'])
  const pinModal = await soft(until(async () => (await read()).modal, '핀 닫기 확인', 8_000))
  const pinModalShot = pinModal === false ? null : await shot('k3-pinned-close-modal', '[data-confirm-close-modal]')
  if (pinModal !== false) await closeModal(false)
  req.require('k3-cmdW-pinned-asks-once-cancel-keeps', pinModal !== false && pinModal.kind === 'pinned' && (await fixtureTabIds()).includes(order[2]), { modal: pinModal, shot: pinModalShot })
  // 핀 + 실행 중 → 창 한 번(실행 중 문구 + 고정 안내) → 확인 → 닫힘(K5 실행 중 문구 캡처 겸).
  const pinRun = await shellLine(order[2], 'sleep 600', 'sleep')
  note('k3-pinned-busy', pinRun)
  await control({ cmd: 'click', selector: `[data-main-tab="${order[2]}"]` })
  await pause(400)
  await key('w', ['cmd'])
  const bothModal = await soft(until(async () => (await read()).modal, '핀+실행 중 확인', 8_000))
  const bothShot = bothModal === false ? null : await shot('k5-pinned-running-modal', '[data-confirm-close-modal]')
  if (bothModal !== false) await closeModal(true)
  await soft(until(async () => !(await fixtureTabIds()).includes(order[2]), '핀+실행 중 탭 닫힘', 10_000))
  req.require('k3-k5-pinned-running-one-modal-command-copy', bothModal !== false && bothModal.kind === 'command' && bothModal.title === '실행 중인 명령을 멈출까' && bothModal.ok === '멈추고 닫기' && bothModal.body.includes('이 탭은 고정돼 있다.') && !(await fixtureTabIds()).includes(order[2]), { modal: bothModal, shot: bothShot })
  // 재시작 유지용 — 첫 탭 고정 + 색(파랑). persist-check 가 재기동 뒤 본다.
  await ensureTabs(3)
  const keep = (await read()).groups[0].tabs.find((tab) => !tab.pinned)?.id
  await rightClickTab(keep)
  await menuItem(`[data-tab-menu-pin="${keep}"]`)
  await rightClickTab(keep)
  await menuItem(`[data-tab-menu-color="#3b82f6"]`)
  const marks = await evaluate(() => null)
  const final = await read()
  fs.writeFileSync(path.join(root, 'persist-expect.json'), JSON.stringify({ tabId: keep, color: '#3b82f6', colorTab, colorTabColor: '#22c55e' }))
  note('persist-expect', { keep, marks, tabs: final.groups[0].tabs })
}

/** 재기동 뒤 — 핀·색이 남아 있다(K3ⓔ·K4ⓒ). */
async function phasePersistCheck() {
  const expect = JSON.parse(fs.readFileSync(path.join(root, 'persist-expect.json'), 'utf8'))
  await openFixture()
  await pause(800)
  const screen = await read()
  const tabs = screen.groups.flatMap((group) => group.tabs)
  const kept = tabs.find((tab) => tab.id === expect.tabId)
  const colored = tabs.find((tab) => tab.id === expect.colorTab)
  const persistShot = await shot('k3-k4-after-restart', `[data-group-header="${screen.groups[0].groupId}"]`)
  // K6ⓒⓔ — 기록은 비영속: 재기동 뒤 ⌘⇧T 는 아무것도 안 한다.
  const count = (await fixtureTabIds()).length
  const sent = await key('t', ['cmd', 'shift'])
  await pause(1500)
  req.require('k6-not-persistent-empty-noop-after-restart', sent.sent && (await fixtureTabIds()).length === count, { count })
  req.require('k3-k4-persist-after-corral-restart', kept?.pinned === true && kept?.dot === expect.color && (colored === undefined || expect.colorTab === expect.tabId || colored.dot === expect.colorTabColor), { kept, colored, shot: persistShot })
}

/** K6 — 닫기 → ⌘⇧T → 같은 cwd·이름·색·자리(영역·순번). */
async function phaseK6() {
  await ensureTabs(4)
  await assertOnlyFixture()
  let screen = await read()
  // 핀 정리(재시작 회차가 남긴 것) — 자리 계산을 단순하게.
  for (const tab of screen.groups[0].tabs.filter((row) => row.pinned)) {
    await rightClickTab(tab.id)
    await menuItem(`[data-tab-menu-pin="${tab.id}"]`)
  }
  screen = await read()
  const order = screen.groups[0].tabs.map((tab) => tab.id)
  const target = order[2]
  fs.mkdirSync(path.join(fixture, 'subdir'), { recursive: true })
  await shellLine(target, 'cd subdir')
  await soft(until(async () => (await paneOf(target))[0]?.cwd === path.join(fixture, 'subdir'), 'cwd 반영', 8_000))
  // 이름(⌘R 로 편집 → 글자는 CGEvent) · 색(보라).
  await control({ cmd: 'click', selector: `[data-main-tab="${target}"]` })
  await pause(500)
  await key('r', ['cmd'])
  await until(async () => (await read()).focus.rename === target, '편집 열림', 4_000)
  await key('a', ['cmd'])
  await typeKeys('l495k6')
  await key('enter')
  await soft(until(async () => (await fixtureWs())?.tabs.find((tab) => tab.tabId === target)?.label === 'l495k6', '이름', 6_000))
  await rightClickTab(target)
  await menuItem(`[data-tab-menu-color="#a855f7"]`)
  const before = { cwd: (await paneOf(target))[0]?.cwd, label: (await fixtureWs())?.tabs.find((tab) => tab.tabId === target)?.label, index: (await read()).groups[0].tabs.findIndex((tab) => tab.id === target) }
  // ⌘W 닫기(셸, 실행 중 아님 → 모달 없음).
  await control({ cmd: 'click', selector: `[data-main-tab="${target}"]` })
  await pause(400)
  await key('w', ['cmd'])
  await until(async () => !(await fixtureTabIds()).includes(target), '⌘W 닫힘', 8_000)
  // 이동 — 활성 탭을 다른 탭으로(자리 복원이 활성 영역 끝이 아님을 보이려고 첫 탭 활성).
  await control({ cmd: 'click', selector: `[data-main-tab="${order[0]}"]` })
  await pause(400)
  const ids = new Set(await fixtureTabIds())
  const sent = await key('t', ['cmd', 'shift'])
  const reopened = await soft(until(async () => (await fixtureTabIds()).find((id) => !ids.has(id)) ?? null, '⌘⇧T 새 탭', 10_000))
  await pause(1200)
  const after = await read()
  const row = reopened === false ? null : after.groups[0].tabs.find((tab) => tab.id === reopened)
  const state = reopened === false ? null : (await fixtureWs())?.tabs.find((tab) => tab.tabId === reopened)
  const cwd = state?.panes[0]?.cwd ?? null
  const reopenShot = await shot('k6-reopened', `[data-group-header="${after.groups[0].groupId}"]`)
  req.require('k6-reopen-same-cwd-label-color-position', sent.sent && reopened !== false && state?.label === 'l495k6' && cwd === before.cwd && row?.dot === '#a855f7' && after.groups[0].tabs.findIndex((tab) => tab.id === reopened) === before.index && row?.active === true, { before, reopened, label: state?.label, cwd, dot: row?.dot, index: after.groups[0].tabs.findIndex((tab) => tab.id === reopened), shot: reopenShot })
  // 「비어 있으면 아무것도 안 한다」는 여기서 보지 않는다 — 앞 phase(k2·k3k4)의 사용자 닫기가 스택에 남아 있다(r2 첫 회차가 그걸 실패로 셌다,
  // 제품이 아니라 드라이버 기대값 오류). 재기동 뒤(비영속 → 빈 스택) persist-check 에서 본다.
}

/** K8ⓔ — 전환 뒤 터미널이 키를 받는다(CGEvent 글자 → 그 pane 화면). */
async function phaseK8e() {
  await ensureTabs(3)
  await assertOnlyFixture()
  const order = (await read()).groups[0].tabs.map((tab) => tab.id)
  const check = async (name, expectPaneFn, marker) => {
    await pause(500)
    const pane = await expectPaneFn()
    const result = await typedInto(pane, marker)
    req.require(`k8e-${name}`, result.focusOk && result.sent && result.shown, { pane, ...result })
  }
  const firstPane = async (tabId) => (await paneOf(tabId))[0]?.paneId
  // 탭 클릭 전환
  await control({ cmd: 'click', selector: `[data-main-tab="${order[1]}"]` })
  await check('tab-click', () => firstPane(order[1]), 'lxa')
  // ⌘T 새 탭
  const created = await newTab()
  await check('cmdT-new-tab', () => firstPane(created.id), 'lxb')
  // ⌘D 분할 → 새 pane
  const panesBefore = (await paneOf(created.id)).map((pane) => pane.paneId)
  await key('d', ['cmd'])
  const newPane = await until(async () => (await paneOf(created.id)).map((pane) => pane.paneId).find((id) => !panesBefore.includes(id)) ?? null, '⌘D 새 pane')
  await check('cmdD-split', async () => newPane, 'lxc')
  // ⌘W(pane ≥2) → 남은 pane
  await key('w', ['cmd'])
  await until(async () => (await paneOf(created.id)).length === 1, '⌘W pane 닫힘')
  await check('cmdW-remaining-pane', () => firstPane(created.id), 'lxd')
  // MRU 확정(⌃Tab — keypost 가 ⌃ 를 떼면 확정). 탭 클릭 두 번으로 기록을 분명히 만든 뒤 잰다 — ⌘W(분할 pane 닫기) 직후에는
  // 두 빌드 모두 기록 맨 앞이 화면의 pane 이 아니라서(r2 mru-diag, 기존 동작) ⌃Tab 이 화면상 안 움직일 수 있다.
  await control({ cmd: 'click', selector: `[data-main-tab="${order[1]}"]` })
  await pause(600)
  const previous = await activePane()
  await control({ cmd: 'click', selector: `[data-main-tab="${created.id}"]` })
  await pause(600)
  const beforeMru = await activePane()
  await key('tab', ['ctrl'])
  await pause(600)
  const afterMru = await activePane()
  req.require('k8e-mru-moved', afterMru !== null && afterMru === previous && afterMru !== beforeMru, { previous, beforeMru, afterMru })
  await check('mru-commit', async () => afterMru, 'lxe')
  // 팔레트 닫기(⌘K → Esc)
  await key('k', ['cmd'])
  await soft(until(async () => evaluate(() => document.querySelector('[data-command-palette]') !== null), '팔레트', 4_000))
  await key('esc')
  await until(async () => evaluate(() => document.querySelector('[data-command-palette]') === null), '팔레트 닫힘', 4_000)
  await check('palette-close', activePane, 'lxf')
  // ⌃1
  await key(1, ['ctrl'])
  await check('ctrl1', async () => firstPane((await read()).groups[0].tabs[0].id), 'lxg')
  // ⌘⇧]
  await key(']', ['cmd', 'shift'])
  await check('cmdShiftBracket', async () => firstPane((await read()).groups[0].tabs[1].id), 'lxh')
  // 정리 — 만든 탭 닫기
  await ensureTabs(3)
}

/** K9 스모크 — × 닫기·중클릭 닫기·드래그 재정렬·`+` 메뉴·넘침 chevron. */
async function phaseK9() {
  await ensureTabs(4)
  await assertOnlyFixture()
  let order = (await read()).groups[0].tabs.map((tab) => tab.id)
  // 드래그 재정렬: 첫 탭 → 끝.
  const a = (await control({ cmd: 'rect', selector: `[data-main-tab="${order[0]}"]` })).rect
  const z = (await control({ cmd: 'rect', selector: `[data-main-tab="${order[3]}"]` })).rect
  const sx = Math.round(a.left + 30)
  const sy = Math.round(a.top + a.height / 2)
  const tx = Math.round(z.left + z.width - 8)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: sx, y: sy })
  for (let step = 1; step <= 8; step += 1) await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(sx + ((tx - sx) * step) / 8), y: sy })
  await pause(150)
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: tx, y: sy })
  await pause(600)
  const dragged = (await read()).groups[0].tabs.map((tab) => tab.id)
  req.require('k9-drag-reorder', dragged.at(-1) === order[0], { before: order, after: dragged })
  // × 닫기
  order = dragged
  await control({ cmd: 'click', selector: `[data-main-tab-close="${order[1]}"]` })
  await soft(until(async () => !(await fixtureTabIds()).includes(order[1]), '× 닫힘', 8_000))
  req.require('k9-x-close', !(await fixtureTabIds()).includes(order[1]), {})
  // 중클릭 닫기(핀 아님)
  const mid = (await control({ cmd: 'rect', selector: `[data-main-tab="${order[2]}"]` })).rect
  const mx = Math.round(mid.left + mid.width / 2)
  const my = Math.round(mid.top + mid.height / 2)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: mx, y: my, button: 'middle' })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: mx, y: my, button: 'middle' })
  await soft(until(async () => !(await fixtureTabIds()).includes(order[2]), '중클릭 닫힘', 8_000))
  req.require('k9-middle-click-close', !(await fixtureTabIds()).includes(order[2]), {})
  // `+` 메뉴 열고 Esc
  const group = (await read()).groups[0].groupId
  await control({ cmd: 'click', selector: `[data-main-tabbar-add="${group}"]` })
  const plusOpen = await soft(until(async () => evaluate(() => document.querySelector('[data-tab-create-menu]') !== null), '+ 메뉴', 4_000))
  await key('esc')
  req.require('k9-plus-menu-opens', plusOpen === true, {})
  // 넘침 — 탭을 늘리면 chevron 이 생긴다.
  await ensureTabs(14)
  const chevron = await evaluate(() => document.querySelector('[data-tab-strip-chevron]') !== null)
  const overflowShot = await shot('k9-overflow', `[data-group-header="${group}"]`)
  req.require('k9-overflow-chevron', chevron === true, { shot: overflowShot })
  await ensureTabs(3)
}

/** K7ⓐ 회귀 — 기본 메뉴의 다른 가속키(⌘⇧R·⌘A·⌘C·⌘V). 같은 phase 를 base 빌드에서도 돌려 대조한다. ⌘Q 는 quit phase. */
async function phaseMenuKeys() {
  await ensureTabs(3)
  await assertOnlyFixture()
  const clipBefore = run('clip', ['dump']).out
  const textBefore = run('clip', ['get-text']).out
  note('clipboard-before', { dump: clipBefore, text: textBefore })
  // 터미널에 포커스를 둔다 — r2 첫 회차는 포커스가 BODY 라 ⌘A 가 문서 전체를 골랐다(t3-menukeys.log).
  const activeId = (await read()).groups.flatMap((group) => group.tabs).find((tab) => tab.active)?.id
  await control({ cmd: 'click', selector: `[data-main-tab="${activeId}"]` })
  await until(async () => (await read()).focus.cls.includes('xterm-helper-textarea'), '터미널 포커스', 5_000)
  const pane = await activePane()
  // ⌘A → ⌘C — 터미널에 친 글자가 클립보드로 가는지(관측). base 와 같은 결과면 회귀 아님.
  await typeKeys('lxcopy')
  await key('a', ['cmd'])
  await key('c', ['cmd'])
  await pause(400)
  const copied = (await control({ cmd: 'read-clipboard' })).text ?? ''
  await key('esc')
  await key('u', ['ctrl'])
  const selectAllCopy = { copiedHasMarker: copied.includes('lxcopy'), copiedLength: copied.length, focus: (await read()).focus }
  note('cmdA-cmdC-observed', selectAllCopy)
  // 마우스 선택 → ⌘C — 화면 첫 줄 일부를 끌어 선택.
  await typeKeys('lxsel')
  const box = (await control({ cmd: 'rect', selector: `[data-term-pane="${pane}"] .xterm-screen` })).rect
  const rowsOnScreen = screenOf(pane).split('\n')
  const rowIndex = rowsOnScreen.findIndex((line) => line.includes('lxsel'))
  const cellH = box.height / Math.max(1, rowsOnScreen.length)
  const yRow = Math.round(box.top + cellH * (rowIndex + 0.5))
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: Math.round(box.left + 2), y: yRow })
  for (let step = 1; step <= 6; step += 1) await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(box.left + 2 + ((box.width - 10) * step) / 6), y: yRow })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: Math.round(box.left + box.width - 8), y: yRow })
  await key('c', ['cmd'])
  await pause(400)
  const mouseCopied = (await control({ cmd: 'read-clipboard' })).text ?? ''
  req.require('k7a-cmdC-mouse-selection', rowIndex >= 0 && mouseCopied.includes('lxsel'), { rowIndex, mouseCopied: mouseCopied.slice(0, 120) })
  await key('u', ['ctrl'])
  // ⌘V — 클립보드 텍스트가 활성 pane 에 들어간다.
  run('clip', ['text', 'lxpaste'])
  await key('v', ['cmd'])
  const pasted = await soft(until(async () => screenOf(pane).includes('lxpaste'), '⌘V 붙여넣기', 5_000))
  await key('u', ['ctrl'])
  req.require('k7a-cmdV-paste', pasted === true, { pane })
  // 클립보드 원복 — 관문 전이 비어 있었으면 비우고, 텍스트였으면 그 텍스트로.
  const items = JSON.parse(clipBefore).items
  if (items.length === 0) run('clip', ['clear'])
  else if (textBefore !== '') run('clip', ['text', textBefore])
  note('clipboard-restored', { dump: run('clip', ['dump']).out, wasEmpty: items.length === 0 })
  // ⌘⇧R — 강제 새로고침(기본 메뉴 그대로): 마커가 사라지고 같은 fixture 화면으로 돌아온다.
  await evaluate(() => { window.__l495mark = 'before-force-reload' })
  const sent = await key('r', ['cmd', 'shift'])
  const reloaded = await soft(until(async () => { try { return (await read()).mark === null } catch { return false } }, '⌘⇧R 새로고침', 15_000, 300))
  await soft(until(async () => (await read()).groups.length > 0, '새로고침 뒤 탭바', 20_000, 300))
  req.require('k7a-cmdShiftR-force-reload-kept', sent.sent && reloaded === true, {})
}

/** ⌘Q — 기본 메뉴 Quit 그대로(앱이 끝난다). 재기동·유지 확인은 native-app.sh + persist-check. */
async function phaseQuit() {
  await control({ cmd: 'flush-storage' }).catch(() => null)
  const sent = await key('q', ['cmd'])
  const gone = await soft(until(async () => { try { process.kill(appPid, 0); return false } catch { return true } }, '⌘Q 종료', 20_000, 300))
  req.require('k7a-cmdQ-quits', sent.sent && gone === true, { appPid })
}

const table = { setup: phaseSetup, u1k7: phaseU1K7, k2: phaseK2, k3k4: phaseK3K4, 'persist-check': phasePersistCheck, k6: phaseK6, k8e: phaseK8e, k9: phaseK9, menukeys: phaseMenuKeys, quit: phaseQuit }
const ORIGINAL_SOURCE = JSON.parse(run('inputsource', ['current']).out).id
/** 준비 타이핑(sleep·cd·이름)은 ABC 에서 친다 — r2 에서 한글 입력기로 `ㄴㅣㄷ…` 가 들어가 sleep 이 안 돌았다(t3-k2.log). */
function restoreSource() {
  run('inputsource', ['select', ORIGINAL_SOURCE])
  note('input-source-restored', { original: ORIGINAL_SOURCE, now: run('inputsource', ['current']).out })
}
async function main() {
  note('input-source-original', { original: ORIGINAL_SOURCE, abc: run('inputsource', ['select', 'com.apple.keylayout.ABC']).out })
  for (const phase of phases) {
    const fn = table[phase]
    if (fn === undefined) throw new Error(`모르는 phase ${phase}`)
    note(`phase-start-${phase}`, {})
    await fn()
  }
}
main().then(
  () => {
    restoreSource()
    const code = req.exitCode()
    note('end', { failed: req.failed().map((row) => row.name), exit: code })
    process.exit(code)
  },
  (error) => {
    restoreSource()
    note('error', { message: String(error?.stack ?? error).slice(0, 800) })
    process.exit(2)
  },
)
