// L6 · L7 · L8 — 상태 live 갱신 · Orca 정보 배치(경과) · N agents 묶기.
//
// 셋을 한 번에 재는 이유: 셋 다 "에이전트가 실제로 붙은 화면"이 있어야 근거가 된다.
// 봉투·경로는 `m-agent.mjs` 가 먼저 재 뒀다 (36-agent-status-and-revision.json):
//   - `pane.agent_status_changed` 는 **pane_id 가 required** 라 pane 마다 구독해야 한다
//   - 그 이벤트만 `event` 이름이 점을 유지한다 (`pane.agent_status_changed`)
//   - `pane.updated` 의 `revision` 은 **순수 출력만으로도 움직인다** → 경과의 근거
//
// 격리: life344-probe 에서만. 에이전트도 거기서 띄우고 끝나면 끈다.

import { SESSION, request, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

socketPath() // 격리 가드
const AGENT_CMD = process.env.L344_AGENT_CMD ?? 'claude --dangerously-skip-permissions'
const PROMPT = process.env.L344_AGENT_PROMPT ?? 'reply with exactly: pong'

await tidySession()
// **새 workspace 에서 잰다.** 앞 회차의 에이전트가 남은 pane 에서 재면 `unknown` 에서 시작하지
// 못하고, 그러면 "붙는 순간"을 못 본다 (실제로 그렇게 한 번 헛돌았다).
const made = await request('workspace.create')
const workspaceId = made.result?.workspace?.workspace_id
if (!workspaceId) throw new Error('workspace 를 못 만들었다')
// L8 을 재려면 한 worktree 에 세션이 여럿이어야 한다.
await request('tab.create', { workspace_id: workspaceId, label: 'second' })
await sleep(1200)

const app = await startApp({ name: 'l678' })
await sleep(1500)

const snapshot = (await request('session.snapshot')).result.snapshot
const target = snapshot.panes.find((pane) => pane.workspace_id === workspaceId) ?? snapshot.panes[0]

// --- L6 ① 붙기 전 화면 ---------------------------------------------------
const before = await app.state()
await app.shot('l6-1-before-agent')

// --- L6 ② 에이전트를 실제로 띄운다 --------------------------------------
const startedAt = Date.now()
await request('pane.send_text', { pane_id: target.pane_id, text: `${AGENT_CMD}\n` })
const detected = await waitState(app, target.pane_id, (pane) => pane.agent !== null, 120000)
await app.shot('l6-2-agent-idle')
const idleShot = await app.state()

// 프롬프트는 **에이전트가 준비됐다고 말한 뒤에** 넣는다. 기동 중에 넣으면 로딩 화면으로 들어가
// working 에서 안 나온다 (한 회차가 그렇게 헛돌았다).
const readyAt = await waitState(app, target.pane_id, (pane) => pane.agentStatus === 'idle', 120000)
await sleep(1500)
await request('pane.send_text', { pane_id: target.pane_id, text: PROMPT })
await sleep(900)
await request('pane.send_keys', { pane_id: target.pane_id, keys: ['Enter'] }).catch(() => {})
const working = await waitState(app, target.pane_id, (pane) => pane.agentStatus === 'working', 90000)
if (working !== null) await app.shot('l6-3-agent-working')
const workingShot = working === null ? null : await app.state()
// **실측 정정**: 일이 끝난 뒤 herdr 가 주는 상태는 `idle` 이 아니라 `done` 이다
// (AgentStatus enum 에 둘 다 있다). 기준서 문구는 `unknown → working → idle` 이라고 썼지만
// 실제 열은 `unknown → idle(준비) → working → done` 이었다. 둘 다 "일이 끝났다"로 받는다.
const settled =
  working === null
    ? null
    : await waitState(app, target.pane_id, (pane) => pane.agentStatus === 'done' || pane.agentStatus === 'idle', 120000)
if (settled !== null) await app.shot('l6-4-agent-settled')
const settledShot = settled === null ? null : await app.state()

// --- L8 접기 / 펴기 ------------------------------------------------------
const expanded = await treeProbe(app)
await app.shot('l8-1-expanded')
await app.toggleCollapse(workspaceId)
await sleep(700)
const collapsed = await treeProbe(app)
await app.shot('l8-2-collapsed')
await app.toggleCollapse(workspaceId)
await sleep(700)
const reexpanded = await treeProbe(app)

// --- 정리: 에이전트를 끈다 ------------------------------------------------
await request('pane.send_keys', { pane_id: target.pane_id, keys: ['C-c'] }).catch(() => {})
await sleep(800)
await request('pane.send_keys', { pane_id: target.pane_id, keys: ['C-c'] }).catch(() => {})
await sleep(1500)

const entries = app.entries()
const statusPushes = entries.filter((entry) => entry.tag === 'agent.push.applied')
const agentSubs = entries.filter((entry) => entry.tag.startsWith('agent.sub'))
const paneOf = (state) => state.state.workspaces.flatMap((row) => row.panes).find((pane) => pane.paneId === target.pane_id) ?? null

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  targetPane: target.pane_id,
  targetWorkspace: workspaceId,
  agentCommand: AGENT_CMD,
  L6: {
    question: '상태·정체가 화면에서 실제로 바뀌는가 (unknown → working → idle) + 어느 AI 인지',
    subscriptionLog: agentSubs.map((entry) => ({ tag: entry.tag, panes: entry.panes ?? null, error: entry.error ?? null })),
    statusPushes: statusPushes.map((entry) => ({ ts: entry.ts, event: entry.event, note: entry.note })),
    beforeAgent: paneOf(before),
    onDetected: paneOf(idleShot),
    onWorking: workingShot === null ? null : paneOf(workingShot),
    timeline: {
      agentDetectedMs: detected === null ? null : detected - startedAt,
      readyIdleMs: readyAt === null ? null : readyAt - startedAt,
      workingMs: working === null ? null : working - startedAt,
      settledMs: settled === null ? null : settled - startedAt,
    },
    sawWorking: working !== null,
    sawSettled: settled !== null,
    settledStatus: settledShot === null ? null : (paneOf(settledShot)?.agentStatus ?? null),
    observedSequence: statusPushes.map((entry) => entry.note),
    agentNameShown: paneOf(idleShot)?.agent ?? null,
    shots: [
      'shots/l6-1-before-agent.png',
      'shots/l6-2-agent-idle.png',
      'shots/l6-3-agent-working.png',
      'shots/l6-4-agent-settled.png',
    ],
  },
  L7: {
    question: 'Orca 의 행 배치 — 상태 점 · 에이전트 · 제목 · 우측 경과. 경과를 실제로 쓸 수 있는가',
    basis: 'pane.updated 의 revision 이 움직인 시각을 corral 이 찍는다 (36-agent-status-and-revision.json)',
    rowsWithElapsedAtEnd: Number(expanded?.rowsWithElapsed ?? -1),
    tabRowsAtEnd: Number(expanded?.tabRows ?? -1),
    agentsShown: expanded?.agentsShown ?? '',
    changedAtSeen: paneOf(idleShot)?.changedAt ?? null,
    caveat:
      'herdr 는 출력마다 pane.updated 를 주지 않는다 — 실측에서 echo 5줄에 2건이었다. 그래서 이 값은 ' +
      '"마지막 출력 시각"의 근사이고, 스냅샷으로 처음 안 pane 은 null 이라 화면에 아무것도 안 쓴다.',
  },
  L8: {
    question: 'worktree 에 세션이 여럿이면 N agents 로 묶어 접을 수 있는가',
    expanded: { tabRows: Number(expanded?.tabRows ?? -1), hiddenTabRows: Number(expanded?.hiddenTabRows ?? -1) },
    collapsed: { tabRows: Number(collapsed?.tabRows ?? -1), hiddenTabRows: Number(collapsed?.hiddenTabRows ?? -1) },
    reexpanded: { tabRows: Number(reexpanded?.tabRows ?? -1) },
    shots: ['shots/l8-1-expanded.png', 'shots/l8-2-collapsed.png'],
  },
}

