// F2-7 · F2-8 — **선택이 따라오나** (기준 §R33, 게이트 ① 사용자 지적).
//
// 이 두 통과선은 판정이 끝난 뒤에 생겼다. F2-1~F2-6 은 분할·리사이즈·줌·이웃이동·닫기·정합을
// 재면서 **그 다음 선택이 어디 있는지**를 한 번도 안 봤고, 클릭 선택은 F1-3(영역 전환) 안에만
// 있어서 **영역이 둘일 때만** 쟀다. 한 영역 안에서 형제 pane 을 클릭하는 경로는 0회였다.
// 사용자가 앱을 켜고 몇 분 만에 둘 다 잡았다.
//
//   F2-7  분할 직후 새 pane 이 선택된다 — `⌘D`·`⌘⇧D`·헤더 `▥ ▤`·탭 메뉴 **네 경로 전부**
//   F2-8  형제 pane 을 클릭하면 그 pane 이 선택된다 — **xterm 위 좌표와 xterm 밖(패딩) 좌표 둘 다**
//
// `onMouseDown` 이 붙어 있나·이벤트가 도달하나는 **안 친다**(부류 ①: 있는 것 ≠ 보이는 것).
// 결함이 정확히 그 틈에 있었다 — 핸들러도 붙어 있었고 이벤트도 왔는데 부모의 두 번째
// `activateGroup` 이 선택을 되돌렸다.
//
// **F2-8 의 판별자는 배지가 아니라 키다** (§R33-2 — 코디네이터가 통과선을 고쳤다). 첫 회차에서
// 배지는 네 줄 다 옮겨갔는데 패딩 띠 두 줄은 `activeElement` 가 `body` 였다 — 사용자가 겪는 것은
// 여전히 "못 고른다"다. 그래서 여기서 보는 것은 ⓐ `[data-pane-selected]` 이동 **AND** ⓑ **글자를
// 쳐서 그 pane 에 도착하는 것**이다. `document.activeElement` 는 기록으로 남기지만 판별자가
// 아니다 — 그 둘이 참인데 키가 안 간 회차가 실제로 있었다.
//
// 클릭은 **진짜 마우스 이벤트**다 — `click`(선택자 → 좌표, 가림 판정은 크로미움) 과
// `raw-mouse`(좌표 직접). 합성 `MouseEvent` 는 안 쓴다.
//
// 격리: `life373-` 세션 전용. M0: 유령 앱 0 에서만 유효하다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, quiesce, pressNative, snapshot } from './app-steps.mjs'
import { ensureWorkspace, m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-f2sel-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')

/**
 * 화면이 말하는 선택 — **그린 것만 읽는다.**
 *
 * `선택`: `[data-pane-selected="true"]` 인 상자. 둘 이상이면 그대로 배열로 남긴다(영역이 둘이면
 * 영역마다 하나씩 참일 수 있다 — 이 회차는 영역 하나라 하나여야 한다).
 * `포커스`: `document.activeElement` 가 어느 pane 상자 안에 있나. 선택과 갈리면 "골랐는데 타건은
 * 딴 데로 간다"가 되므로 둘을 같이 적는다.
 */
async function 화면(app) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const boxes = [...document.querySelectorAll('[data-term-pane-box]')]
        const active = document.activeElement
        const host = active === null ? null : active.closest('[data-term-pane-box]')
        return {
          pane: boxes.map((el) => ({ paneId: el.dataset.termPaneBox, 선택: el.dataset.paneSelected === 'true', 숨김: el.hidden })),
          선택: boxes.filter((el) => el.dataset.paneSelected === 'true').map((el) => el.dataset.termPaneBox),
          포커스: host === null ? null : host.dataset.termPaneBox,
        }
      })()`,
    })
  ).result
}

/**
 * 누를 좌표 둘 — xterm **위**(터미널 호스트 한가운데)와 xterm **밖**(장식 띠).
 *
 * xterm 밖 점을 상자 왼쪽 위 모서리로 잡으면 안 된다: **오른쪽·아래 pane 에서는 그 모서리가
 * 경계선 히트영역(`.pane-divider`, 12px)에 깔린다.** 거기를 누르면 크로미움이 경계선에
 * 히트테스트하고 드래그가 시작된다 — pane 이 안 골라지는 게 **맞는** 동작이라 그 점으로 재면
 * 통과선이 거짓으로 미달난다(첫 회차에서 실제로 그랬다).
 *
 * 그래서 상자 안에서 ⓐ xterm 밖이고 ⓑ 경계선 히트영역 밖인 점을 **훑어서 찾고**, 찾은 점에
 * `elementFromPoint` 를 쳐서 **그 점의 맨 위 요소가 정말 이 pane 상자 안인지** 확인해 같이
 * 적는다. 못 찾으면 `null` 을 그대로 돌려준다 — 없는 점을 지어내지 않는다.
 */
async function 좌표(app, paneId) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const box = document.querySelector('[data-term-pane-box="${paneId}"]')
        if (box === null) return null
        const term = box.querySelector('[data-term-pane="${paneId}"]')
        const b = box.getBoundingClientRect()
        const t = term === null ? null : term.getBoundingClientRect()
        const round = (v) => Math.round(v)
        const dividers = [...document.querySelectorAll('[data-pane-divider]')].map((el) => el.getBoundingClientRect())
        // **기하로 고르지 않고 히트테스트로 고른다.** 상자 rect 는 잘려 나간 장식 칸까지 포함해서
        // (term-pane-stack 의 overflow) 상자 위쪽 15px 은 실제로는 탭바 밑이다 — 거기를 누르면
        // 탭바가 먹는다 (첫 회차에서 elementFromPoint 가 main-tabbar 를 돌려줬다).
        // 그래서 "그 점을 실제로 누르면 이 pane 이 맞고 xterm 은 아닌" 점을 찾는다.
        // (이 안은 템플릿 리터럴이다 - 역따옴표를 쓰면 문자열이 거기서 끊긴다)
        let 밖 = null
        let 후보수 = 0
        for (let dy = 1; dy < b.height - 1 && 밖 === null; dy += 2) {
          for (let dx = 1; dx < b.width - 1; dx += 2) {
            const x = round(b.left + dx)
            const y = round(b.top + dy)
            const hit = document.elementFromPoint(x, y)
            if (hit === null) continue
            후보수 += 1
            if (hit.closest('[data-term-pane-box]') !== box) continue
            if (hit.closest('[data-term-pane]') !== null) continue
            밖 = { x, y }
            break
          }
        }
        const top = 밖 === null ? null : document.elementFromPoint(밖.x, 밖.y)
        return {
          상자: { left: round(b.left), top: round(b.top), width: round(b.width), height: round(b.height) },
          xterm상자: t === null ? null : { left: round(t.left), top: round(t.top), width: round(t.width), height: round(t.height) },
          xterm위: t === null ? null : { x: round(t.left + t.width / 2), y: round(t.top + t.height / 2) },
          xterm밖: 밖,
          경계선수: dividers.length,
          훑은점수: 후보수,
          // 그 점이 정말 이 pane 의 것인가 — 맨 위 요소가 이 상자 안이어야 한다.
          밖점주인: top === null ? null : (top.closest('[data-term-pane-box]')?.dataset.termPaneBox ?? null),
          밖점태그: top === null ? null : top.className,
        }
      })()`,
    })
  ).result
}

