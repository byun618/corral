// LIFE-468 K8ⓑ — S2(카드·선택) 상태의 **장면**을 두 앱에 같게 만든다: hover · 레포 접힘 · 긴 워크트리 이름 ·
// 스크롤 sticky · 폭 최소/최대 · 빈 목록.
//
// 원칙은 에이전트 상태와 같다(README 「상태는 주입하고, 주입 결과를 검증한다」): **제품 경로**로 만들고(CDP 실제 마우스
// 입력 · git worktree + 각 앱의 재조회 · 각 앱의 레포 제거 IPC), 만든 뒤 **두 앱에서 관측값을 읽어** 요청과 견준다.
// 못 맞춘 장면은 `ok:false` 로 돌려주고, 호출자가 그 상태를 재현 실패(보류)로 내린다 — 하네스가 만든 차이를 제품 차이로
// 보고하지 않는다.
//
// 장면은 상태마다 **처음부터 다시 맞춘다**(`resetScene`): 앞 상태의 hover·접힘·스크롤·폭이 다음 상태로 끌려가면
// 「기본 상태」가 기본이 아니게 된다.

/* global document, window, getComputedStyle, Event -- CDP evaluate 로 페이지 안에서 도는 클로저가 쓴다 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { until, pause, setViewport } from './cdp.mjs'
import { rpc } from './corral.mjs'

/** 두 앱의 같은 뜻 선택자 — 측정 영역 정의(`areas/sidebar.json`)와 같은 짝이다. */
export const SCENE_SELECTORS = {
  orca: {
    root: '[data-native-file-drop-target="project-sidebar"]',
    card: '[data-worktree-card-surface]',
    cardRow: '[data-worktree-id]',
    agentRow: '.compact-agent-row',
    repoHeader: '[data-repo-header-id]',
    repo: '[data-repo-header-id]',
    resizer: '[data-sidebar-resize-handle]',
    empty: '[data-worktree-sidebar-container] div.items-center.text-center'
  },
  corral: {
    root: '[data-sidebar]',
    card: '[data-worktree-card-surface]',
    cardRow: '[data-worktree]',
    agentRow: '.session-row',
    repoHeader: '[data-repo-toggle]',
    repo: '[data-repo]',
    resizer: '[data-sidebar-resizer]',
    empty: '[data-empty]'
  }
}

/** 탭 스트립 — 측정 영역 정의(`areas/tabbar.json` `tab-strip`)와 같은 짝. corral 은 영역마다 하나라 첫 것(영역 1개). */
export const TAB_STRIP_SELECTORS = { orca: '.terminal-tab-strip', corral: '[data-main-tab-strip]' }

/** 페이지 안에서 도는 탭 스트립 관측 — 스크롤 위치·끝까지 남은 거리·활성 탭이 붙은 쪽(corral 만 표식이 있다, Orca 198 은 dock 없음). */
function observeTabStripPage(selector) {
  const strip = document.querySelector(selector)
  if (!strip) return null
  const max = strip.scrollWidth - strip.clientWidth
  return { scrollLeft: Math.round(strip.scrollLeft), max: Math.round(max), docked: strip.getAttribute('data-active-tab-docked') }
}

async function observeTabStrip({ handle, app }) {
  return handle.cdp.evaluate(observeTabStripPage, TAB_STRIP_SELECTORS[app])
}

/**
 * LIFE-494 — 탭 스트립을 **실제 휠 입력**(CDP mouseWheel, 세로 delta)으로 끝(또는 맨 앞)까지 민다. 두 앱 다 세로 휠을 가로 스크롤로 바꾸는 제품 경로다
 * (Orca `tab-strip-overflow-navigation.ts` wheel · corral `useTabStripOverflow` wheel). scrollLeft 를 직접 쓰지 않는 이유: 그건 제품의
 * 휠 처리(끝 붙기·지표 갱신)를 건너뛴다. 끝에 닿으면(±2px) 멈추고, 포인터를 치운 뒤 스크롤 중 표시(800ms)가 꺼질 때까지 기다린다.
 */
async function wheelTabStripTo({ handle, app, edge }) {
  const point = await handle.cdp.evaluate((selector) => {
    const strip = document.querySelector(selector)
    if (!strip) return null
    const rect = strip.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, TAB_STRIP_SELECTORS[app])
  if (!point) return null
  for (let i = 0; i < 40; i += 1) {
    const seen = await observeTabStrip({ handle, app })
    if (seen === null || (edge === 'end' ? seen.max - seen.scrollLeft <= 2 : seen.scrollLeft <= 0)) break
    await handle.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: edge === 'end' ? 300 : -300 })
    await pause(60)
  }
  await pointerAway(handle)
  await pause(1200)
  return observeTabStrip({ handle, app })
}

