// LIFE-496 K4 네이티브 관문 드라이버 — 사용자 userData + 구현 브랜치 빌드 + herdr 정식 `default` 세션(LIFE-456 S9 B안, native-up.sh).
// 격리 예행(iso-t4.mjs)은 ROOT=/tmp/l496i* 에 L496_CTL(제어 소켓)·L496_HERDR_SESSION·L496_HERDR_HOME 을 준다 — 관문 근거가 아니다.
//
// 입력은 제어 소켓 `click`·`raw-mouse`·`key`·`type`(Chromium sendInputEvent — 히트테스트를 크로미움이 한다). 렌더러 eval 은 읽기와 준비(탭 이름)에만 쓴다.
// **provider**: claude 만 입력 없이 Quick-launch 로 띄웠다가 닫는다(L496_CLAUDE=1 일 때). codex 는 띄우지 않는다. grok 은 이 드라이버가 띄우지 않는다.
// 실행 파일 없음(워치독 양성)은 격리에서만 — L496_MISSING=1 이면 PATH 에서 에이전트가 빠진 격리 서버라 보고 grok 을 메뉴로 걸어 알림을 기다린다.
//
// **원자료 경계**: 캡처는 fixture 탭바·메뉴 영역만(선택자 캡처), 덤프는 fixture 워크스페이스의 탭만. 다른 탭이 탭바에 보이면 멈춘다.
// 사용: node t4-drive.mjs <ROOT=/tmp/l496n*|/tmp/l496i*> <raw 폴더> <fixture 경로(realpath)>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { BoundaryError, focusProbe, guardedSender, orNull } from './drive-guard.mjs'

const [root, rawd, fixture] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l496n') && !root?.startsWith('/tmp/l496i')) throw new Error('ROOT 는 /tmp/l496n* (예행 /tmp/l496i*)')
const ctl = process.env.L496_CTL ?? path.join(root, 'ctl.sock')
const withClaude = process.env.L496_CLAUDE === '1'
const missingMode = process.env.L496_MISSING === '1'
/** 네이티브(사용자 userData + herdr default) 회차인가 — 격리 예행은 L496_CTL 을 준다. */
const nativeMode = process.env.L496_CTL === undefined
const herdrSession = process.env.L496_HERDR_SESSION ?? 'default'
const herdrEnv = process.env.L496_HERDR_HOME
  ? { ...process.env, XDG_CONFIG_HOME: process.env.L496_HERDR_HOME, HERDR_CONFIG_PATH: path.join(process.env.L496_HERDR_HOME, 'config.toml') }
  : process.env
