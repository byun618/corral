// S6(patch 누적 병합 정확성) · S2-b(attach 순서 → 포커스 수렴) — §10-R14·R1·R26-3.
//
//   S6  분할·리사이즈·**pane 닫기**를 섞은 시퀀스에서
//       ⓐ **매 프레임** 연결 내 자기정합 위반 0 (rect 합 == frame · inner ⊂ rect · 겹침 0)
//       ⓑ 각 걸음마다 corral 이 아는 사각형 == 제3 오라클 `pane.layout` (영역 1개라 절대 비교)
//   S2-b 부팅·재연결·worktree 전환이 끝난 **직후** herdr `focused_pane_id` == corral 포커스 pane.
//       **영역 2개 이상**에서 본다 (활성 영역이 바뀌는 순간이 이 통과선의 진짜 입구다)
//
// ⓐ 는 밖에서 폴링해서 만들 수 없는 수다 — 앱이 **매 서피스마다** 세고 있던 카운터를 읽기 전용
// 제어 명령(`counters`)으로 꺼낸다. 세는 코드(`countInconsistencies`)는 이 일감 이전부터 있었고
// 계측 실행에서만 돈다.
//
// **2회차에서 바꾼 것**(1회차 결과는 이 두 가지로 못 쓴다 — 03-result R5 에 diff 를 남긴다):
//   1. `선택pane` 이 **활성 영역 안에서** 읽는다. `[data-pane-selected]` 는 영역마다 하나씩이라
//      그냥 `querySelector` 하면 DOM 순서상 첫 영역 것을 집는다 (1회차 S2-b 4/5 불일치의 정체).
//   2. `pane 닫기 직후` 를 **단발 80ms 표본**에서 **N=10 회 + 수렴까지 폴링**으로 바꿨다.
//      단발은 IPC 전파 창에 걸리면 앞뒤 회차가 뒤집힌다(1회차 통과·2회차 미달, 같은 코드).
//      여기서 재는 것은 "언제 수렴하나"이고, **판정선은 코디네이터가 정한다**.
//
// 격리: `life373-` 세션 전용. M0(내 유령)·M0-b(종료 후)·M0-c(prefs)·M0-d(형제).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, dragPaneDivider, moveTabToNewGroup, press, pressNative, quiesce } from './app-steps.mjs'
import { ensureWorkspace, layout as herdrLayout, m0End, m0Start, paneList, resetPanes, tabList, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-s6-'))
const PREFS = path.join(RUN_DIR, 'ui-prefs.json')
const APP_ENV = { CORRAL_UI_PREFS: PREFS }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
/** 닫기 직후를 몇 번 보나 — 단발 표본이 뒤집히는 것을 본 뒤로 반복이 기본이다. */
const CLOSE_ROUNDS = 10
/** 수렴 폴링 상한. 한 표본은 `state`+`pane layout`(CLI 1회)이라 실제 간격은 60~100ms 다. */
const CONVERGE_TIMEOUT_MS = 3000

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, S6: { 걸음: [], 닫기회차: [] }, S2b: { 걸음: [] } }

const counters = async (app) => (await app.send({ cmd: 'counters' })).counters

/**
 * 화면이 지금 어디를 가리키나 — **활성 worktree · 활성 영역 · 그 영역의 선택 pane**.
 *
 * `[data-pane-selected="true"]` 는 **영역마다 하나씩** 있다(각 영역이 자기 선택 pane 을 표시한다).
 * 영역이 2개일 때 그냥 `querySelector` 하면 DOM 순서상 **첫 영역**의 것을 집어, 활성 영역이
 * 둘째면 엉뚱한 pane 을 corral 의 포커스라고 적게 된다 (1회차에서 실제로 그렇게 찍혔다).
 */