/**
 * LIFE-494 — 캡처 전에 두 앱의 탭 스트립이 **멈출 때까지** 기다린다. 두 앱 다 스크롤 직후 800ms 동안 썸을 보인다(`isScrolling`) —
 * 상태 주입(탭 생성·첫 탭 클릭)이 스트립을 움직인 직후 캡처하면 A 캡처에선 보이고 B 캡처에선 사라져 자기 diff 잡음이 난다
 * (R001 after-t2-a tabs-many corral `opacity 1/0`). 1초 동안 scrollLeft 가 그대로인 것을 두 번 연속 보면 멈춘 것으로 친다.
 */
export async function settleTabStrips({ orca, corral }) {
  for (const [app, handle] of [['orca', orca], ['corral', corral]]) {
    let last = await observeTabStrip({ handle, app })
    let settled = false
    for (let i = 0; i < 6 && !settled; i += 1) {
      await pause(1000)
      const now = await observeTabStrip({ handle, app })
      settled = JSON.stringify(now) === JSON.stringify(last)
      last = now
    }
    // 6초 안에 멈추지 않으면 캡처가 움직이는 스트립을 찍는다 — 조용히 넘어가지 않고 실패시킨다(LIFE-494 r1 R1-05).
    if (!settled) throw new Error(`탭 스트립 정착 시간 초과(${app}): ${JSON.stringify(last)}`)
  }
}

/** 장면을 걷을 때 탭 스트립을 맨 앞으로 — 측정 대상이 아니라 되돌리기다(직접 대입). */
async function resetTabStrip({ handle, app }) {
  await handle.cdp.evaluate((selector) => {
    const strip = document.querySelector(selector)
    if (!strip) return
    strip.scrollLeft = 0
    strip.dispatchEvent(new Event('scroll'))
  }, TAB_STRIP_SELECTORS[app])
}

export const LONG_WORKTREE_BRANCH = 'feature/LIFE-468-a-deliberately-long-worktree-branch-name-that-must-truncate-in-one-line'

const git = ({ args, cwd }) =>
  spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  })

/** 페이지 안에서 도는 관측 — 두 앱에 같은 함수를 건다. */
function observePage(sel) {
  const root = document.querySelector(sel.root)
  const header = document.querySelector(sel.repoHeader)
  const firstCard = document.querySelector(sel.cardRow)
  // 목록 스크롤러 = 첫 카드(없으면 헤더)에서 위로 올라가며 처음 만나는 세로 스크롤 요소.
  let scroller = null
  for (let el = (firstCard ?? header)?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY)) {
      scroller = el
      break
    }
  }
  const hovered = [...document.querySelectorAll(':hover')].pop() ?? null
  const scrollerRect = scroller?.getBoundingClientRect() ?? null
  const headerRect = header?.getBoundingClientRect() ?? null
  return {
    width: root ? Math.round(root.getBoundingClientRect().width) : null,
    repos: document.querySelectorAll(sel.repo).length,
    // 카드 수는 **표면**으로 센다 — Orca 는 `[data-worktree-id]` 가 카드 안쪽 요소에도 붙어 중복으로 센다(실측 R003: 카드 2장에 5개).
    cards: document.querySelectorAll(sel.card).length,
    empty: document.querySelectorAll(sel.empty).length,
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
    scrollRange: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
    // 붙은 헤더: 스크롤했는데도 헤더 윗변이 스크롤러 윗변(±1px)에 있다 = sticky.
    headerOffset: scrollerRect && headerRect ? Math.round((headerRect.top - scrollerRect.top) * 100) / 100 : null,
    hoveredCard: hovered ? (hovered.closest(sel.card) ? [...document.querySelectorAll(sel.card)].indexOf(hovered.closest(sel.card)) : -1) : null,
    hoveredRow: hovered ? (hovered.closest(sel.agentRow) ? 0 : -1) : null,
    longTitle: [...document.querySelectorAll(sel.card)].some((el) => (el.textContent ?? '').includes('deliberately-long-worktree'))
  }
}

async function observe({ handle, app }) {
  return handle.cdp.evaluate(observePage, SCENE_SELECTORS[app])
}

async function centerOf({ handle, selector, index = 0 }) {
  return handle.cdp.evaluate(
    ({ selector, index }) => {
      const el = document.querySelectorAll(selector)[index]
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const rect = el.getBoundingClientRect()
      return { x: rect.left + Math.min(rect.width / 2, 60), y: rect.top + rect.height / 2, w: rect.width }
    },
    { selector, index }
  )
}

async function mouse({ handle, type, x, y, buttons = 0 }) {
  const extra = type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }
  await handle.cdp.send('Input.dispatchMouseEvent', { type, x, y, buttons, ...extra })
  if (type === 'mouseMoved' && buttons === 0) handle.scenePointer = { x, y }
}