/**
 * **판별자 ⓑ — 글자가 그 pane 에 도착하나** (기준 §R33-2).
 *
 * 배지(`[data-pane-selected]`)도 `document.activeElement` 도 판별자가 아니다. **그 둘이 참인데
 * 키가 안 가는 것을 이 회차에서 관측했다** — 패딩 띠를 누르면 `mousedown` 기본 동작이 포커스를
 * `body` 로 끌어가, 배지는 옮겨가고 타건은 아무 데도 안 갔다(`probe-focus-mech.json`).
 *
 * pane 마다 `lastSeq` 를 보고, 글자를 받은 pane 의 셸이 **되울린다**는 것으로 도착을 읽는다.
 * 저절로 오는 프레임과 가르려고 **타건 없이 같은 시간을 기다린 유휴 대조**를 먼저 잡는다 —
 * 대조보다 더 오른 pane 만 "받았다"로 센다. 엔터는 안 친다(명령을 돌리지 않는다).
 */
async function 프레임(app) {
  const rows =
    (await app.send({ cmd: 'eval', code: '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()' })).result ??
    []
  const out = {}
  for (const row of rows) out[row.paneId] = row.lastSeq
  return out
}

async function 유휴대조(app, ms = 1100) {
  const 전 = await 프레임(app)
  await sleep(ms)
  const 후 = await 프레임(app)
  const out = {}
  for (const id of new Set([...Object.keys(전), ...Object.keys(후)])) out[id] = (후[id] ?? 0) - (전[id] ?? 0)
  return out
}

