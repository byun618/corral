// LIFE-430 C3a·C3b·C3c — 격리 재현 장치.
//
// 네이티브 관문은 이 경합을 결정적으로 만들 수 없다. 끼어드는 쓰기의 시점은 pane 의 모델이 TASK 를
// 언제 실행하느냐에 달려 있고, 그래서 LIFE-426 에서 5회 중 2회만 실패했다. 2/5 짜리 신호로 수정을
// 판정하면 3회 연속 통과가 우연일 확률이 22% 다 (00-analysis §6). 기제 증명은 여기서 한다.
//
// 이 장치는 제품 경로로 문서를 만들지 않고 **직접 쓴다** (01-criteria C3a 가 허용하는 두 방식 중
// 하나다). 그 대신 끼워 넣는 쓰기는 제품이 실제로 하는 것과 같은 모양이어야 하므로,
// `orchestration/index.ts` 의 send-heartbeat 경로가 하는 세 가지를 그대로 한다 — 메시지를 덧붙이고,
// `worker.lastHeartbeatAt` 을 그 메시지의 시각으로 옮기고, `updatedAt` 을 같은 값으로 두면서
// `version` 을 1 올린다. `ask` 는 메시지만 덧붙인다.
//
// 재는 것은 두 비교다. **수정 전** = `state.json` 전체 바이트의 sha256 (지금 관문이 쓰는 것),
// **수정 후** = `state-delta.mjs` 의 키 단위 판정. 같은 입력에 둘을 나란히 돌린다.
//
//   ① 양성 대조 (C3a): 두 관측 사이에 worker 메시지 쓰기를 끼워 넣으면 **수정 전** 비교가 실패한다
//   ② 수정 후 (C3b): 같은 입력에서 **수정 후** 비교가 통과한다. 장치를 연속 20회
//   ③ 음성 대조 (C3c): 거절이 실제로 기록을 남기는 다섯 가지 — Task 를 건드림 / Dispatch 를 건드림 /
//      새 Dispatch / 새 delivery / coordinator 가 쓴 메시지 — 에서 **수정 후** 비교가 실패한다.
//      더해 pane 이 `worker_done` 을 남기는 경우도 본다 (관문의 두 번째 사용처)
//
// 사용법: node app/scripts/l430/refusal-race.mjs [반복횟수]   (기본 20)
// 출력: 한 줄 JSON 요약. 하나라도 어긋나면 종료코드 1.
import assert from 'node:assert/strict'
import { refusalDelta, describeDelta, snapshot } from './state-delta.mjs'

const rounds = Number(process.argv[2] ?? 20)
const iso = ms => new Date(ms).toISOString()

/** 관문이 F1(a) 를 재는 그 순간의 문서와 같은 모양. 값은 고정이라 회차마다 같은 입력이 된다. */
function baseline(seed) {
  const runId = 'run_0000000000aa', taskId = 'task_0000000000bb', dispatchId = 'ctx_0000000000cc'
  const at = iso(1_800_000_000_000 + seed)
  const paneId = 'pane-1'
  return {
    dispatchId,
    state: {
      schemaVersion: 1, currentRunId: runId,
      runs: [{ id: runId, objective: 'l430 device', createdAt: at, updatedAt: at, version: 1 }],
      tasks: [{ id: taskId, runId, spec: 'body', title: null, deps: [], currentDispatchId: dispatchId,
        attempts: 1, status: 'dispatched', result: null, settledAt: null, createdAt: at, updatedAt: at, version: 2 }],
      dispatches: [{ id: dispatchId, runId, taskId, attempt: 1,
        target: { handle: 't1.device', runtimeId: 'runtime', epoch: 'epoch', ptyId: 'pty', paneId },
        agent: { kind: 'claude', requestedModel: 'sonnet', resolvedModel: 'sonnet' }, agentAbsenceReason: null, reconcile: null,
        worker: { launch: 'created', ownership: 'owned', originDispatchId: null, ownershipTransferredTo: null,
          paneSession: 'session-one', preambleSha256: 'a'.repeat(64), lead: { requestId: 'r1.1.lead', at }, prompt: { requestId: 'r1.1.body', at },
          promptRequestId: 'r1.1.body', lastHeartbeatAt: null, capabilityRevokedAt: null, capabilityRevokedReason: null, retain: null, release: null },
        status: 'dispatched', settledBy: null, settledAt: null, createdAt: at, updatedAt: at, version: 3 }],
      messages: [{ id: 'msg_00000000000a', runId, taskId, dispatchId: null, type: 'status', subject: 'seeded', body: '',
        payload: {}, sequence: 1, createdAt: at, from: { kind: 'coordinator', dispatchId: null, paneId: null },
        deliveredIn: null, acknowledgedAt: null, outcome: null, question: null, replyTo: null }],
      deliveries: [],
    },
  }
}
const clone = value => JSON.parse(JSON.stringify(value))
const nextSequence = state => state.messages.reduce((high, entry) => Math.max(high, entry.sequence), 0) + 1

