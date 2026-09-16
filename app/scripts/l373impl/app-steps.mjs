// F1·F2·F3 하네스가 같이 쓰는 앱 조작·관측 조각. 재는 도구는 하나여야 회차 사이가 비교된다.
//
// 앱 구동·control 채널은 l353 lib 을 그대로 쓴다(관문 ④의 격리 가드도 거기 있다).
// 여기 있는 것은 **corral 화면을 어떻게 몰고 무엇을 읽는가**뿐이다.

import { until, sleep, herdrRequest, REPO_DIR } from '../l353/lib.mjs'

export const tabsOf = (state) => state.repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? [])
export const resizeEvents = (app, since) =>
  app.entries().filter((e) => e.tag === 'vendor.debug' && e.message === 'resize request' && e.at >= since)
export const syncEvents = (app, since) => app.entries().filter((e) => e.tag === 'stream.sync' && e.at >= since)

export async function snapshot(app, label) {
  const state = await app.state()
  const count = async (selector) => (await app.query(selector)).found.length
  return {
    label,
    영역수: await count('[data-tab-group]'),
    헤더수: await count('[data-group-header]'),
    경계선: await count('[data-group-divider]'),
    빈영역: await count('[data-empty-group]'),
    터미널상자: await count('[data-term-group]'),
    탭바탭: await count('[data-main-tab]'),
    접힌탭: await count('[data-tab-compact="true"]'),
    활성영역: (await app.send({ cmd: 'eval', code: `document.querySelector('.tab-group.is-active-group')?.dataset.tabGroup ?? null` })).result,
    영역별탭: (await app.send({
      cmd: 'eval',
      code: `[...document.querySelectorAll('[data-tab-group]')].map((g) => ({ groupId: g.dataset.tabGroup, tabs: [...g.querySelectorAll('[data-main-tab]')].map((t) => t.dataset.mainTab) }))`,
    })).result,
    연결: state.terminalGroups.map((g) => ({ groupId: g.groupId, tabId: g.tabId, phase: g.phase, grid: g.grid })),
  }
}

/**
 * 탭을 `want` 개까지 채운다.
 *
 * 2개는 F1-1 의 바닥이다(원 영역 탭이 하나뿐이면 분할이 무효다). 4개인 이유는 F1-7 —
 * 분할 뒤 한 영역에 3개가 남아야 760px 창에서 탭 폭 합(3×124=372)이 남는 폭을 넘어 접힌다.
 */
export async function ensureTabs(app, want) {
  const state = await app.state()
  const workspaceId = state.repos.flatMap((r) => r.worktrees).find((w) => w.workspace !== null)?.workspace.workspaceId ?? null
  if (workspaceId === null) throw new Error('열린 workspace 가 없다')
  while (tabsOf(await app.state()).length < want) {
    const before = tabsOf(await app.state()).length
    await herdrRequest('tab.create', { workspace_id: workspaceId })
    await until(async () => tabsOf(await app.state()).length > before, { what: '탭 생성 반영' })
    await sleep(300)
  }
  await sleep(600)
  return workspaceId
}

/** 탭 우클릭 → 「오른쪽/아래 영역으로」 — 실제 UI 경로로 연다 (F1-1). */
export async function moveTabToNewGroup(app, { tabId, direction = 'right' }) {
  const item = direction === 'right' ? 'data-tab-menu-move-right' : 'data-tab-menu-move-down'
  await app.send({
    cmd: 'eval',
    code: `document.querySelector('[data-main-tab="${tabId}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 40 })), 1`,
  })
  await until(async () => (await app.query(`[${item}="${tabId}"]`)).found.length > 0, { what: '탭 메뉴' })
  const hit = await app.click(`[${item}="${tabId}"]`)
  await until(async () => (await app.query('[data-tab-group]')).found.length === 2, { what: '영역 2개', timeoutMs: 5000 })
  await sleep(900)
  return hit.hit === true
}

/**
 * 격자 요청이 **멎을 때까지** 기다린다.
 *
 * 창 크기 조절(F1-7 폭 3점)이 만든 resize 가 드래그 시작 직후에 늦게 떨어지면 "끄는 동안 0" 이
 * 거짓으로 깨진다 — 실제로 한 회차에서 가로 드래그만 2/1 로 찍혔고, 세로는 같은 코드로 0/0
 * 이었다. 고정 sleep 으로 맞추면 다음에 또 흔들린다. 잠잠해진 뒤부터 센다.
 */
