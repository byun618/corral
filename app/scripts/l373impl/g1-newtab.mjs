// **G-1 / G2′** — 새 탭을 만들면 **그 탭이 화면에 보이고 키가 그리로 간다** (기준 §10-R35-1).
//
// 옛 G2 하네스는 생성 뒤 `selectedPane` 만 봤다. 이 앱은 **영역이 활성 탭을 정한다**(R3-a) —
// pane 만 골라도 그 탭은 안 열린다. 그래서 **열리지 않은 탭을 통과시켰다.** §R33-2(F2-8 배지)와
// 같은 부류다: **보이는 표시 하나로 판별하면 사용자가 겪는 것을 못 잡는다.**
//
// 여기서 보는 것은 셋이다.
//   ⓐ **영역의 활성 탭**이 새 탭인가 — DOM 의 `.main-tab.is-active` (영역이 실제로 그린 것)
//   ⓑ **타건이 새 pane 에 도착**하나 — 마커를 치고 pane 별 `lastSeq` 증가를 본다.
//      타건 없는 **유휴 대조**를 같은 길이로 먼저 떠서 뺀다(셸이 혼자 되울리는 몫).
//   ⓒ `selectedPane` — **기록만 한다. 판별자가 아니다** (그게 옛 통과선의 구멍이었다)
//
// 경로 셋 전부 본다: `⌘T` · 사이드바 `+`(`[data-create-row]`) · 사이드바 메뉴(`빈 탭`).
//
// **이 회차는 고치기 전에 돈다** — 코디네이터 지시: *"문서의 코드 근거는 실측이 아니다."*
// 수정 후에 같은 스크립트를 다시 돌려 전후를 나란히 싣는다.
//
// 격리: `life373-` 세션 전용 · `CORRAL_UI_PREFS` · M0.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, quiesce, press, snapshot } from './app-steps.mjs'
import { ensureWorkspace, m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-g1-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const OUT_NAME = process.env.L373_OUT ?? 'g1-newtab.json'

const 결과 = {
  at: new Date().toISOString(),
  세션: SESSION,
  M0,
  통과선: 'G2′ (§10-R35-1) — 새 탭이 소속 영역의 activeTabId 이고, 타건이 그 pane 에 도착한다',
  경로들: [],
}

/** 화면이 그린 것만 본다 — 영역마다 활성 탭·탭 순서, 그리고 선택된 pane. */
const 화면 = async (app) =>
  (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const groups = [...document.querySelectorAll('[data-group-header]')].map((header) => {
          const groupId = header.dataset.groupHeader
          const tabs = [...header.querySelectorAll('[data-main-tab]')].map((el) => ({
            tabId: el.dataset.mainTab,
            활성: el.classList.contains('is-active'),
          }))
          return { groupId, 탭수: tabs.length, 활성탭: tabs.find((t) => t.활성)?.tabId ?? null, 탭들: tabs.map((t) => t.tabId) }
        })
        return {
          groups,
          선택pane: document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null,
          보이는pane들: [...document.querySelectorAll('[data-term-pane-box]')].map((el) => el.dataset.termPaneBox),
          활성요소: document.activeElement?.className ?? null,
        }
      })()`,
    })
  ).result

const 탭들 = async (app) => {
  const state = await app.state()
  return state.repos
    .flatMap((repo) => repo.worktrees)
    .flatMap((worktree) => worktree.workspace?.tabs ?? [])
    .map((tab) => ({ tabId: tab.tabId, panes: tab.panes.map((pane) => pane.paneId) }))
}

async function 프레임(app) {
  const rows =
    (await app.send({ cmd: 'eval', code: '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()' })).result ?? []
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
let 마커수 = 0
const 마커뽑기 = () => {
  마커수 += 1
  return 'zt' + String(마커수)
}

/** 한 경로 — 새 탭을 만들고 ⓐⓑⓒ 를 잰다. */
async function 한경로(app, { 이름, 만들기 }) {
  console.log(`\n## ${이름}`)
  await quiesce(app)
  const 전화면 = await 화면(app)
  const 전탭 = await 탭들(app)
  await 만들기()
  await sleep(2600)
  await quiesce(app)
  const 후화면 = await 화면(app)
  const 후탭 = await 탭들(app)

  const 전ids = new Set(전탭.map((t) => t.tabId))
  const 새탭 = 후탭.find((t) => !전ids.has(t.tabId)) ?? null
  const 새pane = 새탭?.panes[0] ?? null
  // ⓐ — 새 탭이 **어느 영역에서든** 활성 탭인가. 영역을 못 찾으면 화면에 아예 안 뜬 것이다.
  const 속한영역 = 새탭 === null ? null : (후화면.groups.find((g) => g.탭들.includes(새탭.tabId)) ?? null)
  const 보이나 = 속한영역 !== null && 속한영역.활성탭 === 새탭.tabId
  // ⓑ — 타건이 새 pane 에 가나. 유휴 대조를 **먼저** 뜬다.
  const 유휴 = await 유휴대조(app)
  const 도착 = await 타건도착(app, { 마커: 마커뽑기(), 유휴 })
  const 키가갔나 = 새pane !== null && 도착.받은.length === 1 && 도착.받은[0] === 새pane

  const row = {
    이름,
    새탭: 새탭?.tabId ?? null,
    새pane,
    'ⓐ 보이나': 보이나,
    'ⓐ 속한영역': 속한영역 === null ? null : { groupId: 속한영역.groupId, 활성탭: 속한영역.활성탭, 탭수: 속한영역.탭수 },
    'ⓑ 키가갔나': 키가갔나,
    'ⓑ 도착': 도착,
    'ⓒ 선택pane(기록만)': { 전: 전화면.선택pane, 후: 후화면.선택pane, 새pane인가: 후화면.선택pane === 새pane },
    통과: 보이나 && 키가갔나,
    전화면,
    후화면,
    화면갈무리: await snapshot(app, `g1-${이름}`),
  }
  console.log(
    `  새탭 ${row.새탭} · ⓐ 보이나 ${보이나} (영역 활성탭 ${속한영역?.활성탭 ?? 'null'})` +
      ` · ⓑ 키가갔나 ${키가갔나} (받은 ${JSON.stringify(도착.받은)}) · ⓒ 선택pane 새것인가 ${row['ⓒ 선택pane(기록만)'].새pane인가} → 통과 ${row.통과}`,
  )
  결과.경로들.push(row)
  return row
}

