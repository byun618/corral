// **G-2 / G3′** 무음 실패 금지 · **G-3 / G4′-a·b·c** 영역 탭바 빈 배경 (기준 §10-R35-2·R35-3).
//
// G3′ — 탭 1개짜리 영역에서 `⌘⌥D` 를 누르면 **메뉴와 같은 문구의 알림**이 뜬다.
//   판별자는 "알림이 떴다"가 아니라 **문구가 메뉴의 `title` 과 같다**이다. 두 문구를 각각
//   **살아 있는 DOM 에서** 읽어 견준다 — 소스에 적힌 상수를 믿지 않는다(부류 ①: 있는 것 ≠ 보이는 것).
//
// G4′-a — 헤더 빈 자리를 누른 뒤 타건하면 **그 영역의 활성 pane 에 글자가 들어간다.**
//   판별은 F2-8 과 같은 **셸 되울림**이다: 마커를 치고 pane 별 `lastSeq` 증가를 보되, 타건 없는
//   **유휴 대조**를 같은 길이로 먼저 떠서 뺀다. `activeElement` 는 기록만 한다.
//
// G4′-b·c — **되돌릴 조건**이다. 이름 바꾸기 캐럿과 헤더 버튼이 그대로 살아야 한다.
//   §R33-3 이 "안 고친다"로 박혀 있던 이유가 그 둘이고, 하나라도 깨지면 G-3 은 되돌리는 게 정답이다.
//
// 격리: `life373-` 세션 전용 · `CORRAL_UI_PREFS` · M0.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, quiesce, press, snapshot } from './app-steps.mjs'
import { ctl, ensureWorkspace, m0End, m0Start, resetPanes, tabList, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-g23-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const OUT_NAME = process.env.L373_OUT ?? 'g23-notice-header.json'

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, 항목: [] }

const evalIn = async (app, code) => (await app.send({ cmd: 'eval', code })).result

async function 프레임(app) {
  const rows = (await evalIn(app, '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()')) ?? []
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
  return { 마커, 유휴, 증가, 받은: Object.entries(증가).filter(([id, d]) => d > (유휴[id] ?? 0)).map(([id]) => id) }
}
let 마커수 = 0
const 마커뽑기 = () => {
  마커수 += 1
  return 'zh' + String(마커수)
}

/** 헤더의 **빈 자리** 좌표 — 탭·버튼·입력칸이 아닌 픽셀을 헤더 안에서 직접 찾는다. */
const 헤더빈자리 = async (app, groupId) =>
  evalIn(
    app,
    `(() => {
      const header = document.querySelector('[data-group-header="${groupId}"]')
      if (header === null) return null
      const r = header.getBoundingClientRect()
      const y = Math.round(r.top + r.height / 2)
      for (let x = Math.round(r.left + 8); x < r.right - 8; x += 6) {
        const el = document.elementFromPoint(x, y)
        if (el === null) continue
        if (el.closest('[data-main-tab]') !== null) continue
        if (el.closest('button, input, textarea, select, a[href], [tabindex]') !== null) continue
        if (el.closest('[data-group-header="${groupId}"]') === null) continue
        return { x, y, 무엇: el.className, 태그: el.tagName }
      }
      return null
    })()`,
  )

