// M4 — N6(되돌릴 수 없는 종료에는 확인 단계가 있다)
//
// 세 갈래를 본다.
//   ① 에이전트가 도는 행 × [취소] → **아무것도 안 죽는다.** PID 로 확인한다 (관문 ⑤)
//   ② 같은 행 × [종료한다] → 둘 다 죽는다
//   ③ 셸만 있는 행 → 확인 없이 닫힌다. 이것이 정책이다: **되돌릴 수 없는 것이 있을 때만** 묻는다
//
// 누르는 것은 **화면의 진짜 버튼**이다 (`click`). main 핸들러를 직접 부르면 모달이 실제로
// 그 IPC 를 막는지가 증명되지 않는다.
//
// 남는 공백: herdr 의 `confirmation_required`(worktree 그룹을 닫게 되는 경우)는 재현하지 않았다.
// 분석 §8 이 미실측으로 남긴 것이고, 만들려면 linked worktree workspace 가 필요하다.
// 코드 경로는 `lifecycle.close` 의 `response.error` 갈래에 있고 **강제 종료로 승격하지 않는다**.

import {
  alive,
  clickWhenVisible,
  createRowByUi,
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

await tidySession()
const app = await startApp({ name: 'm4-confirm' })
const workspaceId = await firstWorkspaceId(app)
const out = { at: new Date().toISOString(), cases: [] }

/** claude 행 하나를 만들고 **떴다는 것을 관측한 뒤** 그 탭·pane·PID 를 돌려준다. */
async function makeAgentRow() {
  const before = new Set((await herdrTruth()).tabs)
  await createRowByUi(app, workspaceId, 'claude')
  const grew = await until(async () => (await herdrTruth()).tabs.find((tabId) => !before.has(tabId)) ?? null, {
    what: '새 탭',
    everyMs: 80,
  })
  const tabId = grew.value
  const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null
  const up = await until(
    async () => (await paneProcesses(paneId)).foreground.find((item) => (item.argv0 ?? '') === 'claude') ?? null,
    { what: 'claude 기동', timeoutMs: 60000, everyMs: 300 },
  )
  const processes = await paneProcesses(paneId)
  return { tabId, paneId, shellPid: processes.shellPid, agentPid: up.value?.pid ?? null }
}

// ── ① 취소 ────────────────────────────────────────────────────────────────
{
  const row = await makeAgentRow()
  await clickWhenVisible(app, `[data-close-tab="${row.tabId}"]`)
  // 모달은 IPC 왕복 뒤에 뜬다 — 클릭 직후에 물으면 아직 없다. 나타날 때까지 본다.
  const modal = await until(
    async () => {
      const found = (await app.query('[data-modal="close-confirm"] .modal-body')).found
      return found.length > 0 ? found : null
    },
    { what: '확인 모달', timeoutMs: 10000, everyMs: 100 },
  )
  // DOM 에 붙는 것과 **그려지는 것**은 한 프레임 다르다. 샷은 그려진 뒤에 찍는다.
  await sleep(400)
  const shotOpen = await app.shot('n6-confirm-open')
  await clickWhenVisible(app, '[data-confirm="cancel"]')
  await sleep(1500) // 취소가 늦게 죽이는 경로가 있는지 보려면 좀 기다렸다 물어야 한다
  const shotAfter = await app.shot('n6-after-cancel')
  const herdr = await herdrTruth()
  out.cases.push({
    이름: '①-에이전트-행-취소',
    ...row,
    모달문구: modal.value,
    모달뜨기까지ms: modal.ms,
    /** 취소하면 **아무것도 안 죽는다** — herdr 응답이 아니라 PID 가 근거다 */
    셸살아있음: alive(row.shellPid),
    에이전트살아있음: alive(row.agentPid),
    herdr에탭남음: herdr.tabs.includes(row.tabId),
    corral에탭남음: (await app.state()).workspaces.some((item) => item.tabs.some((tab) => tab.tabId === row.tabId)),
    /** 취소는 herdr 로 **아무 요청도 보내지 않는다** — tab.close 가 로그에 없어야 한다 */
    tab_close요청수: app.entries().filter((entry) => entry.tag === 'life.close.request').length,
    needs_confirm로그: app.entries().filter((entry) => entry.tag === 'life.close.needs_confirm').map((entry) => entry.running),
    샷: [shotOpen.file, shotAfter.file],
  })

  // ── ② 같은 행을 이번엔 승인해서 닫는다 ──────────────────────────────────
  await clickWhenVisible(app, `[data-close-tab="${row.tabId}"]`)
  await clickWhenVisible(app, '[data-confirm="close"]')
  const dead = await until(() => !alive(row.shellPid) && !alive(row.agentPid), {
    what: 'PID 사멸',
    timeoutMs: 20000,
    everyMs: 25,
  })
  out.cases.push({
    이름: '②-같은-행-승인',
    ...row,
    사멸까지ms: dead.ok ? dead.ms : null,
    셸살아있음: alive(row.shellPid),
    에이전트살아있음: alive(row.agentPid),
    herdr에탭남음: (await herdrTruth()).tabs.includes(row.tabId),
    샷: [(await app.shot('n6-after-confirm')).file],
  })
}

// ── ③ 셸만 있는 행 — 확인 없이 닫힌다 ──────────────────────────────────────
{
  const before = new Set((await herdrTruth()).tabs)
  await createRowByUi(app, workspaceId, 'shell')
  const grew = await until(async () => (await herdrTruth()).tabs.find((tabId) => !before.has(tabId)) ?? null, {
    what: '새 탭',
    everyMs: 80,
  })
  const tabId = grew.value
  const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null
  // 셸이 **프롬프트에 온 뒤** 닫아야 "셸만 있는 행" 을 닫는 것이 된다.
  await until(async () => (await paneProcesses(paneId)).foreground.length === 1, { what: '프롬프트', everyMs: 200 })
  const processes = await paneProcesses(paneId)
  const closeRequestsBefore = app.entries().filter((entry) => entry.tag === 'life.close.request').length
  await clickWhenVisible(app, `[data-close-tab="${tabId}"]`)
  const modalShown = await until(async () => (await app.query('[data-modal="close-confirm"]')).found.length > 0, {
    what: '모달(안 떠야 정상)',
    timeoutMs: 2500,
    everyMs: 150,
  })
  const dead = await until(() => !alive(processes.shellPid), { what: 'PID 사멸', timeoutMs: 20000, everyMs: 25 })
  out.cases.push({
    이름: '③-셸-행-확인없이',
    tabId,
    paneId,
    shellPid: processes.shellPid,
    모달이떴나: modalShown.ok,
    사멸까지ms: dead.ok ? dead.ms : null,
    셸살아있음: alive(processes.shellPid),
    close요청증가: app.entries().filter((entry) => entry.tag === 'life.close.request').length - closeRequestsBefore,
  })
}

out.공백 = {
  'herdr confirmation_required': '재현하지 않았다 (linked worktree workspace 가 필요 — 분석 §8). 코드 경로는 그대로 보이고 멈춘다',
}
writeRaw('n6-close-confirm.json', out)
writeRaw('m4-app-log.ndjson', app.entries().map((entry) => JSON.stringify(entry)).join('\n') + '\n')
console.log(JSON.stringify(out.cases, null, 2))
await app.stop()
await tidySession()