const AWAY_POINT = { x: 1200, y: 700 }

/**
 * 캡처 직전에 장면 포인터를 다시 건다. `Page.captureScreenshot` 이 프레임을 새로 그리면 Chromium 은 **실제 OS 커서
 * 위치**로 hover 를 다시 계산한다 — 그 창 위에 사람 커서가 있으면 CDP 로 건 hover 가 빠지고 커서 밑 요소가 hover 된다
 * (실측: corral 에서 캡처 뒤 `.session-row` hover → `xterm-screen`, 커서가 창 밖인 Orca 는 유지. iter6 R007 자기 diff 잡음).
 * 그래서 DOM 수집 전과 스크린숏 전에 마지막 장면 포인터(없으면 사이드바 밖)를 다시 보낸다.
 */
export async function reapplyPointer(handle) {
  const { x, y } = handle.scenePointer ?? AWAY_POINT
  await handle.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
}

/**
 * 「밖」 후보 — 첫 칸이 예전 고정점(AWAY_POINT)이라 그 점이 조용한 장면은 예전과 똑같다. 그 점 밑에 hover 를 받는 요소가 있으면
 * 다음 후보로 간다(LIFE-513 실측: 외관 타이포 머리에 버튼이 들어와 아래가 12px 내려가자 (1200,700) 이 첫 테마 행(button) 위에 놓였다 —
 * CDP hover 로 찍힌 A 캡처와 실제 OS 커서로 hover 를 다시 계산한 B 캡처가 갈려 자기 diff 잡음 1건, 관문 미달 R004·R005).
 */
const AWAY_POINTS = [AWAY_POINT, { x: 1435, y: 895 }, { x: 1435, y: 5 }, { x: 720, y: 895 }]

/** 포인터를 사이드바 밖으로 — hover 칠이 다음 캡처에 남지 않게. 누를 수 있는 요소 위는 피한다. */
async function pointerAway(handle) {
  const point = await handle.cdp.evaluate((points) => {
    const interactive = 'button, a, input, select, textarea, [role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="switch"], [role="radio"]'
    return points.find((p) => { const hit = document.elementFromPoint(p.x, p.y); return hit === null || hit.closest(interactive) === null }) ?? points[0]
  }, AWAY_POINTS)
  await mouse({ handle, type: 'mouseMoved', x: point?.x ?? AWAY_POINT.x, y: point?.y ?? AWAY_POINT.y })
}

/**
 * LIFE-496 K3ⓑ — 탭바 `+` 드롭다운. 두 앱 다 **실제 마우스**로 `+` 를 눌러 연다(Orca Radix 트리거는 pointerdown 에 연다 — CDP mousePressed).
 * 질의는 포커스된 입력창에 `Input.insertText`(두 앱 같은 경로 — 키 입력과 같은 input 이벤트).
 * Orca 는 첫 영역의 탭바 표면 직계 `+`(tabbar.json `tab-add` 와 같은 선택자), corral 은 첫 영역의 `[data-main-tabbar-add]`.
 */
export const NEW_TAB_MENU_SELECTORS = {
  orca: { trigger: '[data-native-file-drop-target="editor"] > button[aria-haspopup]', menu: '[data-slot="dropdown-menu-content"]', input: '[data-slot="dropdown-menu-content"] input[role="combobox"]', results: '[data-slot="dropdown-menu-content"] [role="option"]', items: '[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-item"]' },
  corral: { trigger: '[data-main-tabbar-add]', menu: '[data-tab-create-menu]', input: '[data-tab-create-input]', results: '[data-tab-create-result]', items: '[data-tab-create-item]' },
}

function observeNewTabMenuPage(sel) {
  const menu = document.querySelector(sel.menu)
  const input = document.querySelector(sel.input)
  return { open: menu !== null, inputFocused: input !== null && input === document.activeElement, value: input?.value ?? null, results: document.querySelectorAll(sel.results).length, items: document.querySelectorAll(sel.items).length }
}

async function observeNewTabMenu({ handle, app }) {
  return handle.cdp.evaluate(observeNewTabMenuPage, NEW_TAB_MENU_SELECTORS[app])
}

async function openNewTabMenu({ handle, app, query }) {
  const sel = NEW_TAB_MENU_SELECTORS[app]
  if (!(await click({ handle, selector: sel.trigger }))) return
  await until(async () => (await observeNewTabMenu({ handle, app })).inputFocused, `${app} + 메뉴 입력창 포커스`, 5_000).catch(() => null)
  if (query) {
    await handle.cdp.send('Input.insertText', { text: query })
    await until(async () => (await observeNewTabMenu({ handle, app })).value === query, `${app} + 메뉴 질의`, 5_000).catch(() => null)
    // 두 앱 다 결과를 deferred 로 그린다(Orca useDeferredValue) — 결과 줄이 멈출 때까지.
    await pause(600)
  }
}

