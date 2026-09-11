// M5 — N7(목록 정합: G1·G2 를 닫는다)
//
// 세 경우를 각 5회, corral 상태와 **같은 시각의** herdr `tab.list`·`pane.list` 를 대조한다.
//
//   ⓐ `tab.close` 뒤 그 탭의 pane 잔재 0           ← G1
//   ⓑ 마지막 pane 을 닫아 탭이 herdr 에서 사라진 뒤 유령 탭 행 0   ← G2
//   ⓒ 마지막 탭 종료 시 workspace 행도 사라짐        ← 이미 있던 경로(G3)가 도는지 확인
//
// **스냅샷 재조회로 덮어 맞춘 것은 통과가 아니다** (기준 N7). 그래서 회차마다 그 구간에
// `boot.snapshot.applied` 가 한 번도 없었음을 로그로 함께 증명한다 — 있으면 그 회차는 무효다.
//
// ⓑ 는 corral 의 UI 에 없는 경로다(`pane.close` 는 스플릿 종료이고 이 일감 범위 밖). 그래도
// **목록 정합**은 corral 의 책임이라 하네스가 herdr 에 직접 걸어 corral 이 따라오는지 본다.

import {
  createRowByUi,
  firstWorkspaceId,
  corralIds,
  clickWhenVisible,
  herdrTruth,
  request,
  sleep,
  startApp,
  tidySession,
  until,
  writeRaw,
} from './lib.mjs'

const TIMES = Number(process.env.L346_TIMES ?? 5)

await tidySession()
const app = await startApp({ name: 'm5-consistency' })
const out = { at: new Date().toISOString(), cases: { a: [], b: [], c: [] } }

/** 그 구간에 스냅샷 재조회가 있었나 — 있으면 "이벤트 경로가 맞았다" 를 말할 수 없다. */
function snapshotsSince(mark) {
  return app.entries().filter((entry) => entry.tag === 'boot.snapshot.applied' && entry.at >= mark).length
}

/**
 * 행을 닫는다. **확인 모달이 뜨면 승인한다.**
 *
 * 셸이 `.zshrc` 를 읽는 좁은 창에서는 `cat`·`chmod` 가 자기 프로세스 그룹으로 잠깐 뜬다 —
 * 그러면 확인 문이 열린다(정책상 맞다). 1회차 ⓒ 는 그 모달을 안 누르고 넘어가 회차가 통째로
 * 헛돌았다: 아무것도 안 닫혔는데 corral·herdr 가 똑같아서 "일치" 로 적혔다. 실패는 조용하면 안 된다.
 */
async function closeRowByUi(tabId) {
  await clickWhenVisible(app, `[data-close-tab="${tabId}"]`)
  const modal = await until(async () => (await app.query('[data-modal="close-confirm"]')).found.length > 0, {
    what: '확인 모달',
    timeoutMs: 1200,
    everyMs: 60,
  })
  if (modal.ok) await clickWhenVisible(app, '[data-confirm="close"]')
  return modal.ok
}

/** 그 pane 이 **프롬프트에 온** 뒤에 닫는다 — 사용자가 하는 일이 그렇다. */
async function waitPrompt(paneId) {
  return until(
    async () => {
      const info = (await request('pane.process_info', { pane_id: paneId })).process_info
      return info.foreground_processes?.length === 1 && info.shell_pid === info.foreground_process_group_id
    },
    { what: '프롬프트', timeoutMs: 20000, everyMs: 150 },
  )
}