// --- 준비 -----------------------------------------------------------------------------
ensureWorkspace()
결과.초기화 = await resetPanes()
const app = await startApp({ name: 'g1-newtab', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(1200)
await quiesce(app)
결과.출발화면 = await 화면(app)
console.log('# 출발', JSON.stringify(결과.출발화면.groups))

const workspaceId = (await app.state()).repos
  .flatMap((repo) => repo.worktrees)
  .find((worktree) => worktree.openWorkspaceId !== null)?.openWorkspaceId ?? null
결과.workspaceId = workspaceId

// 경로 1 — `⌘T`
await 한경로(app, { 이름: 'cmd-t', 만들기: async () => press(app, { key: 't' }) })
// 경로 2 — 사이드바 `+` (`[data-create-row]`, WorktreeBlock 액션)
await 한경로(app, {
  이름: '사이드바-플러스',
  만들기: async () => app.send({ cmd: 'click', selector: `[data-create-row="${workspaceId}"][data-kind="shell"]` }),
})
// 경로 3 — 사이드바 worktree 메뉴 → `빈 탭`
await 한경로(app, {
  이름: '메뉴-빈탭',
  만들기: async () => {
    const wt = (await app.state()).repos
      .flatMap((repo) => repo.worktrees)
      .find((worktree) => worktree.openWorkspaceId === workspaceId)
    await app.send({ cmd: 'click', selector: `[data-worktree-menu-toggle="${wt.path}"]` })
    await sleep(600)
    await app.send({ cmd: 'click', selector: `[data-worktree-create-shell="${wt.path}"]` })
  },
})

결과.요약 = {
  경로수: 결과.경로들.length,
  'ⓐ 보이나 통과': 결과.경로들.filter((r) => r['ⓐ 보이나']).length,
  'ⓑ 키가갔나 통과': 결과.경로들.filter((r) => r['ⓑ 키가갔나']).length,
  'ⓒ selectedPane 이 새 pane (옛 통과선)': 결과.경로들.filter((r) => r['ⓒ 선택pane(기록만)'].새pane인가).length,
  'G2′ 통과': 결과.경로들.filter((r) => r.통과).length,
}
console.log('\n요약', JSON.stringify(결과.요약))

await app.stop()
await sleep(1200)
결과.M0_끝 = m0End()
writeRaw(OUT_NAME, 결과)