async function closeNewTabMenu({ handle, app }) {
  if (!(await observeNewTabMenu({ handle, app })).open) return
  for (const type of ['keyDown', 'keyUp']) await handle.cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(async () => !(await observeNewTabMenu({ handle, app })).open, `${app} + 메뉴 닫힘`, 5_000).catch(() => null)
}

/**
 * LIFE-511 K7ⓐ — 설정 페이지. 두 앱 다 **실제 마우스**로 ⚙ 를 누르고(Orca 사이드바 하단 Settings 버튼 — 로케일에 따라 aria-label 이
 * Settings/설정, 510 c5-1 실패 원인), 열림을 관측한 뒤 내비의 「단축키」 행을 실제 마우스로 눌러 **같은 섹션**에 세운다(corral T1 섹션은
 * 단축키 하나 — Orca 기본 섹션 「일반」 과 견주면 섹션 헤더 글이 갈려 거짓 차이가 된다). 내비 클릭은 포커스도 두 앱에서 같은 자리(내비 버튼)에
 * 둔다 — corral 은 열 때 검색창이 포커스를 갖고 Orca 도 일반 진입은 검색창 autofocus 다.
 * Orca 내비 행에는 안정 data 속성이 없어 「단축키」 행은 **글자**로 찾는다(짝 키가 아니라 장면을 만드는 손잡이일 뿐 — 짝짓기는 aria-current).
 * 닫기는 Esc. corral 단축키 섹션은 Esc 2단계라 한 번에 안 닫히면 2.2초 안에 한 번 더 누른다(Orca 198 도 단축키 섹션에서 같다).
 */
export const SETTINGS_SELECTORS = {
  orca: { open: 'button[aria-label="Settings"], button[aria-label="설정"]', page: '.settings-view-shell', section: '[data-settings-section]', nav: '.settings-view-shell aside button', activeNav: '.settings-view-shell aside button[aria-current="page"]', terminalCard: 'button[aria-controls="appearance-section-terminal"]' },
  corral: { open: '[data-settings-open]', page: '[data-settings-page]', section: '[data-settings-section]', nav: '[data-settings-nav-item]', activeNav: '[data-settings-nav-item][aria-current="page"]', terminalCard: '[data-settings-collapsible="terminal"] > button' },
}
// LIFE-512 K5ⓓ — 섹션별 내비 글자. `settingsOpen: true` 는 단축키(511), `settingsOpen: 'appearance'` 는 외관 섹션이다.
const SETTINGS_NAV_TEXT = { shortcuts: ['단축키', 'Shortcuts', 'Keyboard Shortcuts'], appearance: ['외관', 'Appearance'] }
/** 장면의 `settingsOpen` 값 → 세울 섹션 id. 511 장면은 `true` 를 쓴다. */
export function settingsSectionOf(settingsOpen) {
  return settingsOpen === true ? 'shortcuts' : settingsOpen
}

function observeSettingsPage(sel) {
  const section = document.querySelector(sel.section)
  const active = document.querySelector(sel.activeNav)
  const terminalCard = document.querySelector(sel.terminalCard)
  return {
    terminalCardOpen: terminalCard === null ? null : terminalCard.getAttribute('aria-expanded') === 'true',
    open: document.querySelector(sel.page) !== null,
    section: section?.getAttribute('data-settings-section') ?? null,
    activeNav: active?.textContent?.trim() ?? null,
    focusInNav: document.activeElement !== null && document.activeElement.matches(sel.nav),
  }
}

async function observeSettings({ handle, app }) {
  return handle.cdp.evaluate(observeSettingsPage, SETTINGS_SELECTORS[app])
}

async function openSettings({ handle, app, section = 'shortcuts' }) {
  const sel = SETTINGS_SELECTORS[app]
  if (!(await click({ handle, selector: sel.open }))) return
  await until(async () => (await observeSettings({ handle, app })).open, `${app} 설정 열림`, 10_000).catch(() => null)
  // 내비의 섹션 행(「단축키」·「외관」) — 글자로 찾아 표식을 달고 그 표식을 실제 마우스로 누른다.
  const marked = await handle.cdp.evaluate(({ nav, texts }) => {
    const button = [...document.querySelectorAll(nav)].find((el) => texts.includes((el.textContent ?? '').trim()))
    if (!button) return false
    button.setAttribute('data-l511-shortcuts-nav', '')
    return true
  }, { nav: sel.nav, texts: SETTINGS_NAV_TEXT[section] })
  if (!marked) return
  await click({ handle, selector: '[data-l511-shortcuts-nav]' })
  await handle.cdp.evaluate(() => { document.querySelector('[data-l511-shortcuts-nav]')?.removeAttribute('data-l511-shortcuts-nav'); return true })
  await until(async () => (await observeSettings({ handle, app })).section === section, `${app} 설정 › ${section}`, 10_000).catch(() => null)
  await pause(400)
}

