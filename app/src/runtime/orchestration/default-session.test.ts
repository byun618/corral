// LIFE-556 H1 — 동봉 backend 는 언제나 herdr default 세션이다. 같은 기록(`paneSession: 'default'`)으로
// sender 검사(LIFE-410)와 계보(LIFE-459 L2ⓑ)가 둘 다 맞아야 한다. herdr 는 default pane 에 `HERDR_SESSION` 을 싣지 않으므로
// 호출자 쪽 증인은 소켓(`socketIsBackend`)이다. 「이름 없는 기록 ≠ default」 원칙은 그대로다 — 기록 쪽은 이름을 그대로 적고,
// 호출자 쪽만 「이름 없음 + 이 backend 소켓」 을 default 로 인정한다(그 밖의 이름 없는 호출자는 여전히 아무 세션도 아니다).
import { describe, expect, it } from 'vitest'
import { createDispatch, createRun, createTask, emptyState, findDispatch, type DispatchTarget, type PaneObservation } from './model.js'
import { callerInSession, emptyWorker, replaceDispatchRecord, verifySender, withWorker, type CallerClaim } from './worker.js'
import { resolveLineage } from './lineage.js'

const AT = '2026-10-08T00:00:00.000Z'
const target: DispatchTarget = { handle: 'h', runtimeId: 'rt', epoch: 'e1', ptyId: 'pty-1', paneId: 'w1:p2' }
const LIVE: PaneObservation = { kind: 'live' }

function attempt(paneSession: string | null) {
  const run = createRun(emptyState(), 'LIFE-556 H1', AT)
  const made = createTask(run.state, { runId: run.run.id, spec: 'x', title: null, deps: [], at: AT })
  const worker = emptyWorker({ launch: 'created', ownership: 'owned', paneSession, originDispatchId: null })
  const dispatched = createDispatch(made.state, { task: made.task, target, agent: null, agentAbsenceReason: 'test', worker, at: AT })
  const self = findDispatch(dispatched.state, dispatched.dispatch.id)!
  const state = replaceDispatchRecord(dispatched.state, withWorker(self, { originDispatchId: self.id }, AT))
  return { state, taskId: made.task.id, dispatchId: dispatched.dispatch.id }
}
const claim = (base: ReturnType<typeof attempt>, caller: CallerClaim) => ({ taskId: base.taskId, dispatchId: base.dispatchId, caller, observation: LIVE })
const liveDefault = { session: 'default', epoch: 'e1', panes: [{ paneId: 'w1:p2', ptyId: 'pty-1' }] }

describe('LIFE-556 H1 — default 세션 dispatch', () => {
  it('default 로 기록한 시도: 이름 없는 호출자가 이 backend 소켓이면 보고를 받고 sessionVerified 는 true, 계보에도 나온다', () => {
    const base = attempt('default')
    const verdict = verifySender(base.state, claim(base, { paneId: 'w1:p2', session: null, socketIsBackend: true }), 'reject')
    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.sessionVerified).toBe(true)
    expect(resolveLineage({ state: base.state, live: liveDefault }).map(entry => entry.dispatchId)).toEqual([base.dispatchId])
  })
  it('다른 세션 소켓(또는 소켓 증인 없음)의 이름 없는 호출자는 거절한다', () => {
    const base = attempt('default')
    for (const caller of [{ paneId: 'w1:p2', session: null, socketIsBackend: false }, { paneId: 'w1:p2', session: null }, { paneId: 'w1:p2', session: 'other' }]) {
      const verdict = verifySender(base.state, claim(base, caller), 'reject')
      expect(verdict.ok === false && verdict.code).toBe('sender_mismatch')
    }
  })
  it('이름 세션(명시 바인딩)은 종전 그대로 — 소켓이 같아도 이름이 다르거나 없으면 거절', () => {
    const base = attempt('life417-native')
    expect(verifySender(base.state, claim(base, { paneId: 'w1:p2', session: 'life417-native' }), 'reject').ok).toBe(true)
    expect(verifySender(base.state, claim(base, { paneId: 'w1:p2', session: null, socketIsBackend: true }), 'reject').ok).toBe(false)
  })
  it('기록에 이름이 없는 시도는 종전대로 pane id 만으로 받고(sessionVerified false), default 계보에는 나오지 않는다', () => {
    const base = attempt(null)
    const verdict = verifySender(base.state, claim(base, { paneId: 'w1:p2', session: null }), 'reject')
    expect(verdict.ok && verdict.sessionVerified).toBe(false)
    expect(resolveLineage({ state: base.state, live: liveDefault })).toEqual([])
  })
  it('callerInSession — 예외는 default 하나뿐', () => {
    expect(callerInSession({ recorded: 'default', caller: { paneId: 'p', session: null, socketIsBackend: true } })).toBe(true)
    expect(callerInSession({ recorded: 's1', caller: { paneId: 'p', session: null, socketIsBackend: true } })).toBe(false)
    expect(callerInSession({ recorded: 'default', caller: { paneId: 'p', session: 'default' } })).toBe(true)
  })
})
