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
import { refusalDelta, describeDelta, snapshot, unobservedOpenAttempts } from './state-delta.mjs'

const rounds = Number(process.argv[2] ?? 20)
const iso = ms => new Date(ms).toISOString()

/**
 * 관문이 F1(a) 를 재는 그 순간의 문서와 같은 모양. 값은 고정이라 회차마다 같은 입력이 된다.
 *
 * `primed` 는 **창을 열기 전 전제**다 (r2 지적 H): 열린 attempt 의 재관측 기록이 서 있는 상태.
 * 관문은 창을 열기 전에 이 도장을 능동적으로 찍는다(`native.mjs` 의 `primeReconcile`). 기본값이
 * `true` 인 이유가 그것이다 — 이 장치의 기본 입력은 **관문이 실제로 여는 창**이어야 한다.
 * `second` 는 같은 pane 에 열려 있는 **다른** attempt 를 하나 더 둔다 (L-a).
 */
function baseline(seed, { primed = true } = {}) {
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
        agent: { kind: 'claude', requestedModel: 'sonnet', resolvedModel: 'sonnet' }, agentAbsenceReason: null,
        reconcile: primed ? { at, runtimeInstanceId: 'instance', observed: true, reason: 'pane_live' } : null,
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

/** 같은 pane 에 열려 있는 **다른** attempt 를 하나 더 붙인다 (L-a). 그 쪽 도장 여부는 따로 준다. */
function withSecondAttempt(shape, { primed }) {
  const next = clone(shape.state)
  const open = next.dispatches[0]
  next.dispatches.push({ ...clone(open), id: 'ctx_0000000000ee', attempt: 2, taskId: open.taskId,
    target: { ...open.target, handle: 't2.device' },
    reconcile: primed ? { at: open.createdAt, runtimeInstanceId: 'instance', observed: true, reason: 'pane_live' } : null,
    version: 1 })
  return { ...shape, state: next, secondId: 'ctx_0000000000ee' }
}
const clone = value => JSON.parse(JSON.stringify(value))
const nextSequence = state => state.messages.reduce((high, entry) => Math.max(high, entry.sequence), 0) + 1

/** `appendMessage` 가 만드는 행. */
const message = (state, { id, type, at, from, dispatchId, taskId, extra = {} }) => ({
  id, runId: state.currentRunId, taskId: taskId ?? null, dispatchId: dispatchId ?? null, type,
  subject: type, body: 'x', payload: {}, sequence: nextSequence(state), createdAt: at, from,
  deliveredIn: null, acknowledgedAt: null, outcome: null, question: null, replyTo: null, ...extra,
})

/**
 * `send --type heartbeat` 가 worker 자격으로 할 때 제품이 하는 것 전부 (index.ts send-heartbeat).
 *
 * 그리고 **하나 더** (r2 지적 H): 제품은 모든 명령 앞에 재관측 훑기를 돌리고, 변이 명령은 그 결과를
 * 자기 쓰기에 실어 보낸다(`index.ts:651-663`). 그래서 도장이 아직 없는 열린 attempt 가 있으면
 * heartbeat 한 번이 **도장 + 자기 갱신**을 함께 저장하고 `version` 은 +2 가 된다 — Codex 의
 * `product-baseline-summary.json` 두 번째 경우가 정확히 `versionDelta: 2` 다. 이 장치가 그 모양을
 * 흉내내지 않으면 H 를 잠글 수 없다.
 */
function paneHeartbeat(state, dispatchId, at) {
  const next = clone(state)
  const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
  for (const entry of next.dispatches) {
    if (entry.status !== 'dispatched' || entry.reconcile?.observed === true) continue
    entry.reconcile = { at, runtimeInstanceId: 'instance', observed: true, reason: 'pane_live' }
    entry.updatedAt = at
    entry.version += 1
  }
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
  // --- r2 지적 L-b: 요구값이 없는 종류(status·question·escalation)를 위조해도, **그 옆에서** 파생 칸이
  // 움직이면 걸린다. 위조 자체를 가려내지는 못한다 — 그것이 state-delta.mjs 머리말의 한계 문장이다.
  { name: 'status-message-beside-an-unexplained-version-bump', apply: (state, dispatchId, at) => {
    const next = clone(state); const dispatch = next.dispatches.find(entry => entry.id === dispatchId)
    next.messages.push(message(next, { id: 'msg_0000000000e1', type: 'status', at, dispatchId,
      taskId: dispatch.taskId, from: { kind: 'worker', dispatchId, paneId: dispatch.target.paneId } }))
    dispatch.version += 1; dispatch.updatedAt = at; return next } },
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

// --- r2 지적 H: 창을 열기 전 전제 -----------------------------------------------------------------
//
// 재관측 도장은 열린 attempt 를 **처음** 재관측하는 명령 한 번만 쓰인다. 그 명령이 창 안에 들어오면
// (선행 `worker-show` 의 pane 관측이 실패해 도장이 못 섰다가 창 안의 정상 heartbeat 가 함께 찍는 모양)
// 거절이 아무것도 안 썼는데도 `version` 이 +2 로 움직인다 — 두 쓰기는 바이트로 구분되지 않는다.
// 그래서 관문은 창을 열기 전에 도장을 찍고(`primeReconcile`), 못 찍으면 **다른 문장으로** 멈춘다.
// 여기서 잠그는 것은 그 두 모양이다.
results.precondition = {
  unprimedIsFlagged: 0, unprimedHeartbeatIsUnclean: 0,
  primedHeartbeatIsClean: 0, primedQuietIsClean: 0,
  otherAttemptUnprimedIsFlagged: 0, otherAttemptPrimedIsClean: 0,
  reconcileWriteCaughtOnPrimedBaseline: 0,
}
const stamp = LEAKS.find(entry => entry.name === 'refusal-persisted-its-reconcile')
for (let round = 0; round < rounds; round++) {
  const at = iso(1_800_000_000_000 + round + 11)

  // (a) 도장이 없는 창 — 관문이라면 여기서 "전제 미충족" 으로 멈춘다.
  const unprimed = baseline(round, { primed: false })
  const beforeU = snapshot(bytes(unprimed.state))
  if (unobservedOpenAttempts(beforeU.state).length === 1) results.precondition.unprimedIsFlagged += 1
  else failures.push({ round, what: 'an unstamped open attempt was not flagged by the precondition' })
  const afterU = snapshot(bytes(paneHeartbeat(unprimed.state, unprimed.dispatchId, at)))
  // 그 창에서 비교는 통과하지 못한다. 이것은 결함이 아니라 **구분 불가**이고, 그래서 창을 열지 않는다.
  if (!refusalDelta(beforeU.state, afterU.state, { dispatchId: unprimed.dispatchId }).clean) results.precondition.unprimedHeartbeatIsUnclean += 1
  else failures.push({ round, what: 'the unstamped-window heartbeat came out clean — the device no longer models the first stamp' })

  // (b) 전제를 세운 창 — 통과선 ①. 정상 heartbeat 가 거짓 실패를 내지 않는다.
  const primed = baseline(round)
  const beforeP = snapshot(bytes(primed.state))
  if (unobservedOpenAttempts(beforeP.state).length !== 0) failures.push({ round, what: 'a stamped attempt was still flagged' })
  const afterP = snapshot(bytes(paneHeartbeat(primed.state, primed.dispatchId, at)))
  if (refusalDelta(beforeP.state, afterP.state, { dispatchId: primed.dispatchId }).clean) results.precondition.primedHeartbeatIsClean += 1
  else failures.push({ round, what: 'a heartbeat in a stamped window was called unclean (the false failure H names)' })
  if (refusalDelta(beforeP.state, snapshot(bytes(clone(primed.state))).state, { dispatchId: primed.dispatchId }).clean) results.precondition.primedQuietIsClean += 1
  else failures.push({ round, what: 'an untouched stamped window was called unclean' })

  // (c) L-a — 같은 pane 의 **다른** 열린 attempt. 그쪽 도장이 없으면 그것도 전제 미충족이다.
  const twoUnprimed = withSecondAttempt(baseline(round), { primed: false })
  if (unobservedOpenAttempts(snapshot(bytes(twoUnprimed.state)).state).length === 1) results.precondition.otherAttemptUnprimedIsFlagged += 1
  else failures.push({ round, what: "the other open attempt's missing stamp was not flagged" })
  const twoPrimed = withSecondAttempt(baseline(round), { primed: true })
  const beforeT = snapshot(bytes(twoPrimed.state))
  const afterT = snapshot(bytes(paneHeartbeat(twoPrimed.state, twoPrimed.dispatchId, at)))
  if (refusalDelta(beforeT.state, afterT.state, { dispatchId: twoPrimed.dispatchId }).clean) results.precondition.otherAttemptPrimedIsClean += 1
  else failures.push({ round, what: 'a legitimate re-observation of another stamped attempt was called unclean' })

  // (d) 통과선 ② 의 비교 쪽: 전제를 세운 기준선 위에서도 **거절이 재관측을 남기는 쓰기 모양**은 잡힌다.
  //     (제품 쪽 차이는 05-result 에 적는다 — 도장을 찍고 나면 그 돌연변이는 쓸 것이 없어진다.)
  const stamped = snapshot(bytes(stamp.apply(primed.state, primed.dispatchId, at)))
  if (!refusalDelta(beforeP.state, stamped.state, { dispatchId: primed.dispatchId }).clean) results.precondition.reconcileWriteCaughtOnPrimedBaseline += 1
  else failures.push({ round, what: 'a reconcile write on a stamped baseline was called clean' })
}

// --- r2 지적 I: 「본 것이 없다」를 「깨끗하다」로 읽지 않는다 ---------------------------------------
results.unobservable = { missingDispatchIsUnclean: 0, nonDocumentThrows: 0 }
for (let round = 0; round < rounds; round++) {
  const { state, dispatchId } = baseline(round)
  const document = snapshot(bytes(state)).state
  const verdict = refusalDelta(document, document, { dispatchId: 'ctx_0000000fffff' })
  if (!verdict.clean && verdict.unobservable.length === 1) results.unobservable.missingDispatchIsUnclean += 1
  else failures.push({ round, what: 'a dispatchId present in neither document was called clean' })
  let threw = 0
  for (const pair of [[null, document], [document, null], [null, null], ['x', document]]) {
    try { refusalDelta(pair[0], pair[1], { dispatchId }) } catch { threw += 1 }
  }
  if (threw === 4) results.unobservable.nonDocumentThrows += 1
  else failures.push({ round, what: `comparing a non-document did not throw (${threw}/4)` })
}


results.ok = failures.length === 0
  && results.quietWindow.unchangedIsClean === rounds && results.quietWindow.bareVersionBumpCaught === rounds
  && results.quietWindow.leaksMissed === 0
  && results.oldComparisonFailed === rounds && results.newComparisonClean === rounds
  && LEAKS.every(leak => results.negatives[leak.name].caught === rounds && results.negatives[leak.name].missed === 0)
  && Object.values(results.precondition).every(count => count === rounds)
  && Object.values(results.unobservable).every(count => count === rounds)
results.failures = failures.slice(0, 10)
console.log(JSON.stringify(results, null, 2))
assert.ok(results.ok, 'the isolated device did not hold')