/**
 * LIFE-512 U5 — 터미널 테마를 **제품 경로로** 바꾼다: 설정 › 외관을 실제 마우스로 열고 → 테마 목록의 행을 실제 마우스로 누르고 → Esc 로 닫는다.
 * Orca 테마 행에는 data 속성이 없어 글자로 찾아 표식을 단다(장면 손잡이일 뿐 짝 키가 아니다). 행이 목록 스크롤 밖이면 누르지 않고 실패로 남긴다.
 */
/** 테마 배경을 칠하는 표면 — Orca 는 pane-manager 루트 `[data-terminal-layout-leaf-ids]`(`pane-divider.ts:92` applyRootBackground), corral 은 pane 상자(`--term-bg`). 장면 확인용. */
const TERMINAL_BG_SELECTORS = { orca: '[data-terminal-layout-leaf-ids]', corral: '.term-pane' }
const THEME_OPTION_SELECTORS = { orca: '#appearance-section-terminal [data-slot="scroll-area-viewport"] button', corral: '[data-settings-theme-option]' }
async function selectTerminalTheme({ handle, app, name }) {
  await openSettings({ handle, app, section: 'appearance' })
  const marked = await handle.cdp.evaluate(({ selector, name }) => {
    const button = [...document.querySelectorAll(selector)].find((el) => (el.getAttribute('data-settings-theme-option') ?? el.querySelector('span span')?.textContent ?? '').trim() === name)
    if (!button) return false
    button.setAttribute('data-l512-theme-option', '')
    return true
  }, { selector: THEME_OPTION_SELECTORS[app], name })
  if (marked) {
    await click({ handle, selector: '[data-l512-theme-option]' })
    await handle.cdp.evaluate(() => { document.querySelector('[data-l512-theme-option]')?.removeAttribute('data-l512-theme-option'); return true })
    await pause(400)
  }
  await closeSettings({ handle, app })
  await pause(400)
}

async function closeSettings({ handle, app }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await observeSettings({ handle, app })).open) return
    for (const type of ['keyDown', 'keyUp']) await handle.cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await pause(300)
  }
  // 닫기 실패는 **실패로 올린다**(r1 R1-05) — 삼키면 설정이 덮인 화면에서 다음 상태를 「기본」 으로 잰다. `until` 이 시간초과면 throw 한다.
  await until(async () => !(await observeSettings({ handle, app })).open, `${app} 설정 닫힘`, 5_000)
}

async function click({ handle, selector }) {
  const point = await centerOf({ handle, selector })
  if (!point) return false
  await mouse({ handle, type: 'mouseMoved', x: point.x, y: point.y })
  await mouse({ handle, type: 'mousePressed', x: point.x, y: point.y, buttons: 1 })
  await mouse({ handle, type: 'mouseReleased', x: point.x, y: point.y })
  await pointerAway(handle)
  return true
}

/** 리사이저를 **실제 마우스로** 끈다 — 두 앱 다 제품 드래그 경로(rAF 배칭 + 놓을 때 커밋). */
async function dragWidth({ handle, app, target }) {
  const sel = SCENE_SELECTORS[app]
  const before = (await observe({ handle, app })).width
  if (before === null || before === target) return before
  // 손잡이의 **실제로 눌리는 점**을 찾는다 — Orca 손잡이(`-right-1.5`, 12px)는 오른쪽 절반이 본문 영역 밑에 깔려 가운데를
  // 누르면 본문이 받는다(실측: elementFromPoint 가 본문 div). 왼쪽부터 훑어 손잡이(또는 그 자식)가 맞는 첫 점을 쓴다.
  const point = await handle.cdp.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const y = rect.top + Math.min(rect.height / 2, 300)
    for (let dx = 0; dx < rect.width; dx += 1) {
      const hit = document.elementFromPoint(rect.left + dx + 0.5, y)
      if (hit && el.contains(hit)) return { x: rect.left + dx + 0.5, y }
    }
    return null
  }, sel.resizer)
  if (!point) return before
  const delta = target - before
  await mouse({ handle, type: 'mouseMoved', x: point.x, y: point.y })
  await mouse({ handle, type: 'mousePressed', x: point.x, y: point.y, buttons: 1 })
  const steps = 8
  for (let i = 1; i <= steps; i += 1) {
    await mouse({ handle, type: 'mouseMoved', x: point.x + (delta * i) / steps, y: point.y, buttons: 1 })
    await pause(16)
  }
  await mouse({ handle, type: 'mouseReleased', x: point.x + delta, y: point.y })
  await pointerAway(handle)
  await pause(200)
  return (await observe({ handle, app })).width
}

