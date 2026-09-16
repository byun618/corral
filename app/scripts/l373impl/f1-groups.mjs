// F1 통과선 — 영역이 실제로 서나 (LIFE-373 ①). 화면에서 본 것만 적는다.
//
// LIFE-353 하네스의 앱 구동·control 채널을 그대로 쓴다(재는 도구는 같은 것이 낫다).
// 판정 원자료는 **LIFE-373 쪽**에 쓴다 — 앱 로그·스크린샷만 l353 의 `_runs/` 에 남는다.
//
//   ⓐ F1-1 기본 1영역 → 탭 메뉴 「오른쪽 영역」 → 2영역(탭이 빠져나가고 연결이 하나 는다)
//   ⓑ F1-3 다른 영역 헤더를 누르면 포커스가 그리로 간다 (활성 표시·attach 순서)
//   ⓒ F1-7 창을 좁히면 비활성 탭이 아이콘만으로 접힌다 (폭 3점 — **드래그보다 먼저**, 아래 주석)
//   ⓓ F1-2 경계 드래그 — **끄는 동안 sync·resize 0**, mouseup 에 각각 1회. 셀 스냅·배지.
//   ⓔ F1-6 재기동 복원 — 같은 ui-prefs·registry 로 다시 띄워 배치가 돌아오나
//   ⓕ F1-4 영역의 마지막 탭을 닫으면 빈 카드가 서고 연결이 하나 준다
//   ⓖ F1-5 영역 닫기 — 형제가 자리를 먹고 탭을 물려받는다
//   ⓗ F1-2(세로) 아래 영역으로 나눈 뒤 경계 드래그 — overhead ≠ 0 · 배지 rows · 셀 바닥 1칸
//   ⓘ F1-2 클램프 양 끝(.15/.85) — 반 칸이 끝을 넘는지는 거기서만 드러난다
//
// 격리(관문 ⑤): `life373-` 세션에서만 돈다. l353 lib 는 `LIFE353_SESSION` 을 보므로 거기에
// 박아 넣고, 여기서 한 번 더 막는다 — 사용자 default 세션에 붙는 순간 끝이다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, until, sleep, herdrRequest, SESSION, REPO_DIR } from '../l353/lib.mjs'
import { m0End, m0Start, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION}) — LIFE353_SESSION=life373-… 로 띄워라`)

/** M0 — 이 런이 유효한가. 시작 전 잔여가 0 이 아니면 CPU·rAF 계열은 무효다. */
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-f1-'))
const PREFS = path.join(RUN_DIR, 'ui-prefs.json')
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const APP_ENV = { CORRAL_UI_PREFS: PREFS }

const tabsOf = (state) => state.repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? [])
const resizeEvents = (app, since) =>
  app.entries().filter((e) => e.tag === 'vendor.debug' && e.message === 'resize request' && e.at >= since)
const syncEvents = (app, since) => app.entries().filter((e) => e.tag === 'stream.sync' && e.at >= since)

async function snapshot(app, label) {
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
async function ensureTabs(app, want) {
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
async function moveTabToNewGroup(app, { tabId, direction = 'right' }) {
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
async function quiesce(app, { quietMs = 900, timeoutMs = 8000 } = {}) {
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
async function dragDivider(app, { selector, direction, shot, step = 9, steps = 12 }) {
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

const 결과 = { at: new Date().toISOString(), 세션: SESSION, prefs: PREFS, M0 }

/**
 * 저장소를 등록하고 **이 worktree 에 열린** workspace 의 탭을 눌러 스트리밍까지 데려간다.
 *
 * l353 의 `attachPane` 을 안 쓴다. 그건 `firstPaneId()`(목록의 첫 pane)를 전제로 하는데 격리
 * 세션에는 다른 cwd 의 workspace 도 산다 — 실측: `life373-impl` 의 w1 은 `/private/tmp` 다.
 * corral 은 worktree 경로로 workspace 를 묶으므로 그런 pane 은 4단 목록에 아예 안 뜨고
 * `attachPane` 이 "pane 행이 목록에 안 떴다"로 죽는다. 여기서는 **앱이 보는 것**을 따라간다.
 */
async function attachThisWorktree(app) {
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

// ── 1회차: ⓐ ⓑ ⓒ ⓓ, 그리고 2영역인 채로 종료해서 ⓔ 의 씨앗을 남긴다 ──────────────
const app = await startApp({ name: 'f1-groups', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(600)
await ensureTabs(app, 4)

결과.기본 = await snapshot(app, '기본 1영역')
await app.shot('f1-a-single')

// ⓐ F1-1
const tabs = tabsOf(await app.state())
const second = tabs[1]?.tabId ?? null
if (second === null) throw new Error('두 번째 탭이 없다')
결과.분할클릭 = await moveTabToNewGroup(app, { tabId: second })
결과.분할후 = await snapshot(app, '오른쪽 영역으로 옮기기')
await app.shot('f1-b-two-groups')

// ⓑ F1-3 — 첫 영역 헤더를 눌러 포커스를 되돌린다.
{
  const groups = 결과.분할후.영역별탭.map((g) => g.groupId)
  const target = groups[0]
  const since = Date.now()
  await app.click(`[data-group-header="${target}"]`)
  await sleep(700)
  const after = await snapshot(app, `헤더 클릭 → ${target}`)
  결과.포커스전환 = {
    누른영역: target,
    이전활성: 결과.분할후.활성영역,
    이후활성: after.활성영역,
    /**
     * 화면이 **선언한** 순서 그대로다 — attach 순서가 아니다.
     * S2-b(활성이 마지막에 붙는다)는 main 이 `stream.ts` 에서 `active` 로 정렬해 지킨다
     * (`[...groups].sort((a, b) => Number(a.active) - Number(b.active))`). 그래서 여기 활성 영역이
     * 앞에 적혀 있어도 S2-b 위반이 아니다. S2-b 자체는 attach 로그로 따로 잰다.
     */
    선언순서_정렬전: syncEvents(app, since).at(-1)?.groups ?? null,
    /**
     * "활성 pane 도 같이 옮겨진다"를 **DOM 포커스로** 잰다 — 추정 금지. 헤더 div 는 포커스를
     * 받지 않으므로 이게 참이려면 `activateGroup` 의 `selectPane` → `focusToken` 경로가
     * 실제로 xterm 의 textarea 를 잡아야 한다. 잡은 쪽 영역 id 를 그대로 적는다.
     */
    포커스한영역: (await app.send({
      cmd: 'eval',
      code: `document.activeElement?.closest('[data-term-group]')?.dataset.termGroup ?? null`,
    })).result,
    포커스요소: (await app.send({
      cmd: 'eval',
      code: `document.activeElement === null ? null : (document.activeElement.tagName + '.' + (document.activeElement.className || ''))`,
    })).result,
    스냅샷: after,
  }
  await app.shot('f1-c-focus')
}

// ⓒ F1-7 — 폭 3점. 좁힐수록 비활성 탭이 접힌다.
//
// 경계 드래그보다 **먼저** 잰다. 드래그가 비율을 한쪽으로 몰아 놓으면 넓은 창에서도 이미 접힌
// 상태로 시작해서 "접힘이 켜지는 지점"이 안 보인다 (첫 회차에서 실제로 그랬다).
{
  const widths = [1400, 1000, 760]
  const 점 = []
  for (const width of widths) {
    await app.resizeWindow(width, 900)
    await sleep(1100)
    const shot = await app.shot(`f1-e-width-${width}`)
    const measured = (await app.send({
      cmd: 'eval',
      code: `[...document.querySelectorAll('[data-group-header]')].map((h) => ({
        groupId: h.dataset.groupHeader,
        헤더폭: Math.round(h.getBoundingClientRect().width),
        접힘: h.dataset.headerCompact,
        탭: [...h.querySelectorAll('[data-main-tab]')].map((t) => ({ 접힘: t.dataset.tabCompact, 폭: Math.round(t.getBoundingClientRect().width) })),
      }))`,
    })).result
    점.push({ width, 헤더: measured, shot: shot.file })
  }
  결과.탭접기 = 점
  await app.resizeWindow(1400, 900)
  await sleep(900)
}

// ⓓ F1-2 — 경계 드래그(가로). 끄는 동안 격자 요청이 **한 번도** 나가면 안 된다.
결과.경계드래그 = await dragDivider(app, { selector: '[data-group-divider]', direction: 'row', shot: 'f1-d-drag-ghost' })
await app.shot('f1-d-drag-committed')

// ⓘ F1-2 클램프 양 끝 — 반 칸(`+unit/2`)이 `.15`/`.85` 를 넘는지는 **끝에서만** 드러난다.
//    코디네이터 추가 요구(2026-09-16): 양 끝에서도 배지 == 커밋 격자임을 원자료로 보여라.
결과.클램프 = {
  최소: await dragDivider(app, { selector: '[data-group-divider]', direction: 'row', step: 240, shot: 'f1-k-clamp-min' }),
  최대: await dragDivider(app, { selector: '[data-group-divider]', direction: 'row', step: -240, shot: 'f1-k-clamp-max' }),
}

결과.종료직전 = await snapshot(app, '재기동 직전')
결과.종료직전저장 = JSON.parse(fs.readFileSync(PREFS, 'utf8')).groupLayouts ?? null
await app.stop()
await sleep(800)

// ── 2회차: ⓔ 복원 → ⓕ 빈 영역 → ⓖ 영역 닫기 ────────────────────────────────────
const app2 = await startApp({ name: 'f1-groups-restart', env: APP_ENV, registryFile: REGISTRY })
await sleep(2500)
결과.재기동후 = await snapshot(app2, '재기동 후 복원')
await app2.shot('f1-f-restored')

// ⓕ F1-4 — 두 번째 영역의 탭을 전부 닫으면 빈 카드가 선다.
{
  const groups = 결과.재기동후.영역별탭
  const victim = groups.at(-1)
  const before = 결과.재기동후.연결.length
  for (const tabId of victim?.tabs ?? []) {
    await app2.click(`[data-main-tab-close="${tabId}"]`)
    await sleep(900)
  }
  await sleep(1200)
  결과.빈영역 = {
    비운영역: victim?.groupId ?? null,
    연결_전: before,
    스냅샷: await snapshot(app2, '마지막 탭을 닫은 뒤'),
    카드: (await app2.query(`[data-empty-group-new]`)).found.length,
  }
  await app2.shot('f1-g-empty-group')
}

// ⓖ F1-5 — 영역 닫기. 형제가 자리를 먹고 남은 탭을 물려받는다.
{
  const closer = (await app2.query('[data-empty-group-close]')).found[0] ?? null
  결과.영역닫기 = { 버튼: closer }
  if (closer !== null) {
    await app2.click('[data-empty-group-close]')
    await sleep(1600)
    결과.영역닫기.스냅샷 = await snapshot(app2, '영역을 닫은 뒤')
    await app2.shot('f1-h-closed')
  }
}

결과.저장된배치 = JSON.parse(fs.readFileSync(PREFS, 'utf8')).groupLayouts ?? null

// ⓗ F1-2(세로) — 같은 경계를 세로로. 가로와 달리 각 쪽에 탭바가 얹혀 overhead ≠ 0 이고
//    배지 단위가 rows, 셀 바닥이 1칸이다. 이 경로는 여기서만 화면에서 돈다.
{
  const remaining = tabsOf(await app2.state())
  const victim = remaining[1]?.tabId ?? null
  if (victim === null) {
    결과.세로드래그 = { 건너뜀: '탭이 2개 미만이라 세로 분할을 못 만든다', 탭수: remaining.length }
  } else {
    결과.세로분할클릭 = await moveTabToNewGroup(app2, { tabId: victim, direction: 'down' })
    결과.세로분할후 = await snapshot(app2, '아래 영역으로 옮기기')
    await app2.shot('f1-i-column-split')
    결과.세로드래그 = await dragDivider(app2, { selector: '[data-group-divider]', direction: 'column', shot: 'f1-i-column-ghost' })
    await app2.shot('f1-j-column-committed')
  }
}

await app2.stop()
await sleep(800)
결과.M0b = m0End()

writeRaw('f1-groups.json', 결과)
console.log(JSON.stringify(결과, null, 2))
process.exit(0)