// 통과선은 "화면에서 바뀌는 것" 이다 — 붙기 전이 정말 비어 있었는지까지 본다.
result.L6.startedClean = result.L6.beforeAgent?.agent === null && result.L6.beforeAgent?.agentStatus === 'unknown'
result.L6.pass =
  result.L6.startedClean && result.L6.sawWorking && result.L6.sawSettled && result.L6.agentNameShown !== null
result.L7.pass = result.L7.rowsWithElapsedAtEnd > 0
// 접으면 **그 workspace 의 탭 줄만** 사라진다 — 다른 worktree 의 줄까지 사라지면 그건 버그다.
result.L8.hiddenByCollapse = result.L8.expanded.tabRows - result.L8.collapsed.tabRows
result.L8.pass =
  result.L8.hiddenByCollapse === result.L8.collapsed.hiddenTabRows &&
  result.L8.hiddenByCollapse > 0 &&
  result.L8.reexpanded.tabRows === result.L8.expanded.tabRows
result.L6.conclusion = result.L6.pass
  ? `에이전트를 띄우자 ${result.L6.timeline.agentDetectedMs}ms 에 정체(${result.L6.agentNameShown})가 붙고, ` +
    `${result.L6.timeline.readyIdleMs}ms 에 idle(준비), 프롬프트 뒤 ${result.L6.timeline.workingMs}ms 에 working, ` +
    `${result.L6.timeline.settledMs}ms 에 ${result.L6.settledStatus} 로 화면이 바뀌었다. ` +
    '기준서 문구의 "→ idle" 은 실제로 **done** 이다 (AgentStatus 에 둘 다 있다).'
  : result.L6.startedClean === false
    ? '붙기 전 상태가 이미 unknown 이 아니었다 — 이 회차로는 "붙는 순간"을 판정할 수 없다(보류).'
    : '전이를 다 못 봤다 — 결과 문서에 보류로 적을 것.'