async function setScroll({ handle, app, top }) {
  return handle.cdp.evaluate(
    ({ sel, top }) => {
      const first = document.querySelector(sel.cardRow) ?? document.querySelector(sel.repoHeader)
      for (let el = first?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
          el.scrollTop = top
          el.dispatchEvent(new Event('scroll'))
          return Math.round(el.scrollTop)
        }
      }
      return null
    },
    { sel: SCENE_SELECTORS[app], top }
  )
}

/** 레포 묶음이 접혔나 — 헤더는 있는데 카드가 0. */
const isCollapsed = (seen) => seen.repos > 0 && seen.cards === 0

async function setCollapsed({ handle, app, want }) {
  const seen = await observe({ handle, app })
  if (seen.repos === 0 || isCollapsed(seen) === want) return true
  await click({ handle, selector: SCENE_SELECTORS[app].repoHeader })
  try {
    await until(async () => isCollapsed(await observe({ handle, app })) === want, `${app} 레포 접힘=${want}`, 10_000)
    return true
  } catch {
    return false
  }
}

async function refreshWorktrees({ orca, corral, orcaRepoId, expected }) {
  await until(
    async () => {
      const count = await orca.cdp.evaluate(async (repoId) => {
        const store = window.__store
        await store.getState().fetchWorktrees(repoId)
        return document.querySelectorAll('[data-worktree-card-surface]').length
      }, orcaRepoId)
      return count === expected
    },
    `orca 카드 ${expected}장`,
    60_000,
    500
  )
  let last = 0
  await until(
    async () => {
      const now = Date.now()
      if (now - last > 2_000) {
        last = now
        await rpc(corral.control, { cmd: 'rebuild-tree' }, 20_000).catch(() => null)
      }
      return (await corral.cdp.evaluate(() => document.querySelectorAll('[data-worktree-card-surface]').length)) === expected
    },
    `corral 카드 ${expected}장`,
    60_000,
    500
  )
}

/** 긴 이름 워크트리를 fixture 에 **더하거나 뺀다** — 두 앱이 같은 git 상태를 다시 읽는다. */
async function setLongWorktree({ orca, corral, orcaRepoId, fixture, want }) {
  const wtPath = path.join(path.dirname(fixture.root), 'gui-diff-fixture-long')
  const exists = fs.existsSync(wtPath)
  if (want && !exists) {
    const added = git({ args: ['worktree', 'add', '-b', LONG_WORKTREE_BRANCH, wtPath], cwd: fixture.root })
    if (added.status !== 0) {
      // 브랜치가 남아 있으면 그 브랜치로 다시 붙인다.
      const again = git({ args: ['worktree', 'add', wtPath, LONG_WORKTREE_BRANCH], cwd: fixture.root })
      if (again.status !== 0) throw new Error(`[scene] git worktree add: ${added.stderr}${again.stderr}`)
    }
  } else if (!want && exists) {
    git({ args: ['worktree', 'remove', '--force', wtPath], cwd: fixture.root })
    git({ args: ['branch', '-D', LONG_WORKTREE_BRANCH], cwd: fixture.root })
  } else if (!want && !exists) {
    // 지난 회차가 남긴 브랜치 — 워크트리가 없으면 카드도 없다. 지우기만 한다.
    git({ args: ['branch', '-D', LONG_WORKTREE_BRANCH], cwd: fixture.root })
    return
  }
  await refreshWorktrees({ orca, corral, orcaRepoId, expected: want ? 3 : 2 })
}

/** 회차 시작 때 fixture 를 기본 모양(워크트리 2개)으로 — 앞 회차가 남긴 긴 워크트리를 걷는다. 앱을 띄우기 **전에** 부른다. */
export function resetFixtureScene(fixture) {
  const wtPath = path.join(path.dirname(fixture.root), 'gui-diff-fixture-long')
  if (fs.existsSync(wtPath)) git({ args: ['worktree', 'remove', '--force', wtPath], cwd: fixture.root })
  git({ args: ['worktree', 'prune'], cwd: fixture.root })
  git({ args: ['branch', '-D', LONG_WORKTREE_BRANCH], cwd: fixture.root })
}

/**
 * 장면을 기본으로 되돌린다 — 포인터 치움 · 뷰포트 · 스크롤 0 · 펼침 · 긴 워크트리 없음 · 기본 폭.
 * 빈 목록(레포 제거)은 되돌리지 않는다 — 그래서 `empty` 는 `--states` 의 맨 끝에 둔다.
 */
