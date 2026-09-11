// M3 — N4(기동 실패 시 유령 행을 남기지 않는다)
//
// # 정책 (구현자 선택 — 결과 문서와 같은 문장이어야 한다)
//
//   **롤백하지 않는다. 탭은 남기고 실패를 행에 적는다.**
//
// 이유 둘. ① 만들어진 pane 은 **살아 있는 셸**이다. 화면을 깔끔하게 만들자고 사용자가 쓸 수 있는
// 셸을 죽이는 것은 실패 보고를 위해 벌이는 두 번째 파괴다. ② 롤백하면 실패가 스쳐 지나가는
// 토스트로만 남는다 — 무엇이 왜 안 떴는지 **화면에 계속 남는 쪽**이 정직하다.
// "유령 행" 은 *에이전트가 도는 척하는 행*을 말한다. 이 정책의 행은 그 반대다: 셸이라고 말한다.
//
// # 실패 두 갈래를 **일부러** 주입한다
//
//   ① 즉답 거절 — 미지원 kind (`unsupported_agent_kind`). 다시 걸어도 같은 결과다
//   ② 기동 안 됨 — 설치되지 않은 kind(`gemini`). `agent.start` 는 **성공**을 돌려주고
//      셸에는 `command not found` 가 찍힌다. 관측 예산(30초)이 지나야 실패로 판정된다
//   ③ **탭을 못 만듦** — `tab.create` 자체가 거절된다 (수정 1회차에 추가. 1차 리뷰 중간 1).
//      빈 키가 든 env 를 주면 herdr 가 `invalid_env` 로 진짜로 튕긴다(`CORRAL_INJECT_BAD_ENV=1`).
//      이 실패는 탭도 pane 도 없다 — 화면에 남는 것은 기동 기록 한 줄뿐이고, 1회차에는 그걸
//      지울 손잡이가 없었다. 그래서 여기서는 **`×` 로 털리는 것까지** 잰다.
//
// UI 는 4종만 고르게 하므로 주입은 제어 채널의 `create-row`(= UI 가 부르는 것과 **같은 핸들러**)로
// 넣는다. 재는 대상은 UI 위젯이 아니라 lifecycle 의 실패 정책이다.

import {
  createRowByUi,
  clickWhenVisible,
  alive,
  clickLog,
  firstWorkspaceId,
  herdrTruth,
  paneProcesses,
  request,
  sleep,
  startApp,
  tidySession,
  until,
  writeRaw,
} from './lib.mjs'

const CASES = [
  { name: '미지원-kind', kind: 'definitely_not_a_kind', 기대: 'unsupported_agent_kind 즉답 거절' },
  { name: '설치안됨-gemini', kind: 'gemini', 기대: 'agent.start 는 성공 · 관측 예산 초과로 실패' },
]

await tidySession()
const app = await startApp({ name: 'm3-fail' })
const workspaceId = await firstWorkspaceId(app)
const out = { at: new Date().toISOString(), 정책: '롤백하지 않는다 — 탭은 남기고 실패를 행에 적는다', cases: [] }

for (const item of CASES) {
  const beforeTabs = new Set((await herdrTruth()).tabs)
  const askedAt = Date.now()
  const injected = await app.createRow(workspaceId, item.kind)

  const grew = await until(async () => (await herdrTruth()).tabs.find((tabId) => !beforeTabs.has(tabId)) ?? null, {
    what: '새 탭',
    timeoutMs: 15000,
    everyMs: 80,
  })
  const tabId = grew.value
  const paneId =
    tabId === null ? null : ((await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null)

  // 실패로 정착할 때까지 본다. ①은 즉시, ②는 관측 예산(30초) 뒤다.
  const shots = []
  const settled = await until(
    async () => {
      const state = await app.state()
      const launch = state.lifecycle.launches.find((row) => row.paneId === paneId) ?? null
      if (shots.length === 0 || shots.at(-1).phase !== (launch?.phase ?? 'gone')) {
        const shot = await app.shot(`n4-${item.name}-${launch?.phase ?? 'gone'}`, '.panel.grow')
        shots.push({ seq: shot.seq, file: shot.file, sinceAskMs: shot.at - askedAt, phase: launch?.phase ?? 'gone' })
      }
      return launch !== null && (launch.phase === 'failed' || launch.phase === 'running') ? launch : null
    },
    { what: `${item.name} 정착`, timeoutMs: 60000, everyMs: 500 },
  )

  // ── 정책대로 되었나 ──────────────────────────────────────────────────────
  const herdr = await herdrTruth()
  const state = await app.state()
  const tab = state.workspaces.flatMap((row) => row.tabs).find((row) => row.tabId === tabId) ?? null
  const processes = paneId === null ? null : await paneProcesses(paneId)
  const badge = await app.query(`[data-launch-phase="failed"]`)
  const screen = paneId === null ? null : await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })

  out.cases.push({
    ...item,
    askedAt,
    ipc결과: injected.result,
    tabId,
    paneId,
    실패까지ms: settled.ok ? settled.ms : null,
    앱단계: settled.value?.phase ?? null,
    앱사유: settled.value?.error ?? null,
    화면배지: badge.found,
    /** 정책 ①: 탭이 **남아 있다** (롤백 안 함) — herdr 와 corral 양쪽에서 */
    herdr에탭남음: herdr.tabs.includes(tabId),
    corral에탭남음: tab !== null,
    /** 정책 ②: 그 pane 은 **쓸 수 있는 셸**이다 — 에이전트인 척하지 않는다 */
    포그라운드: processes?.foreground.map((process) => process.cmdline) ?? [],
    셸PID살아있음: alive(processes?.shellPid ?? -1),
    corral이붙인에이전트: tab?.panes.map((pane) => pane.agent) ?? [],
    pane화면끝: (screen?.read?.text ?? '').split('\n').filter((line) => line.trim()).slice(-3),
    샷: shots,
  })
  console.log(item.name, '→', settled.value?.phase, '|', settled.value?.error)
  await sleep(400)
}