/** `appendMessage` 가 만드는 행. */
const message = (state, { id, type, at, from, dispatchId, taskId, extra = {} }) => ({
  id, runId: state.currentRunId, taskId: taskId ?? null, dispatchId: dispatchId ?? null, type,
  subject: type, body: 'x', payload: {}, sequence: nextSequence(state), createdAt: at, from,
  deliveredIn: null, acknowledgedAt: null, outcome: null, question: null, replyTo: null, ...extra,
})

/** `send --type heartbeat` 가 worker 자격으로 할 때 제품이 하는 것 전부 (index.ts send-heartbeat). */
function paneHeartbeat(state, dispatchId, at) {
  const next = clone(state)
  const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
  next.messages.push(message(next, { id: 'msg_0000000000b1', type: 'heartbeat', at, dispatchId,
    taskId: dispatch.taskId, from: { kind: 'worker', dispatchId, paneId: dispatch.target.paneId } }))
  dispatch.worker.lastHeartbeatAt = at
  dispatch.updatedAt = at
  dispatch.version += 1
  return next
}
/** `ask` 가 worker 자격으로 할 때: 메시지만 덧붙는다. */
function paneQuestion(state, dispatchId, at) {
  const next = clone(state)
  const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
  next.messages.push(message(next, { id: 'msg_0000000000b2', type: 'question', at, dispatchId,
    taskId: dispatch.taskId, from: { kind: 'worker', dispatchId, paneId: dispatch.target.paneId },
    extra: { question: { options: [], answeredBy: null, answeredAt: null } } }))
  return next
}