// --- 준비 -----------------------------------------------------------------------------
ensureWorkspace()
결과.초기화 = await resetPanes()
const app = await startApp({ name: 'g23', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(1200)
await quiesce(app)
const groupId = (await evalIn(app, `(() => document.querySelector('[data-group-header]')?.dataset.groupHeader ?? null)()`))
결과.groupId = groupId

// --- G3′ — `⌘⌥D` 가 이유를 말하나 ------------------------------------------------------
//
// **탭을 하나로 먼저 만든다.** 앞 회차들이 같은 세션에 탭을 쌓아 두는데, 그 상태로 재면 `⌘⌥D` 가
// **실제로 되는** 자리라 통과선이 겨누는 조건이 아니다 (첫 회차가 탭 7개에서 돌아 거짓 미달을 냈다).
{
  // 화면이 보는 workspace 의 탭만 건드린다. herdr 세션에는 다른 cwd 의 workspace 도 살아 있고
  // 그 마지막 탭을 닫으려 하면 `confirmation_required` 로 거절한다 — 우리가 볼 자리가 아니다.
  const 보이는탭 = (await app.state()).repos
    .flatMap((repo) => repo.worktrees)
    .flatMap((worktree) => worktree.workspace?.tabs ?? [])
    .map((tab) => tab.tabId)
  const 남길 = 보이는탭[0] ?? null
  const 못닫은 = []
  for (const tabId of 보이는탭) {
    if (tabId === 남길) continue
    try {
      ctl('tab', 'close', tabId)
    } catch (error) {
      못닫은.push({ tabId, 이유: String(error).slice(0, 120) })
    }
  }
  await sleep(1800)
  await quiesce(app)
  결과.탭정리 = { 남긴탭: 남길, 못닫은, 남은탭수: tabList().length }
  console.log('# 탭 정리', JSON.stringify(결과.탭정리))
}
{
  const 탭수 = await evalIn(app, `(() => document.querySelectorAll('[data-group-header="${groupId}"] [data-main-tab]').length)()`)
  await press(app, { key: 'd', alt: true })
  await sleep(900)
  const 알림 = await evalIn(
    app,
    `(() => {
      const el = document.querySelector('[data-lifecycle-notice]')
      if (el === null) return null
      return { 문구: el.querySelector('.inline-notice-text')?.textContent ?? null, 종류: el.dataset.noticeKind }
    })()`,
  )
  // 메뉴 문구는 **메뉴를 열어서** 읽는다 — 소스 상수를 믿지 않는다.
  const tabId = await evalIn(app, `(() => document.querySelector('[data-group-header="${groupId}"] [data-main-tab]')?.dataset.mainTab ?? null)()`)
  // 메뉴는 **진짜 우클릭**으로 연다 — 합성 이벤트를 안 쓴다(F2-8 과 같은 규율).
  const 탭자리 = await evalIn(
    app,
    `(() => { const r = document.querySelector('[data-main-tab="${tabId}"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`,
  )
  if (탭자리 !== null) {
    await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x: 탭자리.x, y: 탭자리.y })
    await app.send({ cmd: 'raw-mouse', type: 'mouseDown', x: 탭자리.x, y: 탭자리.y, button: 'right' })
    await app.send({ cmd: 'raw-mouse', type: 'mouseUp', x: 탭자리.x, y: 탭자리.y, button: 'right' })
  }
  await sleep(800)
  const 메뉴문구 = await evalIn(
    app,
    `(() => document.querySelector('[data-tab-menu-move-right]')?.getAttribute('title') ?? null)()`,
  )
  await app.send({ cmd: 'key', keyCode: 'Escape' }).catch(() => null)
  await sleep(400)
  const row = {
    항목: 'G3′ ⌘⌥D 무음 실패',
    탭수,
    알림,
    메뉴문구,
    같은문구인가: 알림?.문구 != null && 메뉴문구 != null && 알림.문구 === 메뉴문구,
    통과: 탭수 === 1 && 알림?.문구 != null && 메뉴문구 != null && 알림.문구 === 메뉴문구,
    화면: await snapshot(app, 'g23-notice'),
  }
  console.log(`G3′ 탭수 ${탭수} · 알림 ${JSON.stringify(알림)} · 메뉴 ${JSON.stringify(메뉴문구)} → 통과 ${row.통과}`)
  결과.항목.push(row)
  // 알림을 지우고 다음 항목으로 (다음 판별을 오염시키지 않는다)
  await app.send({ cmd: 'click', selector: '[data-notice-dismiss]' }).catch(() => null)
  await sleep(500)
}