/** corral 과 herdr 를 나란히 떠서 맞춰 본다. 어느 쪽도 먼저 고쳐 주지 않는다. */
async function compare() {
  const [state, truth] = await Promise.all([app.state(), herdrTruth()])
  const mine = corralIds(state)
  // 키 순서가 아니라 **집합**을 맞춘다. (첫 회차에 JSON 문자열로 비교해 순서 때문에 전부
  // 불일치로 나왔다 — 차이 목록은 전부 비어 있는데 판정만 false 였다.)
  const same = (a, b) => a.length === b.length && a.every((id, index) => id === b[index])
  return {
    corral: mine,
    herdr: truth,
    일치: same(mine.tabs, truth.tabs) && same(mine.panes, truth.panes) && same(mine.workspaces, truth.workspaces),
    차이: {
      탭_corral만: mine.tabs.filter((id) => !truth.tabs.includes(id)),
      탭_herdr만: truth.tabs.filter((id) => !mine.tabs.includes(id)),
      pane_corral만: mine.panes.filter((id) => !truth.panes.includes(id)),
      pane_herdr만: truth.panes.filter((id) => !mine.panes.includes(id)),
      ws_corral만: mine.workspaces.filter((id) => !truth.workspaces.includes(id)),
      ws_herdr만: truth.workspaces.filter((id) => !mine.workspaces.includes(id)),
    },
  }
}

/** 셸 행 하나를 UI 로 만들고 herdr 가 그 탭을 알 때까지 기다린다. */
async function addShellRow(workspaceId) {
  const before = new Set((await herdrTruth()).tabs)
  await createRowByUi(app, workspaceId, 'shell')
  const grew = await until(async () => (await herdrTruth()).tabs.find((tabId) => !before.has(tabId)) ?? null, {
    what: '새 탭',
    everyMs: 60,
  })
  const tabId = grew.value
  const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null
  // corral 도 그 행을 알게 될 때까지. 여기까지가 준비고, 재는 것은 **닫은 뒤**다.
  await until(async () => (await app.state()).workspaces.some((row) => row.tabs.some((tab) => tab.tabId === tabId)), {
    what: '목록 반영',
    everyMs: 40,
  })
  return { tabId, paneId }
}

// ── ⓐ tab.close 뒤 pane 잔재 0 (G1) ───────────────────────────────────────
for (let round = 1; round <= TIMES; round++) {
  const workspaceId = await firstWorkspaceId(app)
  const row = await addShellRow(workspaceId)
  await waitPrompt(row.paneId)
  const mark = Date.now()
  const confirmed = await closeRowByUi(row.tabId)
  // 그 탭이 herdr 에서 사라질 때까지 기다린 **뒤에** 대조한다.
  const herdrGone = await until(async () => !(await herdrTruth()).tabs.includes(row.tabId), {
    what: 'herdr 에서 사라짐',
    timeoutMs: 15000,
    everyMs: 40,
  })
  const converged = await until(async () => (await compare()).일치, { what: '수렴', timeoutMs: 10000, everyMs: 60 })
  const result = await compare()
  out.cases.a.push({
    round,
    ...row,
    확인모달: confirmed,
    게이트: { herdrGone: herdrGone.ok, converged: converged.ok },
    스냅샷재조회: snapshotsSince(mark),
    ...result,
  })
  console.log(`ⓐ#${round}`, result.일치 ? 'OK' : JSON.stringify(result.차이))
}

// ── ⓑ 마지막 pane 을 닫으면 탭도 사라져야 한다 (G2) ────────────────────────
for (let round = 1; round <= TIMES; round++) {
  const workspaceId = await firstWorkspaceId(app)
  const row = await addShellRow(workspaceId)
  await waitPrompt(row.paneId)
  const mark = Date.now()
  // **herdr 에 직접 건다** — corral UI 에는 pane 단위 종료가 없다 (이 일감 범위 밖).
  await request('pane.close', { pane_id: row.paneId })
  const herdrGone = await until(async () => !(await herdrTruth()).tabs.includes(row.tabId), {
    what: 'herdr 에서 사라짐',
    timeoutMs: 15000,
    everyMs: 40,
  })
  const converged = await until(async () => (await compare()).일치, { what: '수렴', timeoutMs: 10000, everyMs: 60 })
  const result = await compare()
  out.cases.b.push({ round, ...row, 게이트: { herdrGone: herdrGone.ok, converged: converged.ok }, 스냅샷재조회: snapshotsSince(mark), ...result })
  console.log(`ⓑ#${round}`, result.일치 ? 'OK' : JSON.stringify(result.차이))
}

