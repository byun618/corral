// L1~L5 측정 — 세션 발견 · workspace 목록 · 구독 실시간 반영 · 선택 · 터미널 자리.
//
// 유발(하네스가 workspace.create/close) ↔ 반영(앱이 실제로 그린 ui.rendered)을 workspace_id 로 짝짓는다.
// 순서가 아니라 id 로 짝짓는 이유: 순서로 맞추면 우연히 맞은 것과 구분되지 않는다.

import { control, readLog, request, sleep, startApp, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'l' })
if (!app.entries().some((e) => e.tag === 'link.phase' && e.phase === 'live')) {
  throw new Error('앱이 live 에 도달하지 못했다')
}

const summary = { session: process.env.LIFE344_SESSION ?? 'life344-probe', pairs: [], shots: [] }

// --- L1 / L2 / L5 : 화면 근거 -------------------------------------------
const before = await app.state()
summary.stateAtStart = before.state
summary.shots.push((await app.shot('l1-l2-l5-list')).file)

// --- L3 : 5회 생성 + 5회 종료, 10/10 이 목록에 반영되는가 ----------------
const created = []
for (let i = 1; i <= 5; i++) {
  const triggeredAt = Date.now()
  const response = await request('workspace.create')
  const workspaceId = response.result?.workspace?.workspace_id
  if (!workspaceId) throw new Error(`workspace.create 실패: ${JSON.stringify(response)}`)
  const reflected = await waitReflect(app, workspaceId, true, triggeredAt)
  created.push(workspaceId)
  summary.pairs.push({ kind: 'create', workspaceId, triggeredAt, ...reflected })
  await sleep(250)
}

for (const workspaceId of created) {
  const triggeredAt = Date.now()
  const response = await request('workspace.close', { workspace_id: workspaceId })
  if (response.error) throw new Error(`workspace.close 실패: ${JSON.stringify(response.error)}`)
  const reflected = await waitReflect(app, workspaceId, false, triggeredAt)
  summary.pairs.push({ kind: 'close', workspaceId, triggeredAt, ...reflected })
  await sleep(250)
}

// --- L4 : 선택 유지 + 선택 대상이 사라져도 안 깨진다 ---------------------
const victimTriggered = Date.now()
const victim = await request('workspace.create')
const victimId = victim.result?.workspace?.workspace_id
await waitReflect(app, victimId, true, victimTriggered)
await app.selectWorkspace(victimId)
await sleep(400)
summary.shots.push((await app.shot('l4-selected')).file)
const selectedState = await app.state()
summary.l4 = { victimId, selectedBefore: selectedState.state.selectedWorkspaceId }

const killTriggered = Date.now()
await request('workspace.close', { workspace_id: victimId })
await waitReflect(app, victimId, false, killTriggered)
await sleep(600)
summary.shots.push((await app.shot('l4-after-victim-closed')).file)
const afterState = await app.state()
summary.l4.selectedAfter = afterState.state.selectedWorkspaceId
summary.l4.appAlive = afterState.ok === true
summary.l4.workspacesAfter = afterState.state.workspaces.map((row) => row.workspaceId)

// --- 판정용 집계 ---------------------------------------------------------
const lags = summary.pairs.map((pair) => pair.renderedAt - pair.triggeredAt)
summary.result = {
  pairs: summary.pairs.length,
  missed: summary.pairs.filter((pair) => pair.renderedAt === null).length,
  maxLagMs: Math.max(...lags),
  minLagMs: Math.min(...lags),
  allUnderTwoSeconds: lags.every((lag) => lag < 2000),
  // push 로 왔다는 증거: 반영 직전에 같은 workspace 를 주체로 하는 push.applied 가 있다
  allViaPush: summary.pairs.every((pair) => pair.pushAppliedAt !== null),
  sessionPollsDuringWindow: readLog(app.logPath).filter((entry) => entry.tag === 'sessions.poll').length,
}

writeRaw('30-l3-pairs.json', summary)
console.log(JSON.stringify(summary.result, null, 2))

await control(app.controlSocket, { cmd: 'shot', name: 'l-final' })
await app.stop()

/** state.emit(그 workspace 가 목록에 있음/없음) → 그 revision 이상을 그린 ui.rendered 를 찾는다. */
async function waitReflect(app, workspaceId, shouldExist, triggeredAt, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entries = app.entries()
    const push = entries.find(
      (entry) => entry.tag === 'push.applied' && entry.subject === workspaceId && entry.at >= triggeredAt,
    )
    const emit = entries.find(
      (entry) =>
        entry.tag === 'state.emit' &&
        entry.at >= triggeredAt &&
        entry.workspaces.some((row) => row.startsWith(`${workspaceId}:`)) === shouldExist,
    )
    if (emit) {
      const rendered = entries.find(
        (entry) => entry.tag === 'ui.rendered' && entry.revision >= emit.revision && entry.at >= emit.at,
      )
      if (rendered) {
        return {
          pushAppliedAt: push ? push.at : null,
          pushEvent: push ? push.event : null,
          emitAt: emit.at,
          emitRevision: emit.revision,
          renderedAt: rendered.at,
        }
      }
    }
    if (Date.now() > deadline) {
      return { pushAppliedAt: push ? push.at : null, pushEvent: null, emitAt: null, emitRevision: null, renderedAt: null }
    }
    await sleep(40)
  }
}