export async function quiesce(app, { quietMs = 900, timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let mark = Date.now()
  while (Date.now() < deadline) {
    const last = Math.max(
      resizeEvents(app, 0).at(-1)?.at ?? 0,
      syncEvents(app, 0).at(-1)?.at ?? 0,
    )
    if (last > mark) mark = last
    if (Date.now() - mark >= quietMs) return true
    await sleep(150)
  }
  return false
}

/**
 * 경계 하나를 실제로 끌어 본다 (F1-2). **끄는 동안 격자 요청이 한 번도 나가면 안 된다.**
 *
 * 가로·세로를 같은 절차로 잰다 — 세로는 각 쪽에 탭바가 얹혀 `overhead ≠ 0` 이고 배지가 rows 라,
 * 가로만 재면 스냅 산술의 절반이 화면에서 한 번도 안 돈다.
 */
export async function dragDivider(app, { selector, direction, shot, step = 9, steps = 12 }) {
  const row = direction === 'row'
  await quiesce(app)
  const since = Date.now()
  const begin = (await app.send({
    cmd: 'eval',
    code: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (el === null) return null
      const box = el.getBoundingClientRect()
      const y = box.top + box.height / 2
      const x = box.left + box.width / 2
      window.__l373drag = { y, x, from: ${row ? 'x' : 'y'} }
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }))
      const walk = []
      for (let i = 1; i <= ${steps}; i++) {
        const at = window.__l373drag.from - i * ${step}
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${row ? 'at' : 'x'}, clientY: ${row ? 'y' : 'at'} }))
        walk.push(at)
      }
      return { steps: walk.length, to: walk.at(-1) }
    })()`,
  })).result
  // 고스트·배지는 React 가 **다시 그린 뒤에** 읽는다 — 같은 eval 안에서 읽으면 mousemove 가
  // 예약한 setState 가 아직 안 돌아 늘 null 이다 (첫 회차의 `badge: null` 이 그 허깨비였다).
  await sleep(500)
  const 고스트 = (await app.send({
    cmd: 'eval',
    code: `(() => {
      const badge = document.querySelector('[data-group-divider-badge]')
      const ghost = document.querySelector('.group-divider-ghost')
      return { 배지: badge ? badge.textContent : null, 고스트: ghost !== null, 위치: ghost ? ghost.style.${row ? 'left' : 'top'} : null }
    })()`,
  })).result
  const 드래그중 = { resize: resizeEvents(app, since).length, sync: syncEvents(app, since).length }
  await app.shot(shot)
  const beforeUp = Date.now()
  await app.send({
    cmd: 'eval',
    code: `(() => {
      const d = window.__l373drag
      const at = d.from - ${steps * step}
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${row ? 'at' : 'd.x'}, clientY: ${row ? 'd.y' : 'at'} }))
      return 1
    })()`,
  })
  await sleep(1400)
  return {
    방향: direction,
    시작: begin,
    고스트,
    드래그중,
    커밋후: { resize: resizeEvents(app, beforeUp).length, sync: syncEvents(app, beforeUp).length },
    // 스냅이 먹었으면 배지가 말한 칸 수 = 실제 요청 격자다. 다르면 산술이 어디서 갈렸는지 숫자로 뜬다.
    격자: (await app.state()).terminalGroups.map((g) => ({ groupId: g.groupId, grid: g.grid })),
    산술: (await app.send({
      cmd: 'eval',
      code: `(() => {
        const split = document.querySelector('[data-group-split]')
        const sides = [...split.querySelectorAll(':scope > .group-split-side')]
        const axis = (el) => {
          const box = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return { rect: +box.${row ? 'width' : 'height'}.toFixed(3), computed: style.${row ? 'width' : 'height'}, parseInt: Number.parseInt(style.${row ? 'width' : 'height'}, 10) }
        }
        return {
          분할상자: +split.getBoundingClientRect().${row ? 'width' : 'height'}.toFixed(3),
          셀: window.corralTermProbe ? window.corralTermProbe.cell() : null,
          쪽: sides.map((side) => ({
            basis: side.style.flexBasis,
            상자: axis(side),
            터미널: (() => { const t = side.querySelector('[data-term-group]'); return t === null ? null : axis(t) })(),
          })),
        }
      })()`,
    })).result,
    고스트사라짐: (await app.query('.group-divider-ghost')).found.length === 0,
  }
}

/**
 * 저장소를 등록하고 **이 worktree 에 열린** workspace 의 탭을 눌러 스트리밍까지 데려간다.
 *
 * l353 의 `attachPane` 을 안 쓴다. 그건 `firstPaneId()`(목록의 첫 pane)를 전제로 하는데 격리
 * 세션에는 다른 cwd 의 workspace 도 산다 — 실측: `life373-impl` 의 w1 은 `/private/tmp` 다.
 * corral 은 worktree 경로로 workspace 를 묶으므로 그런 pane 은 4단 목록에 아예 안 뜨고
 * `attachPane` 이 "pane 행이 목록에 안 떴다"로 죽는다. 여기서는 **앱이 보는 것**을 따라간다.
 */
export async function attachThisWorktree(app) {
  await app.addRepo(REPO_DIR)
  const found = await until(
    async () => {
      const worktree = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.workspace !== null)
      return worktree === undefined ? null : worktree
    },
    { timeoutMs: 15000, what: '이 worktree 에 열린 workspace' },
  )
  if (!found.ok) {
    throw new Error(`이 worktree 에 열린 workspace 가 없다 — herdr --session ${SESSION} workspace create --cwd ${REPO_DIR} 로 하나 열어라`)
  }
  const tabId = found.value.workspace.tabs[0]?.tabId ?? null
  if (tabId === null) throw new Error('workspace 에 탭이 없다')
  await until(async () => (await app.query(`[data-main-tab="${tabId}"]`)).found.length > 0, { what: '탭바에 탭' })
  await app.click(`[data-main-tab="${tabId}"]`)
  const streaming = await until(async () => (await app.state()).terminalGroups.some((g) => g.phase === 'streaming'), {
    timeoutMs: 15000,
    what: 'streaming',
  })
  if (!streaming.ok) throw new Error('streaming 이 안 왔다')
}
