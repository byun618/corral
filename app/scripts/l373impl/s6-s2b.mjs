// S6(patch 누적 병합 정확성) · S2-b(attach 순서 → 포커스 수렴) — §10-R14·R1·R26-3.
//
//   S6  분할·리사이즈·**pane 닫기**를 섞은 시퀀스에서
//       ⓐ **매 프레임** 연결 내 자기정합 위반 0 (rect 합 == frame · inner ⊂ rect · 겹침 0)
//       ⓑ 각 걸음마다 corral 이 아는 사각형 == 제3 오라클 `pane.layout` (영역 1개라 절대 비교)
//   S2-b 부팅·재연결·worktree 전환이 끝난 **직후** herdr `focused_pane_id` == corral 포커스 pane.
//       **영역 2개 이상**에서 본다 (마운트 시 selectPane 이 활성-마지막 순서를 우회하는지가 여기서 드러난다)
//
// ⓐ 는 밖에서 폴링해서 만들 수 없는 수다 — 앱이 **매 서피스마다** 세고 있던 카운터를 읽기 전용
// 제어 명령(`counters`)으로 꺼낸다. 세는 코드(`countInconsistencies`)는 이 일감 이전부터 있었고
// 계측 실행에서만 돈다.
//
// 격리: `life373-` 세션 전용. M0(내 유령)·M0-b(종료 후)·M0-c(prefs)·M0-d(형제).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, dragPaneDivider, moveTabToNewGroup, press, pressNative, quiesce } from './app-steps.mjs'
import { layout as herdrLayout, m0End, m0Start, paneList, resetPanes, tabList, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-s6-'))
const PREFS = path.join(RUN_DIR, 'ui-prefs.json')
const APP_ENV = { CORRAL_UI_PREFS: PREFS }
const REGISTRY = path.join(RUN_DIR, 'repos.json')

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, S6: { 걸음: [] }, S2b: { 걸음: [] } }

const counters = async (app) => (await app.send({ cmd: 'counters' })).counters
/**
 * corral 이 **입력을 보내는** pane — 반드시 **활성 영역 안에서** 읽는다.
 *
 * `[data-pane-selected="true"]` 는 **영역마다 하나씩** 있다(각 영역이 자기 선택 pane 을 표시한다).
 * 영역이 2개일 때 그냥 `querySelector` 하면 DOM 순서상 **첫 영역**의 것을 집어, 활성 영역이
 * 둘째면 엉뚱한 pane 을 corral 의 포커스라고 적게 된다 (1회차에서 실제로 그렇게 찍혔다).
 */
const 선택pane = async (app) =>
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
          활성영역에서찾음: inActive !== null,
          영역수: document.querySelectorAll('.tab-group').length,
          전체표시: [...document.querySelectorAll('[data-pane-selected="true"]')].map((el) => el.dataset.termPaneBox),
        }
      })()`,
    })
  ).result

/** 한 걸음 — 화면이 아는 사각형 · 제3 오라클 · 누적 카운터를 같은 순간에 뜬다. */
async function 걸음(app, label, { settleMs = 1200 } = {}) {
  await sleep(settleMs)
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
  const row = {
    label,
    at: Date.now(),
    영역수: state.terminalGroups.length,
    pane수: views.length,
    id집합같다:
      JSON.stringify(views.map((v) => v.paneId).sort()) === JSON.stringify(truth.panes.map((p) => p.pane_id).sort()),
    대조,
    구조일치: 대조.length > 0 && 대조.every((r) => r.같다),
    카운터: await counters(app),
  }
  row.자기정합위반 = row.카운터.reduce((sum, c) => sum + (c.inconsistencies ?? 0), 0)
  결과.S6.걸음.push(row)
  console.log(' ', label, '| pane', row.pane수, '| 구조일치', row.구조일치, '| 누적 자기정합위반', row.자기정합위반)
  return row
}

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
// **pane 닫기 직후 프레임** — R16 이 지목한 자리(stale pane 이 다음 전체 서피스 전까지 남는다).
// `⌘W` 는 **진짜 입력 경로**여야 한다 — main 이 메뉴에서 뺏어 온 키라 합성 이벤트는 안 닿는다(R23).
await pressNative(app, { keyCode: 'W', modifiers: ['meta'], settleMs: 80 })
await 걸음(app, 'pane 닫기 **직후**', { settleMs: 80 })
await 걸음(app, 'pane 닫기 뒤 (정착)')
await press(app, { key: 'd' })
await 걸음(app, '다시 분할 (pane 3)')
await pressNative(app, { keyCode: 'W', modifiers: ['meta'], settleMs: 80 })
await 걸음(app, '또 닫기 **직후**', { settleMs: 80 })
await 걸음(app, '또 닫기 뒤 (정착)')
결과.S6.판정 = {
  자기정합위반_누적: 결과.S6.걸음.at(-1).자기정합위반,
  구조일치_전걸음: 결과.S6.걸음.every((row) => row.구조일치),
  id집합_전걸음: 결과.S6.걸음.every((row) => row.id집합같다),
  후보: 결과.S6.걸음.at(-1).카운터,
}
console.log('S6 판정', JSON.stringify(결과.S6.판정))

// --- S2-b — 영역 2개에서 포커스 수렴 ------------------------------------------------------
console.log('\n## S2-b')
const s2b = async (label) => {
  await sleep(1500)
  const 화면 = await 선택pane(app)
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
  console.log(' ', label, '| 화면', 화면.선택, `(영역 ${화면.영역수}, 표시 ${JSON.stringify(화면.전체표시)})`, '| 오라클', truth, '|', row.같나 ? '같다' : '**다르다**')
  return row
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

// ⓑ worktree 전환 왕복 — 영역 2개인 worktree 를 떠났다 돌아온다
{
  const state = await app.state()
  const worktrees = state.repos.flatMap((repo) => repo.worktrees)
  const 지금 = worktrees.find((w) => w.workspace !== null) ?? null
  const 다른 = worktrees.find((w) => w.workspace === null) ?? null
  결과.S2b.worktree = { 지금: 지금?.path ?? null, 다른: 다른?.path ?? null }
  if (다른 !== null && 지금 !== null) {
    await app.click(`[data-worktree="${다른.path}"]`)
    await sleep(4000)
    await quiesce(app)
    await s2b('다른 worktree 로 간 직후')
    await app.click(`[data-worktree="${지금.path}"]`)
    await sleep(3000)
    await quiesce(app)
    await s2b('영역 2개인 worktree 로 **돌아온** 직후')
    // 연 workspace 는 닫고 나간다.
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
