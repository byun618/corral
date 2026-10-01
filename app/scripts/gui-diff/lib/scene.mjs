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

export const LONG_WORKTREE_BRANCH = 'feature/LIFE-468-a-deliberately-long-worktree-branch-name-that-must-truncate-in-one-line'

const git = (args, cwd) =>
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

/** 포인터를 사이드바 밖으로 — hover 칠이 다음 캡처에 남지 않게. */
async function pointerAway(handle) {
  await mouse({ handle, type: 'mouseMoved', x: AWAY_POINT.x, y: AWAY_POINT.y })
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
    const added = git(['worktree', 'add', '-b', LONG_WORKTREE_BRANCH, wtPath], fixture.root)
    if (added.status !== 0) {
      // 브랜치가 남아 있으면 그 브랜치로 다시 붙인다.
      const again = git(['worktree', 'add', wtPath, LONG_WORKTREE_BRANCH], fixture.root)
      if (again.status !== 0) throw new Error(`[scene] git worktree add: ${added.stderr}${again.stderr}`)
    }
  } else if (!want && exists) {
    git(['worktree', 'remove', '--force', wtPath], fixture.root)
    git(['branch', '-D', LONG_WORKTREE_BRANCH], fixture.root)
  } else if (!want && !exists) {
    // 지난 회차가 남긴 브랜치 — 워크트리가 없으면 카드도 없다. 지우기만 한다.
    git(['branch', '-D', LONG_WORKTREE_BRANCH], fixture.root)
    return
  }
  await refreshWorktrees({ orca, corral, orcaRepoId, expected: want ? 3 : 2 })
}

/** 회차 시작 때 fixture 를 기본 모양(워크트리 2개)으로 — 앞 회차가 남긴 긴 워크트리를 걷는다. 앱을 띄우기 **전에** 부른다. */
export function resetFixtureScene(fixture) {
  const wtPath = path.join(path.dirname(fixture.root), 'gui-diff-fixture-long')
  if (fs.existsSync(wtPath)) git(['worktree', 'remove', '--force', wtPath], fixture.root)
  git(['worktree', 'prune'], fixture.root)
  git(['branch', '-D', LONG_WORKTREE_BRANCH], fixture.root)
}

/**
 * 장면을 기본으로 되돌린다 — 포인터 치움 · 뷰포트 · 스크롤 0 · 펼침 · 긴 워크트리 없음 · 기본 폭.
 * 빈 목록(레포 제거)은 되돌리지 않는다 — 그래서 `empty` 는 `--states` 의 맨 끝에 둔다.
 */
export async function resetScene({ orca, corral, orcaRepoId, fixture, base }) {
  for (const [app, handle] of [['orca', orca], ['corral', corral]]) {
    await pointerAway(handle)
    await setViewport(handle.cdp, { width: base.width, height: base.height })
    await setScroll({ handle, app, top: 0 })
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
 *   viewportHeight + scroll(sticky) · width(px) · empty
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
    if (scene.hover) {
      const sel = SCENE_SELECTORS[app]
      const point = scene.hover === 'card' ? await centerOf({ handle, selector: sel.card, index: 1 }) : await centerOf({ handle, selector: sel.agentRow, index: 0 })
      if (point) await mouse({ handle, type: 'mouseMoved', x: point.x, y: point.y })
      await pause(250)
    }
    out[app] = await observe({ handle, app })
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
    if (scene.empty && !(seen.repos === 0 && seen.empty > 0)) return false
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
  return `폭 ${seen.width} · 레포 ${seen.repos} · 카드 ${seen.cards} · 긴이름 ${seen.longTitle} · 스크롤 ${seen.scrollTop}/${seen.scrollRange} · 헤더 오프셋 ${seen.headerOffset} · hover 카드#${seen.hoveredCard} 행#${seen.hoveredRow} · 빈목록 ${seen.empty}`
}