export async function resetScene({ orca, corral, orcaRepoId, fixture, base }) {
  for (const [app, handle] of [['orca', orca], ['corral', corral]]) {
    // 설정이 열려 있으면 사이드바·탭바가 가려져 아래 되돌리기가 헛돈다 — 먼저 닫는다(LIFE-511).
    await closeSettings({ handle, app })
    await closeNewTabMenu({ handle, app })
    await pointerAway(handle)
    await setViewport(handle.cdp, { width: base.width, height: base.height })
    await setScroll({ handle, app, top: 0 })
    await resetTabStrip({ handle, app })
    await setCollapsed({ handle, app, want: false })
    if ((await observe({ handle, app })).width !== base.sidebarWidth[app]) await dragWidth({ handle, app, target: base.sidebarWidth[app] })
  }
  if (fs.existsSync(path.join(path.dirname(fixture.root), 'gui-diff-fixture-long'))) {
    await setLongWorktree({ orca, corral, orcaRepoId, fixture, want: false })
  }
}

/**
 * 장면을 건다. `scene` 키:
 *   hover: 'card'(둘째 카드 — 비선택) | 'row'(첫 에이전트 행) · collapsed · longWorktree ·
 *   viewportHeight + scroll(sticky) · width(px) · empty · tabStripEnd / tabStripStart(LIFE-494 — 탭 스트립을 휠로 끝·맨 앞까지)
 * 돌려주는 값: `{ requested, orca, corral, ok }` — 관측은 두 앱에서 같은 함수로 읽는다.
 */
export async function applyScene({ orca, corral, orcaRepoId, fixture, base, scene }) {
  if (!scene) return null
  if (scene.longWorktree) await setLongWorktree({ orca, corral, orcaRepoId, fixture, want: true })
  if (scene.empty) {
    // Orca: 「Remove Project」 확인 대화상자가 부르는 스토어 동작(`RemoveFolderDialog.tsx:79` `removeProject`) — IPC 만 부르면
    // 스토어의 워크트리 카드가 남는다(실측 R005: 레포 0 · 카드 2).
    await orca.cdp.evaluate(async (repoId) => {
      await window.__store.getState().removeProject(repoId, { errorFeedback: 'toast' })
    }, orcaRepoId)
    await corral.cdp.evaluate(async (root) => window.corral.removeRepo(root), fixture.root)
    for (const [app, handle] of [['orca', orca], ['corral', corral]]) {
      await until(async () => (await observe({ handle, app })).repos === 0, `${app} 레포 0개`, 30_000).catch(() => null)
    }
  }
  const out = { requested: scene }
  for (const [app, handle] of [['orca', orca], ['corral', corral]]) {
    if (scene.width) await dragWidth({ handle, app, target: scene.width })
    if (scene.viewportHeight) await setViewport(handle.cdp, { width: base.width, height: scene.viewportHeight })
    if (scene.collapsed) await setCollapsed({ handle, app, want: true })
    if (scene.scroll) {
      await pause(300)
      await setScroll({ handle, app, top: scene.scroll })
      await pause(300)
    }
    if (scene.tabStripEnd) await wheelTabStripTo({ handle, app, edge: 'end' })
    if (scene.tabStripStart) await wheelTabStripTo({ handle, app, edge: 'start' })
    if (scene.newTabMenu) await openNewTabMenu({ handle, app, query: scene.newTabMenu.query ?? '' })
    if (scene.terminalTheme) await selectTerminalTheme({ handle, app, name: scene.terminalTheme })
    if (scene.settingsOpen) await openSettings({ handle, app, section: settingsSectionOf(scene.settingsOpen) })
    if (scene.hover) {
      const sel = SCENE_SELECTORS[app]
      const point = scene.hover === 'card' ? await centerOf({ handle, selector: sel.card, index: 1 }) : await centerOf({ handle, selector: sel.agentRow, index: 0 })
      if (point) await mouse({ handle, type: 'mouseMoved', x: point.x, y: point.y })
      await pause(250)
    }
    out[app] = { ...(await observe({ handle, app })), terminalBg: await handle.cdp.evaluate((selector) => { const el = document.querySelector(selector); return el ? getComputedStyle(el).backgroundColor : null }, TERMINAL_BG_SELECTORS[app]), tabStrip: await observeTabStrip({ handle, app }), newTabMenu: scene.newTabMenu ? await observeNewTabMenu({ handle, app }) : null, settings: await observeSettings({ handle, app }) }
  }
  const check = (seen) => {
    if (!seen) return false
    if (scene.hover === 'card' && seen.hoveredCard !== 1) return false
    if (scene.hover === 'row' && seen.hoveredRow !== 0) return false
    if (scene.collapsed && !isCollapsed(seen)) return false
    if (scene.longWorktree && !(seen.cards === 3 && seen.longTitle)) return false
    // sticky: 실제로 스크롤됐고(범위 안), 헤더가 스크롤러 윗변 ±1px 에 붙어 있다.
    if (scene.scroll && !(seen.scrollTop > 0 && seen.headerOffset !== null && Math.abs(seen.headerOffset) <= 1)) return false
    if (scene.width && seen.width !== scene.width) return false
    // 테마(512 U5): 테마 배경을 칠하는 표면의 계산 색이 기대 색이다 — 클릭이 빗나가 기본 테마로 잰 회차를 막는다.
    if (scene.terminalThemeBg && seen.terminalBg !== scene.terminalThemeBg) return false
    if (scene.empty && !(seen.repos === 0 && seen.empty > 0)) return false
    // 탭 스트립 끝: 실제로 넘쳐 스크롤됐고(> 0) 끝까지 2px 안.
    if (scene.tabStripEnd && !(seen.tabStrip && seen.tabStrip.scrollLeft > 0 && seen.tabStrip.max - seen.tabStrip.scrollLeft <= 2)) return false
    // 탭 스트립 맨 앞: 넘친 채로(max > 0) 0. 활성 첫 탭이 제자리라 dock 이 없다.
    if (scene.tabStripStart && !(seen.tabStrip && seen.tabStrip.max > 0 && seen.tabStrip.scrollLeft === 0 && seen.tabStrip.docked === null)) return false
    // + 메뉴: 열렸고 입력창이 포커스를 가졌고 질의가 들어갔다. 질의가 있으면 결과 줄이 하나 이상, 없으면 정적 항목이 하나 이상.
    if (scene.newTabMenu) {
      const menu = seen.newTabMenu
      const query = scene.newTabMenu.query ?? ''
      if (!(menu && menu.open && menu.inputFocused && menu.value === query)) return false
      if (query ? menu.results === 0 : menu.items === 0) return false
    }
    // 설정: 열렸고 단축키 섹션이 서 있고 내비의 활성 행이 있고 포커스가 내비 버튼에 있다(두 앱 같은 자리).
    if (scene.settingsOpen) {
      const settings = seen.settings
      if (!(settings && settings.open && settings.section === settingsSectionOf(scene.settingsOpen) && settings.activeNav !== null && settings.focusInNav)) return false
      // 외관(512): 「터미널」 카드가 펼쳐져 있다 — 두 앱 다 펼친 채 시작한다(Orca AppearancePane.tsx:90, corral SettingsCollapsibleCard).
      if (scene.settingsOpen === 'appearance' && settings.terminalCardOpen !== true) return false
    } else if (!seen.settings || seen.settings.open) {
      // 설정이 없어야 할 장면 — 관측을 못 했거나 열려 있으면 실패(r1 R1-05). 「안 봤다」 를 「닫혔다」 로 읽지 않는다.
      return false
    }
    return true
  }
  out.orcaOk = check(out.orca)
  out.corralOk = check(out.corral)
  out.ok = out.orcaOk && out.corralOk
  return out
}