// --- 거절이 실제로 기록을 남기는 경우들 (C3c 음성 대조) ---------------------------------------------
const LEAKS = [
  { name: 'task-record-touched', apply: (state, dispatchId, at) => {
    const next = clone(state); const task = next.tasks.find(entry => entry.id === next.dispatches.find(d => d.id === dispatchId).taskId)
    task.attempts += 1; task.updatedAt = at; task.version += 1; return next } },
  { name: 'dispatch-record-touched', apply: (state, dispatchId, at) => {
    const next = clone(state); const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
    dispatch.worker.promptRequestId = 'r1.2.refused'; dispatch.updatedAt = at; dispatch.version += 1; return next } },
  { name: 'second-dispatch-appended', apply: (state, dispatchId, at) => {
    const next = clone(state); const open = next.dispatches.find(entry => entry.id === dispatchId)
    next.dispatches.push({ ...clone(open), id: 'ctx_0000000000dd', attempt: 2, createdAt: at, updatedAt: at, version: 1 }); return next } },
  { name: 'delivery-record-created', apply: (state, dispatchId, at) => {
    const next = clone(state)
    next.deliveries.push({ id: 'delivery_00000000aa', runId: next.currentRunId, messageIds: [], openedAt: at, acknowledgedAt: null }); return next } },
  { name: 'coordinator-message-stored', apply: (state, dispatchId, at) => {
    const next = clone(state)
    next.messages.push(message(next, { id: 'msg_0000000000c1', type: 'status', at, dispatchId,
      from: { kind: 'coordinator', dispatchId: null, paneId: null } })); return next } },
  // --- r2 지적 A: 거절이 제 재관측을 문서에 남기는 회귀 --------------------------------------------
  // 제품 `index.ts:663` 의 `if (pass.changed && !mutating)` 를 `if (pass.changed)` 로 바꾸면 거절된
  // 호출이 이 모양을 남긴다. r1 의 비교는 이것을 `clean` 으로 읽었다.
  { name: 'refusal-persisted-its-reconcile', apply: (state, dispatchId, at) => {
    const next = clone(state); const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
    dispatch.reconcile = { at, runtimeInstanceId: 'instance', observed: true, reason: 'pane_live' }
    dispatch.updatedAt = at; dispatch.version += 1; return next } },
  { name: 'refusal-persisted-an-unobserved-reconcile', apply: (state, dispatchId, at) => {
    const next = clone(state); const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
    dispatch.reconcile = { at, runtimeInstanceId: 'instance', observed: false, reason: 'observation_failed' }
    dispatch.updatedAt = at; dispatch.version += 1; return next } },
  // --- r2 지적 B: 설명된 쓰기 수와 무관한 파생 칸 이동 ----------------------------------------------
  { name: 'version-bumped-by-one-more', apply: (state, dispatchId) => {
    const next = clone(state); next.dispatches.find(entry => entry.id === dispatchId).version += 1; return next } },
  { name: 'version-bumped-by-fifty', apply: (state, dispatchId) => {
    const next = clone(state); next.dispatches.find(entry => entry.id === dispatchId).version += 50; return next } },
  { name: 'updatedAt-pushed-into-the-future', apply: (state, dispatchId) => {
    const next = clone(state); next.dispatches.find(entry => entry.id === dispatchId).updatedAt = '2030-03-17T17:46:40.000Z'; return next } },
  // Grok 의 `heartbeat-message-without-side-effects`: 메시지는 덧붙었는데 worker 블록이 따라가지 않는다.
  { name: 'heartbeat-message-without-its-side-effects', apply: (state, dispatchId, at) => {
    const next = clone(state); const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
    next.messages.push(message(next, { id: 'msg_0000000000d1', type: 'heartbeat', at, dispatchId,
      taskId: dispatch.taskId, from: { kind: 'worker', dispatchId, paneId: dispatch.target.paneId } }))
    return next } },
  { name: 'heartbeat-whose-timestamp-does-not-match-the-worker-block', apply: (state, dispatchId, at) => {
    const next = clone(state); const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
    next.messages.push(message(next, { id: 'msg_0000000000d2', type: 'heartbeat', at, dispatchId,
      taskId: dispatch.taskId, from: { kind: 'worker', dispatchId, paneId: dispatch.target.paneId } }))
    dispatch.worker.lastHeartbeatAt = '2029-01-01T00:00:00.000Z'
    dispatch.updatedAt = '2029-01-01T00:00:00.000Z'; dispatch.version += 1; return next } },
  // 관문의 두 번째 사용처(정산된 워커가 다시 보고할 수 없다)에서 막아야 하는 쓰기.
  { name: 'settled-pane-reports-again', apply: (state, dispatchId, at) => {
    const next = clone(state); const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
    next.messages.push(message(next, { id: 'msg_0000000000c2', type: 'worker_done', at, dispatchId,
      taskId: dispatch.taskId, from: { kind: 'worker', dispatchId, paneId: dispatch.target.paneId },
      extra: { outcome: 'succeeded' } })); return next } },
]

const bytes = state => Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8')
const results = { rounds, oldComparisonFailed: 0, newComparisonClean: 0, negatives: {}, firstExplanation: null }
let failures = []