// --- G4′-a — 헤더 빈 배경 클릭 후 타건 --------------------------------------------------
{
  const 자리 = await 헤더빈자리(app, groupId)
  const 활성pane전 = await evalIn(app, `(() => document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null)()`)
  if (자리 !== null) {
    await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x: 자리.x, y: 자리.y })
    await app.send({ cmd: 'raw-mouse', type: 'mouseDown', x: 자리.x, y: 자리.y, button: 'left' })
    await app.send({ cmd: 'raw-mouse', type: 'mouseUp', x: 자리.x, y: 자리.y, button: 'left' })
    await sleep(900)
  }
  const 활성요소 = await evalIn(app, `(() => document.activeElement?.className ?? null)()`)
  const 활성pane후 = await evalIn(app, `(() => document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null)()`)
  const 유휴 = await 유휴대조(app)
  const 도착 = await 타건도착(app, { 마커: 마커뽑기(), 유휴 })
  const row = {
    항목: 'G4′-a 헤더 빈 배경 → 타건',
    자리,
    활성pane: { 전: 활성pane전, 후: 활성pane후 },
    '활성요소(기록만)': 활성요소,
    도착,
    통과: 자리 !== null && 활성pane후 !== null && 도착.받은.length === 1 && 도착.받은[0] === 활성pane후,
    화면: await snapshot(app, 'g23-header-click'),
  }
  console.log(`G4′-a 자리 ${JSON.stringify(자리?.무엇)} · 받은 ${JSON.stringify(도착.받은)} · 활성pane ${활성pane후} → 통과 ${row.통과}`)
  결과.항목.push(row)
}

// --- G4′-b — 이름 바꾸기 캐럿이 여전히 뜨나 (되돌릴 조건) -------------------------------
{
  const tabId = await evalIn(app, `(() => document.querySelector('[data-group-header="${groupId}"] [data-main-tab]')?.dataset.mainTab ?? null)()`)
  await app.send({ cmd: 'dblclick', selector: `[data-main-tab="${tabId}"]` })
  await sleep(900)
  const 편집중 = await evalIn(
    app,
    `(() => {
      const tab = document.querySelector('[data-main-tab="${tabId}"]')
      const input = tab?.querySelector('.main-tab-rename') ?? null
      return {
        편집속성: tab?.dataset.tabEditing ?? null,
        입력칸있나: input !== null,
        포커스인가: input !== null && document.activeElement === input,
        값: input?.value ?? null,
      }
    })()`,
  )
  // 캐럿이 섰으면 **글자가 들어가는지**까지 본다 — "떴다"와 "쓸 수 있다"는 다르다.
  let 타건후 = null
  if (편집중.포커스인가) {
    await app.send({ cmd: 'type', text: 'Q' })
    await sleep(500)
    타건후 = await evalIn(app, `(() => document.querySelector('[data-main-tab="${tabId}"] .main-tab-rename')?.value ?? null)()`)
    await app.send({ cmd: 'key', keyCode: 'Escape' }).catch(() => null)
    await sleep(400)
  }
  const row = {
    항목: 'G4′-b 이름 바꾸기 캐럿',
    tabId,
    편집중,
    타건후,
    통과: 편집중.편집속성 === 'true' && 편집중.포커스인가 && 타건후 !== null && 타건후 !== 편집중.값,
    화면: await snapshot(app, 'g23-rename'),
  }
  console.log(`G4′-b 편집 ${편집중.편집속성} · 포커스 ${편집중.포커스인가} · 값 ${JSON.stringify(편집중.값)} → ${JSON.stringify(타건후)} → 통과 ${row.통과}`)
  결과.항목.push(row)
}

// --- G4′-c — 헤더 버튼이 여전히 눌리나 (되돌릴 조건) ------------------------------------
{
  const 전 = await evalIn(app, `(() => document.querySelectorAll('[data-term-pane-box]').length)()`)
  await app.send({ cmd: 'click', selector: `[data-group-split-right="${groupId}"]` })
  await sleep(2400)
  await quiesce(app)
  const 후 = await evalIn(app, `(() => document.querySelectorAll('[data-term-pane-box]').length)()`)
  const row = {
    항목: 'G4′-c 헤더 버튼(분할 ▥)',
    pane수: { 전, 후 },
    통과: 후 === 전 + 1,
    화면: await snapshot(app, 'g23-header-button'),
  }
  console.log(`G4′-c pane ${전} → ${후} → 통과 ${row.통과}`)
  결과.항목.push(row)
}

결과.요약 = Object.fromEntries(결과.항목.map((r) => [r.항목, r.통과]))
결과.되돌릴까 = 결과.항목.some((r) => (r.항목.startsWith('G4′-b') || r.항목.startsWith('G4′-c')) && !r.통과)
console.log('\n요약', JSON.stringify(결과.요약), '· 되돌릴까', 결과.되돌릴까)

await app.stop()
await sleep(1200)
결과.M0_끝 = m0End()
writeRaw(OUT_NAME, 결과)