/** 장면 축의 사람이 읽는 값. */
export function describeScene(seen) {
  if (!seen) return '(관측 없음)'
  const strip = seen.tabStrip ? ` · 탭 스트립 ${seen.tabStrip.scrollLeft}/${seen.tabStrip.max} dock ${seen.tabStrip.docked ?? '없음'}` : ''
  const menu = seen.newTabMenu ? ` · + 메뉴 ${seen.newTabMenu.open ? '열림' : '닫힘'} 입력포커스 ${seen.newTabMenu.inputFocused} 질의 "${seen.newTabMenu.value ?? ''}" 결과 ${seen.newTabMenu.results} 항목 ${seen.newTabMenu.items}` : ''
  const themeBg = seen.terminalBg ? ` · 터미널 배경 ${seen.terminalBg}` : ''
  const settings = seen.settings ? ` · 설정 ${seen.settings.open ? '열림' : '닫힘'} 섹션 ${seen.settings.section} 활성 「${seen.settings.activeNav}」 포커스 내비 ${seen.settings.focusInNav}${seen.settings.terminalCardOpen === null ? '' : ` 터미널 카드 ${seen.settings.terminalCardOpen ? '펼침' : '접힘'}`}` : ''
  return `폭 ${seen.width} · 레포 ${seen.repos} · 카드 ${seen.cards} · 긴이름 ${seen.longTitle} · 스크롤 ${seen.scrollTop}/${seen.scrollRange} · 헤더 오프셋 ${seen.headerOffset} · hover 카드#${seen.hoveredCard} 행#${seen.hoveredRow} · 빈목록 ${seen.empty}${strip}${menu}${settings}${themeBg}`
}