for (let round = 0; round < rounds; round++) {
  const { state, dispatchId } = baseline(round)
  const before = snapshot(bytes(state))
  // 두 관측 사이에 pane 이 TASK 1·2단계를 실행한다 — 결정적으로, 매 회차 같은 자리에서.
  const at = iso(1_800_000_000_000 + round + 5)
  const raced = paneQuestion(paneHeartbeat(state, dispatchId, at), dispatchId, iso(1_800_000_000_000 + round + 6))
  const after = snapshot(bytes(raced))

  // ① 양성 대조: 수정 전 비교(전체 바이트 digest)는 여기서 실패해야 한다.
  if (before.digest !== after.digest) results.oldComparisonFailed += 1
  else failures.push({ round, what: 'the byte digest did not move — the device injected nothing' })

  // ② 수정 후 비교는 통과해야 한다.
  const delta = refusalDelta(before.state, after.state, { dispatchId })
  if (delta.clean) results.newComparisonClean += 1
  else failures.push({ round, what: 'the key-level comparison called an explainable write unexplained', detail: describeDelta(delta, before.state, after.state).unexplained })
  if (round === 0) results.firstExplanation = describeDelta(delta, before.state, after.state)

  // ③ 음성 대조: 거절이 무언가를 남기면, 같은 동시 쓰기가 있어도 실패해야 한다.
  for (const leak of LEAKS) {
    const leaked = snapshot(bytes(leak.apply(raced, dispatchId, iso(1_800_000_000_000 + round + 7))))
    const verdict = refusalDelta(before.state, leaked.state, { dispatchId })
    results.negatives[leak.name] ??= { caught: 0, missed: 0, firstKeys: null }
    if (verdict.clean) { results.negatives[leak.name].missed += 1; failures.push({ round, what: `leak ${leak.name} was not caught` }) }
    else {
      results.negatives[leak.name].caught += 1
      results.negatives[leak.name].firstKeys ??= describeDelta(verdict, before.state, leaked.state).unexplained
    }
  }
}

// --- 조용한 창: 동시 쓰기가 하나도 없을 때 -------------------------------------------------------
// 설명할 것이 없으면 `updatedAt`·`version` 도 움직일 수 없다. 파생 칸의 허용이 "언제나" 가 아니라
// "설명된 실질 변경 뒤에만" 이라는 것을 여기서 잰다.
results.quietWindow = { unchangedIsClean: 0, bareVersionBumpCaught: 0, leaksCaught: 0, leaksMissed: 0 }
for (let round = 0; round < rounds; round++) {
  const { state, dispatchId } = baseline(round)
  const before = snapshot(bytes(state))
  const at = iso(1_800_000_000_000 + round + 9)
  if (refusalDelta(before.state, snapshot(bytes(clone(state))).state, { dispatchId }).clean) results.quietWindow.unchangedIsClean += 1
  else failures.push({ round, what: 'an untouched document was called unclean' })
  const bumped = clone(state)
  const dispatch = bumped.dispatches.find(entry => entry.id === dispatchId)
  dispatch.updatedAt = at; dispatch.version += 1
  if (!refusalDelta(before.state, snapshot(bytes(bumped)).state, { dispatchId }).clean) results.quietWindow.bareVersionBumpCaught += 1
  else failures.push({ round, what: 'a bare version bump with nothing to explain it was called clean' })
  for (const leak of LEAKS) {
    if (!refusalDelta(before.state, snapshot(bytes(leak.apply(state, dispatchId, at))).state, { dispatchId }).clean) results.quietWindow.leaksCaught += 1
    else { results.quietWindow.leaksMissed += 1; failures.push({ round, what: `quiet-window leak ${leak.name} was not caught` }) }
  }
}

results.ok = failures.length === 0
  && results.quietWindow.unchangedIsClean === rounds && results.quietWindow.bareVersionBumpCaught === rounds
  && results.quietWindow.leaksMissed === 0
  && results.oldComparisonFailed === rounds && results.newComparisonClean === rounds
  && LEAKS.every(leak => results.negatives[leak.name].caught === rounds && results.negatives[leak.name].missed === 0)
results.failures = failures.slice(0, 10)
console.log(JSON.stringify(results, null, 2))
assert.ok(results.ok, 'the isolated device did not hold')