// ── ⓒ 마지막 탭을 닫으면 workspace 행도 사라져야 한다 ─────────────────────
for (let round = 1; round <= TIMES; round++) {
  const stale = (await app.state()).workspaces.map((row) => row.workspaceId)
  await tidySession()
  // **새 workspace 를 기다린다.** 1회차에는 낡은 상태의 id 를 집어 이미 없는 탭에 종료를 걸었고,
  // 그 뒤 게이트가 조용히 타임아웃해 회차가 통째로 헛돌았다 (`until` 은 실패를 던지지 않는다).
  const fresh = await until(
    async () => {
      const rows = (await app.state()).workspaces.filter((row) => !stale.includes(row.workspaceId))
      const row = rows[0]
      return row !== undefined && row.tabs.length > 0 ? { workspaceId: row.workspaceId, tabId: row.tabs[0].tabId } : null
    },
    { what: '새 workspace 반영', timeoutMs: 15000, everyMs: 60 },
  )
  if (!fresh.ok) throw new Error('ⓒ 준비 실패 — 새 workspace 가 corral 에 안 왔다')
  const { workspaceId, tabId } = fresh.value
  const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null
  await waitPrompt(paneId)
  const mark = Date.now()
  const confirmed = await closeRowByUi(tabId)
  const herdrEmpty = await until(async () => !(await herdrTruth()).workspaces.includes(workspaceId), {
    what: 'herdr 에서 workspace 사라짐',
    timeoutMs: 15000,
    everyMs: 40,
  })
  // 그 순간 corral 도 그 행을 버렸나 — **이것이 ⓒ 가 묻는 것**이다.
  const corralEmpty = await until(
    async () => !(await app.state()).workspaces.some((row) => row.workspaceId === workspaceId),
    { what: 'corral 에서 workspace 사라짐', timeoutMs: 15000, everyMs: 40 },
  )
  const converged = await until(async () => (await compare()).일치, { what: '수렴', timeoutMs: 10000, everyMs: 60 })
  const result = await compare()
  out.cases.c.push({
    round,
    workspaceId,
    tabId,
    확인모달: confirmed,
    herdr에서사라짐: herdrEmpty.ok,
    corral에서사라짐: corralEmpty.ok,
    corral반영ms: corralEmpty.ms,
    수렴: converged.ok,
    스냅샷재조회: snapshotsSince(mark),
    ...result,
  })
  console.log(`ⓒ#${round}`, corralEmpty.ok && result.일치 ? 'OK' : JSON.stringify(result.차이), 'ws', result.corral.workspaces.length)
}

const roll = (rows) => ({
  회차: rows.length,
  불일치: rows.filter((item) => !item.일치).length,
  게이트실패: rows.filter(
    (item) => item.corral에서사라짐 === false || item.게이트?.herdrGone === false || item.게이트?.converged === false,
  ).length,
  스냅샷재조회합: rows.reduce((sum, item) => sum + item.스냅샷재조회, 0),
})
out.요약 = {
  'ⓐ tab.close 뒤 pane 잔재': roll(out.cases.a),
  'ⓑ 마지막 pane 종료 뒤 유령 탭': roll(out.cases.b),
  'ⓒ 마지막 탭 종료 뒤 workspace': roll(out.cases.c),
}
console.log(JSON.stringify(out.요약, null, 2))

// 이벤트 경로가 실제로 무엇을 했는지 — 적용 note 를 그대로 싣는다 (G1·G2 의 지문).
out.이벤트적용 = app
  .entries()
  .filter((entry) => entry.tag === 'push.applied' && ['tab_closed', 'pane_closed', 'workspace_closed'].includes(entry.event))
  .map((entry) => ({ at: entry.at, event: entry.event, changed: entry.changed, note: entry.note }))

writeRaw('n7-list-consistency.json', out)
await sleep(200)
await app.stop()
await tidySession()