const HERDR = '/opt/homebrew/bin/herdr'
const shotsOut = path.join(rawd, 'shots')
fs.mkdirSync(shotsOut, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = []
const record = (step, ok, detail) => {
  log.push({ step, ok, at: new Date().toISOString(), ...detail })
  console.log(`[t4] ${ok === null ? '…' : ok ? '✔' : '✘'} ${step}`, JSON.stringify(detail).slice(0, 260))
  fs.writeFileSync(path.join(rawd, 't4-log.json'), `${JSON.stringify(log, null, 1)}\n`)
}
const control = (request, timeout = 20_000) => rpc(ctl, request, timeout)
const run = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` })).result
async function until(fn, label, timeout = 30_000, every = 200) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}
const center = (box) => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) })
const mouse = (type, point, button) => control({ cmd: 'raw-mouse', type, x: point.x, y: point.y, ...(button ? { button } : {}) })
/** fix2 R2-03 — 전역 입력은 보내기 직전에 확인한다: 화면이 fixture 탭만(`read` 가 아니면 BoundaryError) · 포커스가 영역·`+` 메뉴 안. */
const sendGuarded = guardedSender({
  check: async () => {
    await read()
    const focus = await run(focusProbe)
    return focus.inArea ? { ok: true } : { ok: false, reason: `포커스가 fixture 영역 밖 ${focus.tag}.${focus.className}` }
  },
  send: (request) => control(request),
})
const key = (keyCode, modifiers = []) => sendGuarded({ cmd: 'key', keyCode, modifiers })
const type = (text) => sendGuarded({ cmd: 'type', text })

async function fixtureWorkspace() {
  const res = await control({ cmd: 'state' })
  for (const repo of res.state.repos) for (const row of repo.worktrees) if (row.path === fixture) return row.workspace ?? null
  return null
}
const fixtureTabIds = async () => ((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId)
const paneOf = async (tabId) => (await fixtureWorkspace())?.tabs.find((tab) => tab.tabId === tabId)?.panes[0] ?? null

/** 페이지 안 — 영역·탭·메뉴·포커스. */
function readPage(mineList) {
  const mine = new Set(mineList)
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
  }
  const style = (el, keys) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    return Object.fromEntries(keys.map((name) => [name, cs.getPropertyValue(name)]))
  }
  const active = document.activeElement
  const focusGroup = active?.closest?.('[data-tab-group]')?.getAttribute('data-tab-group') ?? null
  const groups = [...document.querySelectorAll('[data-tab-group]')].map((group) => {
    const bar = group.querySelector('[data-main-tabbar]')
    const all = [...(bar?.querySelectorAll('[data-main-tab]') ?? [])]
    return {
      group: group.getAttribute('data-tab-group'),
      activeGroup: group.classList.contains('is-active-group'),
      header: box(bar),
      body: box(group.querySelector('[data-term-group], [data-empty-group]')),
      empty: group.querySelector('[data-empty-group]') !== null,
      plus: (() => {
        const el = bar?.querySelector('[data-main-tabbar-add]')
        return el ? { box: box(el), expanded: el.getAttribute('aria-expanded'), title: el.getAttribute('title') } : null
      })(),
      foreign: all.length - all.filter((tab) => mine.has(tab.dataset.mainTab)).length,
      tabs: all.filter((tab) => mine.has(tab.dataset.mainTab)).map((tab) => ({ id: tab.dataset.mainTab, active: tab.dataset.active === 'true', label: tab.querySelector('.main-tab-label')?.textContent ?? null })),
    }
  })
  const menuEl = document.querySelector('[data-tab-create-menu]')
  const menu = menuEl && {
    group: menuEl.getAttribute('data-tab-create-menu'),
    box: box(menuEl),
    style: style(menuEl, ['width', 'padding-top', 'border-radius', 'border-top-width', 'box-shadow', 'background-color', 'font-size']),
    input: (() => {
      const el = menuEl.querySelector('[data-tab-create-input]')
      return el ? { box: box(el), placeholder: el.placeholder, value: el.value, focused: el === active, style: style(el, ['height', 'font-size']) } : null
    })(),
    results: [...menuEl.querySelectorAll('[data-tab-create-result]')].map((row) => ({ id: row.dataset.tabCreateResult, selected: row.getAttribute('aria-selected') === 'true', text: row.textContent, box: box(row) })),
    status: menuEl.querySelector('[data-tab-create-status]')?.textContent ?? null,
    items: [...menuEl.querySelectorAll('[data-tab-create-item]')].map((row) => ({ id: row.dataset.tabCreateItem, text: row.textContent, box: box(row), focused: row === active, style: style(row, ['height', 'font-size', 'font-weight', 'border-radius', 'padding-left']) })),
    separators: [...menuEl.querySelectorAll('[role="separator"]')].map((sep) => box(sep)),
  }
  const notices = [...document.querySelectorAll('[data-inline-notice], .inline-notice')].map((el) => el.textContent)
  return {
    groups,
    menu,
    notices,
    focus: { tag: active?.tagName ?? null, isTerminal: active?.closest?.('.term-host') != null, group: focusGroup, menuInput: active?.hasAttribute?.('data-tab-create-input') ?? false },
  }
}
async function read() {
  const seen = await run(readPage, await fixtureTabIds())
  if (seen.groups.some((group) => group.foreign > 0)) throw new BoundaryError('탭바에 fixture 밖 탭이 있다 — 멈춘다')
  return seen
}
async function dump(tag) {
  const seen = await read()
  fs.writeFileSync(path.join(rawd, `state-${tag}.json`), `${JSON.stringify(seen, null, 1)}\n`)
  return seen
}
async function shot(tag, selector) {
  const res = await control({ cmd: 'shot', name: `l496-${tag}`, selector })
  if (!res.ok) throw new Error(`shot 실패 ${JSON.stringify(res).slice(0, 200)}`)
  const target = path.join(shotsOut, `${tag}.png`)
  fs.copyFileSync(res.file, target)
  return path.relative(rawd, target)
}
const groupById = (seen, id) => seen.groups.find((group) => group.group === id)
const activeOf = (group) => group?.tabs.find((tab) => tab.active) ?? null
async function openMenu(group) {
  const res = await control({ cmd: 'click', selector: `[data-main-tabbar-add="${group}"]` })
  if (!res.ok) throw new Error(`+ 클릭 실패 ${JSON.stringify(res).slice(0, 200)}`)
  // 열리고 입력창 포커스(rAF)까지.
  return until(async () => {
    const seen = await read()
    return seen.menu?.group === group && seen.menu.input?.focused ? seen : null
  }, '메뉴 열림·입력창 포커스', 5_000, 100)
}
const newTabAfter = async (before) => until(async () => (await fixtureTabIds()).find((id) => !before.has(id)) ?? null, '새 탭', 20_000)
/** 새 탭이 지정 영역에서 활성이고, 터미널이 그 영역에서 포커스를 가졌나. */
async function settledOn({ group, tabId, timeout = 10_000 }) {
  // 시간 초과는 null(판정에서 실패로 센다). 경계 위반은 삼키지 않는다(fix2 R2-03).
  return orNull(until(async () => {
    const seen = await read()
    const owner = groupById(seen, group)
    return activeOf(owner)?.id === tabId && seen.focus.isTerminal && seen.focus.group === group && seen.menu === null ? seen : null
  }, `${tabId} 활성·터미널 포커스(${group})`, timeout, 150))
}
/** pane 화면 글자 — herdr `pane read`(읽기만). fixture 탭의 pane 만 읽는다. */
async function paneText(tabId) {
  const pane = await paneOf(tabId)
  if (pane === null) return null
  return execFileSync(HERDR, ['--session', herdrSession, 'pane', 'read', pane.paneId], { encoding: 'utf8', env: herdrEnv })
}

async function main() {
  // ① fixture 레포를 더하고 카드를 눌러 연다 (494 native-t2 와 같은 길).
  await control({ cmd: 'add-repo', root: fixture })
  await control({ cmd: 'rebuild-tree' })
  await until(async () => ((await control({ cmd: 'query', selector: `[data-worktree="${fixture}"]` })).found ?? []).length > 0, 'fixture 카드', 30_000)
  const ws = await until(async () => {
    await control({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
    await pause(1500)
    const row = await fixtureWorkspace()
    if (!row || row.tabs.length === 0) return null
    const dom = await run(() => [...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab))
    return dom.length > 0 && dom.every((id) => row.tabs.some((tab) => tab.tabId === id)) ? row : null
  }, 'fixture 화면', 30_000, 500)
  const g1 = (await read()).groups[0].group
  const firstTab = ws.tabs[0].tabId

  // ② ⌘T = 메뉴 없이 즉시 빈 탭 (K2ⓐ) — 두 번.
  const shells = [firstTab]
  for (let index = 0; index < 2; index += 1) {
    const before = new Set(await fixtureTabIds())
    await key('t', ['meta'])
    const id = await newTabAfter(before)
    shells.push(id)
    const seen = await settledOn({ group: g1, tabId: id })
    record(`cmd-t-${index}`, seen !== null && seen.menu === null, { tab: id, menu: seen?.menu ?? null, focus: seen?.focus ?? null })
  }
  // 준비 — 탭 이름(검색 대상). 이름은 herdr 가 들고 있다(`tab.rename`) — 제품 IPC 를 그대로 부른다.
  const names = ['alpha-build', 'beta-logs', 'gamma-notes']
  for (let index = 0; index < shells.length; index += 1) await run((input) => window.corral.renameRow(input), { tabId: shells[index], label: names[index] })
  await until(async () => {
    const group = groupById(await read(), g1)
    return names.every((name) => group.tabs.some((tab) => tab.label === name))
  }, '이름', 10_000)

  // ③ 영역 2개 — beta-logs 우클릭 → 「오른쪽 영역」(494 ⑪ 과 같은 길).
  await control({ cmd: 'click', selector: `[data-main-tab="${shells[1]}"]` })
  await pause(500)
  const rect = await control({ cmd: 'rect', selector: `[data-main-tab="${shells[1]}"]` })
  const tabBox = rect.rect ?? rect.box ?? rect
  const rightPoint = { x: Math.round((tabBox.x ?? tabBox.left) + 20), y: Math.round((tabBox.y ?? tabBox.top) + 10) }
  await mouse('mouseDown', rightPoint, 'right')
  await mouse('mouseUp', rightPoint, 'right')
  await pause(300)
  await control({ cmd: 'click', selector: '[data-tab-menu-move-right]' })
  const two = await until(async () => { const now = await read(); return now.groups.length === 2 ? now : null }, '영역 2개', 15_000)
  const g2 = two.groups.find((one) => one.group !== g1).group
  record('two-areas', groupById(two, g2).tabs.some((tab) => tab.id === shells[1]), { g1, g2, groups: two.groups.map((one) => ({ group: one.group, tabs: one.tabs.map((tab) => tab.label) })) })
  // g1 을 활성으로(그 영역 터미널을 눌러).
  await control({ cmd: 'click', selector: `[data-main-tab="${shells[0]}"]` })
  await pause(600)

  // ④ `+` → 메뉴(빈 질의) — 입력창 포커스·정적 메뉴 순서·Orca 기하.
  let seen = await openMenu(g1)
  fs.writeFileSync(path.join(rawd, 'state-04-menu-empty.json'), `${JSON.stringify(seen, null, 1)}\n`)
  const items = seen.menu.items.map((item) => item.id)
  record('menu-empty', seen.menu.input.focused && JSON.stringify(items) === JSON.stringify(['new-terminal', 'agent:claude', 'agent:codex', 'agent:grok']) && seen.menu.results.length === 0 && groupById(seen, g1).plus.expanded === 'true', {
    items, input: seen.menu.input, box: seen.menu.box, style: seen.menu.style, itemStyle: seen.menu.items[0]?.style, separators: seen.menu.separators.length,
    shots: [await shot('04-menu-empty', '[data-tab-create-menu]'), await shot('04-header-g1', `[data-group-header="${g1}"]`)],
  })
  // 메뉴가 열린 동안 키가 터미널로 새지 않는다 (K2ⓒ) — 질의 "beta" 를 친다.
  const termBefore = await paneText(shells[0])
  await type('beta')
  await pause(400)
  seen = await dump('05-query-beta')
  const termAfter = await paneText(shells[0])
  record('query-open-tab', seen.menu.results[0]?.id === `tab:${shells[1]}` && seen.menu.items.length === 0, { results: seen.menu.results, shots: [await shot('05-query-beta', '[data-tab-create-menu]')] })
  record('keys-not-leaking-while-open', termAfter !== null && termBefore === termAfter && !termAfter.includes('beta'), { leaked: termAfter?.includes('beta') ?? null, tail: termAfter?.split('\n').filter(Boolean).slice(-3) ?? null })
  // Enter = 다른 영역(g2)의 그 탭으로 · 포커스가 g2 터미널.
  await key('Enter')
  const moved = await settledOn({ group: g2, tabId: shells[1] })
  record('select-tab-other-area', moved !== null, { focus: moved?.focus ?? (await read()).focus, active: moved ? activeOf(groupById(moved, g2)) : null })

  // ⑤ g1 `+` → "terminal" → 열린 탭(≤4) 뒤 메뉴 매칭 New Terminal → ↓ 로 골라 Enter → g1 에 새 셸 탭·활성·포커스.
  await control({ cmd: 'click', selector: `[data-main-tab="${shells[0]}"]` })
  await pause(600)
  await openMenu(g1)
  await type('terminal')
  await pause(400)
  seen = await dump('06-query-terminal')
  const ids = seen.menu.results.map((row) => row.id)
  const tabRows = ids.filter((id) => id.startsWith('tab:'))
  record('query-terminal', tabRows.length <= 4 && ids.at(-1) === 'menu:new-terminal' && seen.menu.items.length === 0, { results: ids, shots: [await shot('06-query-terminal', '[data-tab-create-menu]')] })
  for (let i = 0; i < ids.length; i += 1) {
    const now = await read()
    if (now.menu.results.find((row) => row.selected)?.id === 'menu:new-terminal') break
    await key('Down')
    await pause(120)
  }
  const selectedNow = (await read()).menu.results.find((row) => row.selected)?.id
  const beforeNew = new Set(await fixtureTabIds())
  await key('Enter')
  const viaQuery = await newTabAfter(beforeNew)
  const viaQuerySeen = await settledOn({ group: g1, tabId: viaQuery })
  record('query-new-terminal', selectedNow === 'menu:new-terminal' && viaQuerySeen !== null, { selected: selectedNow, tab: viaQuery, focus: viaQuerySeen?.focus ?? null })

  // ⑥ Escape = 닫힘 · 포커스가 g1 터미널로 · `+` 가 아니다.
  await openMenu(g1)
  await key('Escape')
  seen = (await orNull(until(async () => { const now = await read(); return now.menu === null && now.focus.isTerminal ? now : null }, 'Escape 닫힘·터미널 포커스', 5_000, 100))) ?? (await read())
  record('escape-closes-focus-terminal', seen.menu === null && seen.focus.isTerminal && seen.focus.group === g1, { focus: seen.focus })
  // 닫은 뒤 입력은 터미널로 간다 (K2ⓒ).
  await type('echo l496-after-close')
  await pause(600)
  const afterClose = await paneText(viaQuery)
  record('input-after-close-reaches-terminal', afterClose?.includes('l496-after-close') === true, { tail: afterClose?.split('\n').filter(Boolean).slice(-3) ?? null })
  await key('u', ['control'])

  // ⑥b (fix1 R1-01) 메뉴가 열린 채 ⌘T — 새 탭은 즉시 생기고, 메뉴는 닫히고, 포커스·뒤따른 입력은 새 터미널로. 그 뒤 Escape 도 터미널로 간다.
  // ⌘T 의 메뉴 닫힘은 focus-out(focusin) 으로 난다 — 실제 사용자는 시스템 포커스를 가진 창에만 키를 칠 수 있다. 제어 소켓 입력은 포커스 없는 창에도
  // 들어가서(격리 실측: focusin 0건), 창이 포커스를 갖고 있는지 먼저 읽고 없으면 앞으로 가져온다(사용자 동작 조건과 맞춘다 — fix2 R2-02).
  const windowBefore = await control({ cmd: 'window-visibility', action: 'read' })
  const windowFocus = windowBefore.focused ? windowBefore : await control({ cmd: 'window-visibility', action: 'show' })
  await openMenu(g1)
  const beforeCmdT = new Set(await fixtureTabIds())
  await key('t', ['meta'])
  const viaCmdT = await newTabAfter(beforeCmdT)
  const cmdTSeen = await settledOn({ group: g1, tabId: viaCmdT })
  // 정착을 못 봤으면 목적지를 모르는 채 치지 않는다(fix2 R2-03).
  if (cmdTSeen === null) throw new Error(`⌘T 새 탭 ${viaCmdT} 정착 확인 실패 — 입력 전에 멈춘다`)
  await type('echo l496-cmdt')
  await pause(600)
  const cmdTText = await paneText(viaCmdT)
  const prevText = await paneText(viaQuery)
  await key('Escape')
  await pause(300)
  const afterEsc = await read()
  record('cmd-t-while-menu-open', cmdTSeen !== null && cmdTText?.includes('l496-cmdt') === true && prevText?.includes('l496-cmdt') === false && afterEsc.menu === null && afterEsc.focus.isTerminal, {
    windowFocusBefore: windowBefore.focused, windowFocusAtCmdT: windowFocus.focused, tab: viaCmdT, focus: cmdTSeen?.focus ?? (await read()).focus, menuAfter: cmdTSeen?.menu ?? null, newTail: cmdTText?.split('\n').filter(Boolean).slice(-2) ?? null, afterEscape: { menu: afterEsc.menu, focus: afterEsc.focus },
  })
  await key('u', ['control'])

  // ⑥c (fix1 R1-03) "term" 접두 — 제목에 term 이 없는 열린 탭도 별칭 접두로 찾는다.
  await openMenu(g1)
  await type('term')
  await pause(400)
  seen = await dump('06c-query-term')
  const termIds = seen.menu.results.map((row) => row.id)
  record('query-term-prefix-open-tabs', termIds.filter((id) => id.startsWith('tab:')).length >= 1 && termIds.includes('menu:new-terminal'), { results: termIds, shots: [await shot('06c-query-term', '[data-tab-create-menu]')] })

  // ⑥d (fix1 R1-06) 조합 중 Escape — **렌더러 합성 이벤트**(isComposing:true keydown)다. 실제 macOS IME 경로는 이 손잡이로 못 낸다(제어 소켓에 IME 입력 없음).
  await run(() => {
    const input = document.querySelector('[data-tab-create-input]')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
  })
  await pause(200)
  const composingSeen = await read()
  record('composing-escape-keeps-menu-synthetic', composingSeen.menu !== null && composingSeen.menu.input.value === 'term', { menu: composingSeen.menu !== null, value: composingSeen.menu?.input.value ?? null, note: '합성 이벤트 — 실 IME 아님' })
  await key('Escape')
  await pause(300)

  // ⑥e (fix3 R3-01) 열린 메뉴의 `+` 를 다시 누름 — 실제 mouseDown·mouseUp(제어 소켓 click = sendInputEvent). 닫히고, 다시 열리지 않는다.
  await openMenu(g1)
  await control({ cmd: 'click', selector: `[data-main-tabbar-add="${g1}"]` })
  await pause(250)
  const afterReclick = await read()
  await pause(600)
  const afterReclickLater = await read()
  record('plus-reclick-closes', afterReclick.menu === null && afterReclickLater.menu === null && groupById(afterReclickLater, g1).plus.expanded === 'false', {
    menuAt250: afterReclick.menu !== null, menuAt850: afterReclickLater.menu !== null, expanded: groupById(afterReclickLater, g1).plus.expanded, focus: afterReclickLater.focus,
  })

  // ⑦ 바깥 클릭 = 닫힘 (g2 본문).
  await openMenu(g1)
  const g2Body = groupById(await read(), g2).body
  const outside = center(g2Body)
  await mouse('mouseDown', outside)
  await mouse('mouseUp', outside)
  await pause(400)
  seen = await read()
  record('outside-click-closes', seen.menu === null, { focus: seen.focus })

  // ⑧ 빈 질의 Enter = 새 터미널 / 정적 메뉴 클릭 = 새 터미널 — 둘 다 g1.
  await control({ cmd: 'click', selector: `[data-main-tab="${shells[0]}"]` })
  await pause(500)
  await openMenu(g1)
  let before = new Set(await fixtureTabIds())
  await key('Enter')
  const viaEnter = await newTabAfter(before)
  record('empty-enter-new-terminal', (await settledOn({ group: g1, tabId: viaEnter })) !== null, { tab: viaEnter })
  await openMenu(g1)
  before = new Set(await fixtureTabIds())
  await control({ cmd: 'click', selector: `[data-tab-create-menu="${g1}"] [data-tab-create-item="new-terminal"]` })
  const viaClick = await newTabAfter(before)
  record('static-new-terminal-click', (await settledOn({ group: g1, tabId: viaClick })) !== null, { tab: viaClick })

  // ⑨ 키보드로 정적 메뉴 — ↓ 로 첫 항목, 첫 항목의 ↑ 는 입력창으로 돌아간다(Orca use-tab-entry-menu-return-focus, fix1 R1-02), Escape.
  await openMenu(g1)
  await key('Down')
  await pause(150)
  const firstFocus = (await read()).menu.items.find((item) => item.focused)?.id ?? null
  const staticShot = await shot('09-static-focus', '[data-tab-create-menu]')
  await key('Up')
  await pause(150)
  const afterUp = await read()
  record('arrow-up-returns-to-input', firstFocus === 'new-terminal' && afterUp.menu !== null && afterUp.menu.input.focused && !afterUp.menu.items.some((item) => item.focused), { firstFocus, inputFocused: afterUp.menu?.input.focused ?? null, shots: [staticShot] })
  await key('Escape')
  await pause(300)

  // ⑪ claude Quick-launch 실기동 1회 (입력 없이) — 생성·영역·펼침·포커스·에이전트 감지 도착·오탐 0(12초 관찰) → 닫기.
  if (withClaude) {
    await control({ cmd: 'click', selector: `[data-main-tab="${shells[0]}"]` })
    await pause(600)
    await openMenu(g1)
    const shotClaudeMenu = await shot('11-before-claude', '[data-tab-create-menu]')
    before = new Set(await fixtureTabIds())
    const clickedAt = Date.now()
    await control({ cmd: 'click', selector: `[data-tab-create-menu="${g1}"] [data-tab-create-item="agent:claude"]` })
    const claudeTab = await newTabAfter(before)
    const tabAt = Date.now() - clickedAt
    const settled = await settledOn({ group: g1, tabId: claudeTab, timeout: 15_000 })
    const settledAt = Date.now() - clickedAt
    let agentAt = null
    const samples = []
    while (Date.now() - clickedAt < 12_500) {
      const pane = await paneOf(claudeTab)
      const notices = (await read()).notices
      samples.push({ t: Date.now() - clickedAt, agent: pane?.agent ?? null, status: pane?.agentStatus ?? null, notices })
      if (pane?.agent && agentAt === null) agentAt = Date.now() - clickedAt
      await pause(250)
    }
    const falseAlarm = samples.some((sample) => sample.notices.some((text) => text.includes('실행 실패')))
    const claudeShot = await shot('11-claude-launched', `[data-group-header="${g1}"]`)
    record('claude-quick-launch', settled !== null && agentAt !== null && !falseAlarm, {
      tab: claudeTab, tabCreatedMs: tabAt, settledMs: settledAt, agentArrivedMs: agentAt, falseAlarm, focus: settled?.focus ?? null, samples, shots: [shotClaudeMenu, claudeShot],
    })
    await run((tabId) => window.corral.closeRow({ tabId, confirmed: true }), claudeTab)
    await until(async () => !(await fixtureTabIds()).includes(claudeTab), 'claude 탭 닫힘', 15_000)
    record('claude-closed', true, { tab: claudeTab })
  }

  // ⑫ (격리 전용) 실행 파일 없음 — grok 을 메뉴로 걸면 10초 뒤 실패 알림이 뜬다(워치독 양성).
  if (missingMode) {
    await control({ cmd: 'click', selector: `[data-main-tab="${shells[0]}"]` })
    await pause(600)
    await openMenu(g1)
    before = new Set(await fixtureTabIds())
    const clickedAt = Date.now()
    await control({ cmd: 'click', selector: `[data-tab-create-menu="${g1}"] [data-tab-create-item="agent:grok"]` })
    const grokTab = await newTabAfter(before)
    const samples = []
    let noticeAt = null
    while (Date.now() - clickedAt < 13_000) {
      const now = await read()
      const pane = await paneOf(grokTab)
      samples.push({ t: Date.now() - clickedAt, agent: pane?.agent ?? null, notices: now.notices })
      if (noticeAt === null && now.notices.some((text) => text.includes('Grok 실행 실패'))) noticeAt = Date.now() - clickedAt
      await pause(250)
    }
    record('watchdog-missing-executable', noticeAt !== null && noticeAt >= 9_500, { tab: grokTab, noticeAt, samples, shots: [await shot('12-watchdog-notice', `[data-tab-group="${g1}"]`)] })
  }

  // ⑩ 탭 0개 영역의 `+` — 영역은 마지막 탭을 닫으면 접히고(group-tree `dropEmptyLeaves`) 하나 남은 영역만 빈 채로 남는다.
  //    fixture 탭을 전부 닫아 그 상태를 만든 뒤 `+` → 메뉴 → Enter(새 터미널)가 그 영역에 선다 (K2ⓐ · Orca #18024).
  // fix1 C2 — 네이티브에서는 뺀다: fixture 탭을 다 닫으면 워크스페이스가 닫혀 화면이 사용자 복구 워크스페이스로 넘어간다(native r2).
  if (nativeMode) {
    record('empty-area-plus-menu', null, { skipped: 'native — 사용자 워크스페이스로 화면이 넘어가는 부작용(r2) 때문에 뺐다' })
    seen = await dump('99-final')
    fs.writeFileSync(path.join(rawd, 't4-tabs.json'), `${JSON.stringify({ workspace: ws.workspaceId, g1, g2, shells }, null, 1)}\n`)
    return
  }
  for (const id of await fixtureTabIds()) {
    await control({ cmd: 'click', selector: `[data-main-tab-close="${id}"]` })
    await until(async () => !(await fixtureTabIds()).includes(id), `${id} 닫힘`, 10_000)
    await pause(300)
  }
  await pause(800)
  const emptied = await read()
  const only = emptied.groups.length === 1 ? emptied.groups[0] : null
  if (only !== null && only.empty && only.plus !== null) {
    await openMenu(only.group)
    seen = await dump('10-empty-area-menu')
    const emptyShot = await shot('10-empty-area-menu', '[data-tab-create-menu]')
    const before = new Set(await fixtureTabIds())
    await key('Enter')
    const inEmpty = await newTabAfter(before)
    const filled = await settledOn({ group: only.group, tabId: inEmpty })
    record('empty-area-plus-menu', seen.menu?.group === only.group && filled !== null, { group: only.group, tab: inEmpty, shots: [emptyShot] })
  } else {
    // 격리 예행 r2·r3 실측: 마지막 탭을 닫으면 herdr 가 workspace 를 닫아 영역째 사라진다(groups 0 · workspace null) — 그 상태는 제품에서 닿지 않는다.
    // 그러면 판정이 아니라 관측으로 남긴다(K2ⓐ 「탭 0개 영역에 `+` 가 보이는 경우」 의 조건이 성립하지 않는다 — DOM 계약은 MainTabBar.test 가 본다).
    const workspace = (await fixtureWorkspace())?.workspaceId ?? null
    const unreachable = emptied.groups.length === 0 && workspace === null
    record('empty-area-plus-menu', unreachable ? null : false, { unreachable, groups: emptied.groups.map((group) => ({ group: group.group, empty: group.empty, plus: group.plus })), workspace })
  }

  seen = await dump('99-final')
  fs.writeFileSync(path.join(rawd, 't4-tabs.json'), `${JSON.stringify({ workspace: ws.workspaceId, g1, g2, shells }, null, 1)}\n`)
}

main().then(
  () => {
    const failed = log.filter((entry) => entry.ok === false).map((entry) => entry.step)
    record('end', failed.length === 0, { failed })
    process.exit(failed.length === 0 ? 0 : 1)
  },
  (error) => {
    record('error', false, { message: String(error?.stack ?? error).slice(0, 600) })
    process.exit(2)
  },
)