result.L7.conclusion = result.L7.pass
  ? `탭 ${result.L7.tabRowsAtEnd}줄 중 ${result.L7.rowsWithElapsedAtEnd}줄이 경과를 쓴다. 나머지는 언제 바뀐지 몰라 비운다.`
  : '경과를 쓴 줄이 없다 — 보류.'
result.L8.conclusion = result.L8.pass
  ? `접으면 그 worktree 의 탭 ${result.L8.hiddenByCollapse}줄이 화면에서 빠지고(전체 ${result.L8.expanded.tabRows} → ${result.L8.collapsed.tabRows}), ` +
    `다시 펴면 ${result.L8.reexpanded.tabRows} 로 돌아온다. 다른 worktree 의 줄은 그대로다.`
  : '접힘이 화면에 반영되지 않았다 — 보류.'

writeRaw('37-l6-l7-l8.json', result)
console.log(
  JSON.stringify(
    {
      L6: {
        pass: result.L6.pass,
        startedClean: result.L6.startedClean,
        agent: result.L6.agentNameShown,
        before: result.L6.beforeAgent?.agentStatus,
        timeline: result.L6.timeline,
        settledStatus: result.L6.settledStatus,
        sequence: result.L6.observedSequence,
      },
      L7: { pass: result.L7.pass, rowsWithElapsed: result.L7.rowsWithElapsedAtEnd, tabRows: result.L7.tabRowsAtEnd },
      L8: {
        pass: result.L8.pass,
        expanded: result.L8.expanded.tabRows,
        collapsed: result.L8.collapsed.tabRows,
        hidden: result.L8.hiddenByCollapse,
      },
    },
    null,
    2,
  ),
)

await app.stop()
// 만든 workspace 를 닫으면 그 안 pane(에이전트 포함)이 함께 끝난다.
await request('workspace.close', { workspace_id: workspaceId }).catch(() => {})
await sleep(800)
await tidySession()

async function treeProbe(handle) {
  return handle.entries().filter((entry) => entry.tag === 'renderer.probe' && entry.name === 'tree').pop() ?? null
}

/** 앱의 **상태**(화면이 받는 것)가 조건을 만족할 때까지 기다린다. 로그가 아니라 상태를 본다. */
async function waitState(handle, paneId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await handle.state()
    const pane = state.state.workspaces.flatMap((row) => row.panes).find((item) => item.paneId === paneId)
    if (pane && predicate(pane)) return Date.now()
    await sleep(300)
  }
  return null
}