const 화면포커스 = async (app) =>
  (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const active = document.querySelector('.tab-group.is-active-group')
        const inActive = active === null ? null : active.querySelector('[data-pane-selected="true"]')
        const any = document.querySelector('[data-pane-selected="true"]')
        const node = inActive ?? any
        return {
          선택: node === null ? null : node.dataset.termPaneBox,
          활성영역: active === null ? null : active.dataset.tabGroup,
          활성영역에서찾음: inActive !== null,
          활성worktree: document.querySelector('.worktree-block.is-selected')?.dataset.worktree ?? null,
          영역별: [...document.querySelectorAll('.tab-group')].map((el) => ({
            groupId: el.dataset.tabGroup,
            활성: el.classList.contains('is-active-group'),
            선택: el.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null,
          })),
        }
      })()`,
    })
  ).result

/** corral 이 아는 사각형 vs 제3 오라클 — 한 표본. */
async function 대조표본(app) {
  const state = await app.state()
  const views = state.terminalGroups.flatMap((group) => group.panes.map((pane) => ({ groupId: group.groupId, ...pane })))
  const truth = herdrLayout()
  const 대조 = views.map((view) => {
    const rect = truth.panes.find((pane) => pane.pane_id === view.paneId)?.rect ?? null
    return {
      paneId: view.paneId,
      corral: view.rect,
      herdr: rect,
      같다:
        rect !== null &&
        view.rect.x === rect.x &&
        view.rect.y === rect.y &&
        view.rect.width === rect.width &&
        view.rect.height === rect.height,
    }
  })
  const 카운터 = await counters(app)
  return {
    at: Date.now(),
    영역수: state.terminalGroups.length,
    pane수: views.length,
    id집합같다:
      JSON.stringify(views.map((v) => v.paneId).sort()) === JSON.stringify(truth.panes.map((p) => p.pane_id).sort()),
    구조일치: 대조.length > 0 && 대조.every((r) => r.같다),
    대조,
    카운터,
    자기정합위반: 카운터.reduce((sum, c) => sum + (c.inconsistencies ?? 0), 0),
  }
}

/** 한 걸음 — 화면·오라클·카운터를 같은 순간에 뜬다. */
async function 걸음(app, label, { settleMs = 1200 } = {}) {
  await sleep(settleMs)
  const row = { label, ...(await 대조표본(app)) }
  결과.S6.걸음.push(row)
  console.log(' ', label, '| pane', row.pane수, '| 구조일치', row.구조일치, '| 누적 자기정합위반', row.자기정합위반)
  return row
}

결과.workspace = ensureWorkspace()
결과.초기화 = await resetPanes()
let app = await startApp({ name: 's6-s2b', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(800)
await quiesce(app)

// --- S6 — 분할 · 리사이즈 · **닫기** 를 섞는다 -------------------------------------------
console.log('\n## S6')
await 걸음(app, '시작 (pane 1)')
await press(app, { key: 'd' })
await 걸음(app, '우분할 (pane 2)')
await press(app, { key: 'd', shift: true })
await 걸음(app, '하분할 (pane 3)')
결과.S6.드래그 = await dragPaneDivider(app, { direction: 'row', px: 120, steps: 6, shot: 's6-drag' })
await 걸음(app, '경계 드래그 뒤')

/**
 * **pane 닫기 직후** — R16 이 지목한 자리(stale pane 이 다음 전체 서피스 전까지 남는다).
 *
 * `⌘W` 는 **진짜 입력 경로**여야 한다 — main 이 메뉴에서 뺏어 온 키라 합성 이벤트는 안 닿는다(R23).
 * 닫은 **직후부터** 수렴할 때까지 계속 뜬다: 첫 표본은 가능한 한 빨리, 그 다음은 `state`+오라클
 * 왕복이 걸리는 대로. 기록하는 것은 ① 첫 표본이 이미 일치했나 ② 언제 수렴했나 ③ 그 창 동안
 * **자기정합 위반이 늘었나**다. ③ 이 0 이면 화면은 "옛 배치를 옛 배치대로" 그리고 있었다는 뜻이다.
 */
async function 닫기회차(app, round) {
  await press(app, { key: 'd' }) // 다시 3 pane 으로
  await sleep(1200)
  const 전 = await 대조표본(app)
  const t0 = Date.now()
  await pressNative(app, { keyCode: 'W', modifiers: ['meta'], settleMs: 0 })
  const 표본 = []
  let 수렴ms = null
  while (Date.now() - t0 < CONVERGE_TIMEOUT_MS) {
    const sample = await 대조표본(app)
    const 수렴 = sample.구조일치 && sample.id집합같다 && sample.pane수 === 전.pane수 - 1
    표본.push({ ms: sample.at - t0, pane수: sample.pane수, 구조일치: sample.구조일치, id집합같다: sample.id집합같다, 자기정합위반: sample.자기정합위반 })
    if (수렴) {
      수렴ms = sample.at - t0
      break
    }
  }
  const row = {
    round,
    전pane수: 전.pane수,
    첫표본ms: 표본[0]?.ms ?? null,
    첫표본일치: 표본[0]?.구조일치 === true && 표본[0]?.id집합같다 === true,
    수렴ms,
    표본수: 표본.length,
    창중_자기정합증가: (표본.at(-1)?.자기정합위반 ?? 0) - 전.자기정합위반,
    표본,
  }
  결과.S6.닫기회차.push(row)
  console.log(
    `  닫기 ${round}/${CLOSE_ROUNDS} | 첫표본 ${row.첫표본ms}ms ${row.첫표본일치 ? '일치' : '아직'} | 수렴 ${수렴ms ?? '못함'}ms | 창중 자기정합증가 ${row.창중_자기정합증가}`,
  )
  await sleep(600)
}

for (let round = 1; round <= CLOSE_ROUNDS; round++) await 닫기회차(app, round)
await 걸음(app, '닫기 반복 뒤 (정착)')

{
  const 수렴들 = 결과.S6.닫기회차.map((r) => r.수렴ms).filter((v) => v !== null)
  결과.S6.판정 = {
    자기정합위반_누적: 결과.S6.걸음.at(-1).자기정합위반,
    구조일치_정착걸음: 결과.S6.걸음.every((row) => row.구조일치),
    id집합_정착걸음: 결과.S6.걸음.every((row) => row.id집합같다),
    닫기회차수: 결과.S6.닫기회차.length,
    첫표본일치_회차: 결과.S6.닫기회차.filter((r) => r.첫표본일치).length,
    수렴_최대ms: 수렴들.length === 0 ? null : Math.max(...수렴들),
    수렴_중앙ms: 수렴들.length === 0 ? null : 수렴들.sort((a, b) => a - b)[Math.floor(수렴들.length / 2)],
    수렴못한회차: 결과.S6.닫기회차.filter((r) => r.수렴ms === null).length,
    창중_자기정합증가_합: 결과.S6.닫기회차.reduce((sum, r) => sum + r.창중_자기정합증가, 0),
    후보: 결과.S6.걸음.at(-1).카운터 ?? null,
  }
}
console.log('S6 판정', JSON.stringify(결과.S6.판정))

// --- S2-b — 영역 2개에서 포커스 수렴 ------------------------------------------------------
console.log('\n## S2-b')
const s2b = async (label) => {
  await sleep(1500)
  const 화면 = await 화면포커스(app)
  const truth = herdrLayout().focused_pane_id
  const state = await app.state()
  const row = {
    label,
    화면선택pane: 화면.선택,
    화면상세: 화면,
    오라클focused: truth,
    같나: 화면.선택 !== null && 화면.선택 === truth,
    영역수: state.terminalGroups.length,
  }
  결과.S2b.걸음.push(row)
  console.log(
    ' ',
    label,
    '| 화면',
    화면.선택,
    `(활성영역 ${화면.활성영역}, 영역별 ${JSON.stringify(화면.영역별)})`,
    '| 오라클',
    truth,
    '|',
    row.같나 ? '같다' : '**다르다**',
  )
  return row
}

/** worktree 행을 누르고 **화면이 실제로 그 worktree 로 갔는지**까지 확인한다. */
async function worktree로(app, worktreePath, { clicks = 3, waitMs = 4000 } = {}) {
  const 시도 = []
  for (let n = 1; n <= clicks; n++) {
    await app.click(`[data-worktree="${worktreePath}"]`)
    await sleep(waitMs)
    await quiesce(app)
    const 화면 = await 화면포커스(app)
    시도.push({ 클릭: n, 활성worktree: 화면.활성worktree })
    if (화면.활성worktree === worktreePath) return { worktreePath, 도달: true, 클릭수: n, 시도 }
  }
  return { worktreePath, 도달: false, 클릭수: clicks, 시도 }
}

// 영역 2개로 만든다 — 탭이 둘 이상이어야 한다.
{
  const state = await app.state()
  const workspace = state.repos.flatMap((r) => r.worktrees).find((w) => w.workspace !== null)?.workspace ?? null
  if (workspace !== null && workspace.tabs.length < 2) {
    await press(app, { key: 't' })
    await sleep(2500)
  }
}
await quiesce(app)
{
  const state = await app.state()
  const workspace = state.repos.flatMap((r) => r.worktrees).find((w) => w.workspace !== null)?.workspace ?? null
  const second = workspace?.tabs[1] ?? workspace?.tabs[0] ?? null
  if (second !== null) await moveTabToNewGroup(app, { tabId: second.tabId, direction: 'right' })
  await sleep(2000)
  await quiesce(app)
}
await s2b('영역 2개 만든 직후')

// ⓐ 재연결 — 연결을 다시 세운 직후
await app.send({ cmd: 'resync', reason: 's2b' })
await s2b('resync 직후')

// ⓑ worktree 전환 왕복 — 영역 2개인 worktree 를 떠났다 돌아온다.
//   **떠난 것을 먼저 확인한다** — 화면이 안 따라갔는데 "돌아왔다"고 적으면 그 걸음은 거짓이다.
{
  const state = await app.state()
  const worktrees = state.repos.flatMap((repo) => repo.worktrees)
  const 지금 = worktrees.find((w) => w.workspace !== null) ?? null
  const 다른 = worktrees.find((w) => w.workspace === null && w.path !== 지금?.path) ?? null
  결과.S2b.worktree = { 지금: 지금?.path ?? null, 다른: 다른?.path ?? null }
  if (다른 !== null && 지금 !== null) {
    결과.S2b.가기 = await worktree로(app, 다른.path)
    console.log('  다른 worktree 도달', JSON.stringify(결과.S2b.가기))
    await s2b(결과.S2b.가기.도달 ? '다른 worktree 로 간 직후' : '다른 worktree 클릭했으나 **화면은 안 갔다**')
    결과.S2b.오기 = await worktree로(app, 지금.path)
    console.log('  돌아오기 도달', JSON.stringify(결과.S2b.오기))
    await s2b(결과.S2b.오기.도달 ? '영역 2개인 worktree 로 **돌아온** 직후' : '돌아오기 클릭했으나 **화면은 안 갔다**')
    const state2 = await app.state()
    const 연것 = state2.repos.flatMap((r) => r.worktrees).find((w) => w.path === 다른.path)?.workspace ?? null
    결과.S2b.닫기 = 연것?.workspaceId ?? null
  }
}

// ⓒ 부팅 — 같은 prefs 로 다시 띄운다 (영역 2개가 복원된다)
await app.stop()
await sleep(1500)
app = await startApp({ name: 's6-s2b-boot', env: APP_ENV, registryFile: REGISTRY })
await sleep(2500)
await quiesce(app)
await s2b('재기동(부팅) 직후')

결과.S2b.판정 = {
  전걸음같나: 결과.S2b.걸음.every((row) => row.같나),
  같은걸음: 결과.S2b.걸음.filter((row) => row.같나).length,
  걸음수: 결과.S2b.걸음.length,
  영역수_마지막: 결과.S2b.걸음.at(-1)?.영역수 ?? null,
}
console.log('S2-b 판정', JSON.stringify(결과.S2b.판정))

결과.끝카운터 = await counters(app)
await app.stop()
await sleep(1500)
if (결과.S2b.닫기 !== null && 결과.S2b.닫기 !== undefined) {
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('herdr', ['--session', SESSION, 'workspace', 'close', 결과.S2b.닫기])
    결과.S2b.닫기결과 = '닫았다'
  } catch (error) {
    결과.S2b.닫기결과 = String(error instanceof Error ? error.message : error)
  }
}
결과.M0_끝 = m0End()
결과.끝오라클 = { pane수: paneList().length, 탭수: tabList().length }
writeRaw('s6-s2b.json', 결과)
console.log('\n요약')
console.log(' S6 ', JSON.stringify(결과.S6.판정))
console.log(' S2b', JSON.stringify(결과.S2b.판정))