out.앱로그 = app
  .entries()
  .filter((entry) => String(entry.tag).startsWith('life.'))
  .map((entry) => ({ tag: entry.tag, ...entry }))

const shot = await app.shot('n4-both-rows')
out.최종샷 = shot.file
await app.stop()

// ── ③ tab.create 실패 — 별도 실행에서 잰다 (주입이 그 실행의 모든 생성에 걸리므로) ────────
await tidySession()
const bad = await startApp({ name: 'm3-fail-badenv', env: { CORRAL_INJECT_BAD_ENV: '1' } })
const badWorkspace = await firstWorkspaceId(bad)
const beforeTabs = (await herdrTruth()).tabs
const askedAt = Date.now()
await createRowByUi(bad, badWorkspace, 'claude') // **화면의 버튼**으로 만든다
const failed = await until(
  async () => (await bad.state()).lifecycle.launches.find((row) => row.phase === 'failed') ?? null,
  { what: 'tab.create 실패 정착', timeoutMs: 30000, everyMs: 200 },
)
const openShot = await bad.shot('n4-tabcreate-failed')
const badge = await bad.query('[data-launch-phase="failed"]')
const sub = await bad.query('.row-pending .row-sub')
const dismissable = await bad.query(`[data-dismiss-launch]`)
const afterTabs = (await herdrTruth()).tabs

// 털린다 — `×` 를 **진짜로** 누른다 (히트테스트를 거친다).
const dismissAt = Date.now()
await clickWhenVisible(bad, `[data-dismiss-launch="${failed.value?.launchId ?? ''}"]`)
const cleared = await until(async () => (await bad.state()).lifecycle.launches.length === 0, {
  what: '기록 털림',
  timeoutMs: 8000,
  everyMs: 60,
})
const afterShot = await bad.shot('n4-tabcreate-dismissed')

out.cases.push({
  name: '탭생성실패-invalid_env',
  kind: 'claude',
  기대: 'tab.create 가 herdr 에서 거절 — 탭도 pane 도 없다',
  askedAt,
  실패까지ms: failed.ok ? failed.ms : null,
  앱단계: failed.value?.phase ?? null,
  앱사유: failed.value?.error ?? null,
  tabId: failed.value?.tabId ?? null,
  paneId: failed.value?.paneId ?? null,
  화면배지: badge.found,
  화면부제: sub.found,
  '털 수 있나(× 있음)': dismissable.found.length > 0,
  'herdr 탭 수 변화': { 전: beforeTabs.length, 후: afterTabs.length },
  털림ms: cleared.ok ? Date.now() - dismissAt : null,
  '털린 뒤 기동기록': (await bad.state()).lifecycle.launches.length,
  샷: [openShot.file, afterShot.file],
})
console.log('탭생성실패 →', failed.value?.error, '| 털림', cleared.ok)

out.앱로그2 = bad
  .entries()
  .filter((entry) => String(entry.tag).startsWith('life.'))
  .map((entry) => ({ tag: entry.tag, ...entry }))
out.클릭증거 = clickLog()
writeRaw('n4-launch-failures.json', out)
await bad.stop()
await tidySession()