async function 타건도착(app, { 마커, 유휴 }) {
  const 전 = await 프레임(app)
  await app.send({ cmd: 'type', text: 마커 })
  await sleep(1100)
  const 후 = await 프레임(app)
  const 증가 = {}
  for (const id of new Set([...Object.keys(전), ...Object.keys(후)])) 증가[id] = (후[id] ?? 0) - (전[id] ?? 0)
  const 받은 = Object.entries(증가)
    .filter(([id, d]) => d > (유휴[id] ?? 0))
    .map(([id]) => id)
  return { 마커, 유휴, 증가, 받은 }
}

/** 진짜 마우스 누름·뗌 한 번 — 좌표로 보낸다 (합성 이벤트 아님). */
async function 클릭좌표(app, { x, y }) {
  await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x, y })
  await app.send({ cmd: 'raw-mouse', type: 'mouseDown', x, y, button: 'left' })
  await app.send({ cmd: 'raw-mouse', type: 'mouseUp', x, y, button: 'left' })
  await sleep(900)
}

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, F2_7: [], F2_8: [] }

// 회차마다 **다른 글자**를 친다 — 같은 글자면 앞 회차의 되울림과 구분이 안 된다.
let 마커수 = 0
const 마커뽑기 = () => {
  마커수 += 1
  return 'zq' + String(마커수)
}

ensureWorkspace()
결과.초기화 = await resetPanes()

const app = await startApp({ name: 'f2-select', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(800)
await quiesce(app)

const groupId = async () => (await app.state()).terminalGroups[0]?.groupId ?? null
const tabId = async () => {
  const state = await app.state()
  const group = state.terminalGroups[0] ?? null
  return group === null ? null : group.tabId
}

// ── F2-7 · 분할 직후 새 pane 이 선택되나 — 네 경로 ────────────────────────────────
//
// 경로마다 **pane 하나에서 시작한다**(앞 경로가 남긴 분할 위에서 재면 "새 pane" 이 누군지
// 흐려진다). 되돌리는 것은 herdr `pane close` 다 — 앱 UI 로 닫으면 그 닫기의 선택 이동이
// 다음 경로의 출발점을 정해 버린다.
async function 분할경로({ 이름, 실행 }) {
  await resetPanes()
  await sleep(900)
  await quiesce(app)
  const 전 = await 화면(app)
  const 전집합 = new Set(전.pane.map((p) => p.paneId))
  const 유휴 = await 유휴대조(app)
  await 실행()
  await sleep(1400)
  const 후 = await 화면(app)
  const 새pane = 후.pane.map((p) => p.paneId).filter((id) => !전집합.has(id))
  const 도착 = await 타건도착(app, { 마커: 마커뽑기(), 유휴 })
  const row = {
    경로: 이름,
    전: { pane: 전.pane.map((p) => p.paneId), 선택: 전.선택, 포커스: 전.포커스 },
    후: { pane: 후.pane.map((p) => p.paneId), 선택: 후.선택, 포커스: 후.포커스 },
    새pane,
    도착,
    // 판별: **새 pane 이 정확히 하나 생겼고, 그것이 선택이다.**
    통과: 새pane.length === 1 && 후.선택.length === 1 && 후.선택[0] === 새pane[0],
    // F2-7 의 통과선은 배지까지다(§R33). ⓑ 는 **기록으로** 같이 잰다 — 사용자 지적 1 의 원문이
    // "분할할 때 포커스가 안 옮겨가는데"였으니, 배지만 보고 닫을 자리가 아니다.
    키가갔나: 새pane.length === 1 && 도착.받은.length === 1 && 도착.받은[0] === 새pane[0],
    포커스도갔나: 새pane.length === 1 && 후.포커스 === 새pane[0],
  }
  결과.F2_7.push(row)
  console.log(
    'F2-7',
    이름,
    '| 새',
    새pane.join(','),
    '| 선택',
    후.선택.join(','),
    '| 포커스',
    후.포커스,
    '| 키',
    도착.받은.join(',') || '없음',
    '|',
    row.통과 ? '통과' : '미달',
  )
  await app.shot(`f2sel-7-${이름}`)
  return row
}

await 분할경로({
  이름: 'cmd-d',
  실행: async () => {
    await pressNative(app, { keyCode: 'D', modifiers: ['meta'] })
  },
})
await 분할경로({
  이름: 'cmd-shift-d',
  실행: async () => {
    await pressNative(app, { keyCode: 'D', modifiers: ['meta', 'shift'] })
  },
})
await 분할경로({
  이름: 'header-right',
  실행: async () => {
    const id = await groupId()
    if (id === null) throw new Error('영역이 없다')
    await app.click(`[data-group-split-right="${id}"]`)
  },
})
await 분할경로({
  이름: 'header-down',
  실행: async () => {
    const id = await groupId()
    if (id === null) throw new Error('영역이 없다')
    await app.click(`[data-group-split-down="${id}"]`)
  },
})
await 분할경로({
  이름: 'tab-menu-right',
  실행: async () => {
    const tab = await tabId()
    if (tab === null) throw new Error('탭이 없다')
    // 메뉴를 여는 것은 우클릭이다 — 여는 행위 자체는 판정 대상이 아니라 `contextmenu` 로 연다.
    // **누르는 것은 진짜 클릭**(`app.click` → 좌표 + 가림 판정)이고 그게 판정 경로다.
    await app.send({
      cmd: 'eval',
      code: `document.querySelector('[data-main-tab="${tab}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 40 })), 1`,
    })
    await sleep(500)
    await app.click(`[data-tab-menu-split-right="${tab}"]`)
  },
})

// ── F2-8 · 형제 pane 클릭 ────────────────────────────────────────────────────────
//
// 한 영역 안 두 pane. **xterm 위 좌표**와 **xterm 밖(패딩) 좌표** 둘 다로 누른다. 누를 때마다
// 방향을 바꿔서(A→B, B→A) "한쪽으로만 가는" 것도 걸리게 한다.
await resetPanes()
await sleep(900)
await quiesce(app)
{
  const id = await groupId()
  if (id === null) throw new Error('영역이 없다')
  await app.click(`[data-group-split-right="${id}"]`)
  await sleep(1600)
}
await quiesce(app)

const 두pane = await 화면(app)
결과.F2_8_출발 = 두pane
if (두pane.pane.length !== 2) throw new Error(`F2-8 은 pane 둘에서 잰다 (지금 ${두pane.pane.length})`)
const [p1, p2] = 두pane.pane.map((p) => p.paneId)

/**
 * 클릭 한 번 — **선택이 실제로 옮겨가는 회차만 판정으로 친다.**
 *
 * 누르기 전에 이미 그 pane 이 선택이면 "안 움직여도 통과" 가 되어 버린다(첫 회차에서 두 줄이
 * 그렇게 통과했다 — 판정이 아니라 우연이다). 그래서 `옮겨갔나` 를 따로 적고, 출발 선택이 대상과
 * 같으면 그 줄은 **성립안함**으로 남긴다.
 */
async function 클릭선택({ 이름, 대상, 지점 }) {
  const 전 = await 화면(app)
  const coords = await 좌표(app, 대상)
  const at = 지점 === 'xterm위' ? coords?.xterm위 : coords?.xterm밖
  if (at === undefined || at === null) throw new Error(`${대상} 의 ${지점} 좌표를 못 구했다`)
  const 출발이대상 = 전.선택.length === 1 && 전.선택[0] === 대상
  const 유휴 = await 유휴대조(app)
  await 클릭좌표(app, at)
  const 후 = await 화면(app)
  const 도착 = await 타건도착(app, { 마커: 마커뽑기(), 유휴 })
  const row = {
    이름,
    대상,
    지점,
    좌표: at,
    상자: coords.상자,
    xterm상자: coords.xterm상자,
    밖점주인: coords.밖점주인,
    밖점태그: coords.밖점태그,
    경계선수: coords.경계선수,
    전: { 선택: 전.선택, 포커스: 전.포커스 },
    후: { 선택: 후.선택, 포커스: 후.포커스 },
    도착,
    // 판별은 **둘 다**다 (§R33-2): ⓐ 배지가 옮겨가고 ⓑ 글자가 그 pane 에 도착한다.
    통과: 후.선택.length === 1 && 후.선택[0] === 대상 && 도착.받은.length === 1 && 도착.받은[0] === 대상,
    옮겨갔나: !출발이대상 && 후.선택.length === 1 && 후.선택[0] === 대상,
    키가갔나: 도착.받은.length === 1 && 도착.받은[0] === 대상,
    성립: !출발이대상,
    // 보조 근거다 — 판별자가 아니다(§R33-2). 참인데 키가 안 간 회차가 있었다.
    포커스도갔나: 후.포커스 === 대상,
  }
  결과.F2_8.push(row)
  console.log(
    'F2-8',
    이름,
    `${전.선택.join(',')} → ${후.선택.join(',')}`,
    '| 좌표',
    `${at.x},${at.y}`,
    '| 그 점의 주인',
    coords.밖점주인 ?? '-',
    '| 포커스',
    후.포커스,
    '| 키',
    도착.받은.join(',') || '없음',
    '|',
    row.성립 ? (row.통과 ? '통과' : '미달') : '성립안함(출발이 이미 대상)',
  )
  await app.shot(`f2sel-8-${이름}`)
  return row
}

// 분할 직후에는 **새 pane 이 이미 선택**이다(F2-7). 그래서 첫 클릭은 반대쪽부터 — 네 줄 전부
// "출발 ≠ 대상" 이 되게 짠다.
await 클릭선택({ 이름: 'xterm위-B→A', 대상: p1, 지점: 'xterm위' })
await 클릭선택({ 이름: 'xterm위-A→B', 대상: p2, 지점: 'xterm위' })
await 클릭선택({ 이름: 'xterm밖-B→A', 대상: p1, 지점: 'xterm밖' })
await 클릭선택({ 이름: 'xterm밖-A→B', 대상: p2, 지점: 'xterm밖' })

결과.화면 = await snapshot(app, 'f2-select 끝')
결과.판정 = {
  'F2-7 분할 직후 새 pane 선택': {
    경로수: 결과.F2_7.length,
    통과수: 결과.F2_7.filter((r) => r.통과).length,
    포커스까지: 결과.F2_7.filter((r) => r.포커스도갔나).length,
    // 기준(§R33)은 배지까지다. 키는 **기록** — 미달이면 판정에 안 들어가도 결과 문서에 적는다.
    키까지: 결과.F2_7.filter((r) => r.키가갔나).length,
    통과: 결과.F2_7.length > 0 && 결과.F2_7.every((r) => r.통과),
  },
  'F2-8 형제 pane 클릭 선택': {
    클릭수: 결과.F2_8.length,
    성립수: 결과.F2_8.filter((r) => r.성립).length,
    옮겨간수: 결과.F2_8.filter((r) => r.옮겨갔나).length,
    // ⓑ — **판별자**다 (§R33-2).
    키까지: 결과.F2_8.filter((r) => r.키가갔나).length,
    포커스까지: 결과.F2_8.filter((r) => r.포커스도갔나).length,
    // 밖 좌표가 정말 그 pane 의 것이었나 — 경계선에 깔린 점을 눌러 놓고 "안 된다" 하지 않기 위해.
    밖좌표주인이대상: 결과.F2_8.filter((r) => r.지점 === 'xterm밖').every((r) => r.밖점주인 === r.대상),
    // **성립한 줄이 전부 옮겨갔을 때만** 통과다. 성립 줄이 없으면 통과가 아니다(잰 게 없다).
    // **성립한 줄이 전부 ⓐ 옮겨가고 ⓑ 키까지 갔을 때만** 통과다 (§R33-2 — 배지 하나로는 안 닫힌다).
    통과:
      결과.F2_8.filter((r) => r.성립).length === 결과.F2_8.length &&
      결과.F2_8.every((r) => r.옮겨갔나) &&
      결과.F2_8.every((r) => r.키가갔나),
  },
}

await app.stop()
결과.M0b = m0End()
// **결과 파일 이름을 밖에서 준다** (`L373_OUT`). 고정 이름이면 같은 하네스를 조건을 바꿔 두 번
// 돌릴 때 뒤 회차가 앞 회차를 말없이 덮는다 — 라운드 2 에서 S9 요약 JSON 을 그렇게 잃었고
// (§5 사고 3), 이 회차의 수정 전/후 대조에서 **또 한 번 덮었다.** 두 번째는 고친다.
writeRaw(process.env.L373_OUT ?? 'f2-select.json', 결과)
console.log(JSON.stringify(결과.판정, null, 2))
