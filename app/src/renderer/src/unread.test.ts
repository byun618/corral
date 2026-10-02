// LIFE-471 안 읽음 판정 매트릭스 — K2(완료 → pane 안 읽음) · K3(확인) · K6(Mark Read/Unread) · K7(벨 켜기·끄기) · K8ⓓ(유령 벨).
// 「보고 있음」 = 창이 보이고 포커스 + 활성 영역 선택 pane. 판정 시각은 완료 순간(enteredAt)과 보기 시작한 시각(since)의 비교다.
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../../shared/types.js'
import { acknowledgeInput, EMPTY_UNREAD, ingest, isCompletion, markRead, markUnread, type PaneObservation, type UnreadModel, type Watched } from './unread.js'

const A = '/r/a'
const B = '/r/b'
const obs = (paneId: string, status: AgentStatus, enteredAt: number, previousStatus: AgentStatus | null, worktreePath = A): PaneObservation => ({
  paneId, worktreePath, status, enteredAt, previousStatus,
})
type Step = { panes: PaneObservation[]; watched?: Watched; attentive?: boolean; active?: string | null; retained?: string[]; paths?: string[] }
function run(steps: Step[], start: UnreadModel = EMPTY_UNREAD): UnreadModel {
  let model = start
  for (const step of steps) {
    model = ingest(model, {
      panes: step.panes,
      retainedPaneIds: new Set(step.retained ?? []),
      worktreePaths: new Set(step.paths ?? [A, B]),
      activeWorktree: step.active === undefined ? A : step.active,
      attentive: step.attentive ?? step.watched != null,
      watched: step.watched ?? null,
    })
  }
  return model
}
const unreadOf = (model: UnreadModel): string[] => [...model.panes.keys()].sort()
const bells = (model: UnreadModel): string[] => [...model.worktrees].sort()
/** 첫 묶음: p1·p2(A, 같은 탭 split) · p3(B) 가 working. */
const START: Step = { panes: [obs('p1', 'working', 100, null), obs('p2', 'working', 100, null), obs('p3', 'working', 100, null, B)] }

describe('완료 판정 (01-criteria 용어 · C10)', () => {
  it('working/blocked → idle/done 만 완료다', () => {
    expect(isCompletion({ obs: obs('p', 'idle', 5, 'working'), firstBatch: false })).toBe(true)
    expect(isCompletion({ obs: obs('p', 'done', 5, 'blocked'), firstBatch: false })).toBe(true)
    expect(isCompletion({ obs: obs('p', 'working', 5, 'idle'), firstBatch: false })).toBe(false)
  })
  it('ⓓ 처음 보는 idle = 아님 · 처음 보는 done = 완료 · 기동 직후 첫 idle(unknown→idle) = 아님', () => {
    expect(isCompletion({ obs: obs('p', 'idle', 5, null), firstBatch: false })).toBe(false)
    expect(isCompletion({ obs: obs('p', 'done', 5, null), firstBatch: false })).toBe(true)
    expect(isCompletion({ obs: obs('p', 'idle', 5, 'unknown'), firstBatch: false })).toBe(false)
  })
  it('done → idle(herdr 의 조용한 seen)은 새 완료가 아니다 · unknown → done 도 아니다(#4825 류)', () => {
    expect(isCompletion({ obs: obs('p', 'idle', 5, 'done'), firstBatch: false })).toBe(false)
    expect(isCompletion({ obs: obs('p', 'done', 5, 'unknown'), firstBatch: false })).toBe(false)
  })
  it('렌더러 첫 묶음은 지나간 전이를 세지 않는다 — done 만 완료', () => {
    expect(isCompletion({ obs: obs('p', 'idle', 5, 'working'), firstBatch: true })).toBe(false)
    expect(isCompletion({ obs: obs('p', 'done', 5, 'working'), firstBatch: true })).toBe(true)
  })
})

describe('K2 완료 → pane 안 읽음 (보고 있음 × 창 상태 × 같은/다른 탭·split)', () => {
  it('ⓐ 창이 숨었거나 다른 앱이 앞(보고 있지 않음) — 선택 pane 의 완료도 안 읽음 · herdr 가 done 을 건너뛴 idle 이어도', () => {
    const model = run([START, { panes: [obs('p1', 'idle', 200, 'working'), obs('p2', 'working', 100, null), obs('p3', 'working', 100, null, B)], watched: null, attentive: false }])
    expect(unreadOf(model)).toEqual(['p1'])
    expect(bells(model)).toEqual([A])
  })
  it('ⓑ 같은 탭 다른 split pane 의 완료 = 안 읽음 (보는 것은 p1)', () => {
    const model = run([
      { ...START, watched: { paneId: 'p1', since: 50 } },
      { panes: [obs('p1', 'working', 100, null), obs('p2', 'idle', 200, 'working'), obs('p3', 'working', 100, null, B)], watched: { paneId: 'p1', since: 50 } },
    ])
    expect(unreadOf(model)).toEqual(['p2'])
    expect(bells(model)).toEqual([A])
  })
  it('ⓒ 보고 있는 pane 의 완료 = 안 읽음 아님 · 벨도 안 켜진다', () => {
    const model = run([
      { ...START, watched: { paneId: 'p1', since: 50 } },
      { panes: [obs('p1', 'idle', 200, 'working'), obs('p2', 'working', 100, null), obs('p3', 'working', 100, null, B)], watched: { paneId: 'p1', since: 50 } },
    ])
    expect(unreadOf(model)).toEqual([])
    expect(bells(model)).toEqual([])
  })
  it('ⓒ 처리가 늦어도 판정은 완료 시각에 묶인다 — 완료 뒤에 보기 시작했으면(since > T) 안 읽음으로 섰다가 바로 확인된다', () => {
    const model = run([START, { panes: [obs('p1', 'idle', 200, 'working'), obs('p2', 'working', 100, null), obs('p3', 'working', 100, null, B)], watched: { paneId: 'p1', since: 300 } }])
    expect(unreadOf(model)).toEqual([])
    // 198 과 같이 벨도 켜졌다가 그 worktree 에 남은 안 읽음이 없어 꺼진다.
    expect(bells(model)).toEqual([])
  })
  it('다른 worktree 의 완료 = 그 worktree 벨', () => {
    const model = run([
      { ...START, watched: { paneId: 'p1', since: 50 } },
      { panes: [obs('p1', 'working', 100, null), obs('p2', 'working', 100, null), obs('p3', 'idle', 200, 'working', B)], watched: { paneId: 'p1', since: 50 } },
    ])
    expect(unreadOf(model)).toEqual(['p3'])
    expect(bells(model)).toEqual([B])
  })
  it('ⓓ 처음 보는 done pane = 안 읽음 (재기동 뒤 herdr done 에서 다시 선다 — K8ⓔ)', () => {
    const model = run([{ panes: [obs('p1', 'done', 100, null), obs('p2', 'idle', 100, null)] }])
    expect(unreadOf(model)).toEqual(['p1'])
  })
  it('같은 상태가 다시 와도(30초 재동기) 두 번 세지 않는다 — Mark Read 뒤 같은 완료가 되살아나지 않는다', () => {
    const done: Step = { panes: [obs('p1', 'idle', 200, 'working')] }
    let model = run([{ panes: [obs('p1', 'working', 100, null)] }, done])
    model = markRead(model, A)
    model = run([done, done], model)
    expect(unreadOf(model)).toEqual([])
    expect(bells(model)).toEqual([])
  })
})

describe('K3 확인', () => {
  const unreadP1P2 = (): UnreadModel =>
    run([START, { panes: [obs('p1', 'idle', 200, 'working'), obs('p2', 'idle', 200, 'working'), obs('p3', 'working', 100, null, B)], attentive: false }])
  const panesNow: PaneObservation[] = [obs('p1', 'idle', 200, 'working'), obs('p2', 'idle', 200, 'working'), obs('p3', 'working', 100, null, B)]
  it('ⓐⓒ 보고 있음이 되는 순간(창 복귀·포커스 복귀·선택 전환) 그 pane 만 확인 — 같은 worktree 의 다른 pane 은 남고 벨도 남는다', () => {
    const model = run([{ panes: panesNow, watched: { paneId: 'p1', since: 300 } }], unreadP1P2())
    expect(unreadOf(model)).toEqual(['p2'])
    expect(bells(model)).toEqual([A])
  })
  it('ⓐ 남은 것까지 보면 벨이 꺼진다 (198 shouldClearViewedAgentWorktreeUnread)', () => {
    let model = run([{ panes: panesNow, watched: { paneId: 'p1', since: 300 } }], unreadP1P2())
    model = run([{ panes: panesNow, watched: { paneId: 'p2', since: 400 } }], model)
    expect(unreadOf(model)).toEqual([])
    expect(bells(model)).toEqual([])
  })
  it('ⓑ 창이 숨었거나 포커스가 아닌 채 선택·활성만 바뀐 것(CLI activate·시작 복원)은 확인이 아니다', () => {
    const model = run([{ panes: panesNow, watched: null, attentive: false, active: B }], unreadP1P2())
    expect(unreadOf(model)).toEqual(['p1', 'p2'])
    expect(bells(model)).toEqual([A])
  })
})

describe('K6 Mark Read / Mark Unread', () => {
  it('ⓒ Mark Read = 벨 끄기 + 그 worktree pane 안 읽음 전부 확인 (다른 worktree 는 그대로)', () => {
    let model = run([START, { panes: [obs('p1', 'idle', 200, 'working'), obs('p2', 'idle', 200, 'working'), obs('p3', 'idle', 200, 'working', B)], attentive: false }])
    model = markRead(model, A)
    expect(unreadOf(model)).toEqual(['p3'])
    expect(bells(model)).toEqual([B])
  })
  it('ⓑ 완료 없는 worktree 에도 Mark Unread — 벨만 켜진다', () => {
    const model = markUnread(run([START]), B)
    expect(bells(model)).toEqual([B])
    expect(unreadOf(model)).toEqual([])
  })
  it('ⓓ 보고 있는 worktree 에 Mark Unread 해도 자동 확인이 바로 지우지 않는다 — 확인할 pane 이 없으면 벨은 그대로', () => {
    const watched = { paneId: 'p1', since: 50 }
    let model = run([{ ...START, watched }])
    model = markUnread(model, A)
    model = run([{ ...START, watched }, { ...START, watched }], model)
    expect(bells(model)).toEqual([A])
  })
  it('ⓓ 보호가 풀리는 때: 다른 worktree 에서 이 worktree 로 활성화(보고 있는 중) · 이 worktree 의 새 완료를 보고 있다가 확인 · 터미널 입력', () => {
    const watched = { paneId: 'p3', since: 50 }
    let model = markUnread(run([{ ...START, watched, active: B }]), A)
    // 활성화 B → A (보고 있는 중)
    model = run([{ ...START, watched: { paneId: 'p1', since: 60 }, active: A }], model)
    expect(bells(model)).toEqual([])
    // 터미널 입력
    model = acknowledgeInput(markUnread(model, A), { paneId: 'p1', worktreePath: A })
    expect(bells(model)).toEqual([])
  })
})

describe('K7 벨 켜기·끄기 규칙', () => {
  it('ⓐ 보고 있지 않을 때의 완료가 벨을 켠다 / ⓒ 활성 worktree 의 보지 않는 다른 pane 완료도 켠다(198 동일)', () => {
    const watched = { paneId: 'p1', since: 50 }
    const model = run([{ ...START, watched }, { panes: [obs('p1', 'working', 100, null), obs('p2', 'idle', 200, 'working'), obs('p3', 'working', 100, null, B)], watched }])
    expect(bells(model)).toEqual([A])
  })
  it('ⓑ 활성화는 사용자 전환만 — 시작 복원(활성 없음 → A)은 벨을 끄지 않는다', () => {
    const start = markUnread(EMPTY_UNREAD, A)
    const model = run([{ ...START, watched: { paneId: 'p1', since: 50 }, active: A }], start)
    expect(bells(model)).toEqual([A])
  })
  it('ⓑ 활성 사이의 닫힘(null)을 건너뛰고 전환을 본다 — B → (닫힘) → A 도 활성화다', () => {
    let model = markUnread(run([{ ...START, watched: { paneId: 'p3', since: 50 }, active: B }]), A)
    model = run([{ ...START, attentive: true, active: null }], model)
    model = run([{ ...START, watched: { paneId: 'p1', since: 70 }, active: A }], model)
    expect(bells(model)).toEqual([])
  })
})

describe('정리 — 닫힌 pane · 사라진 worktree (K4ⓓ · K8ⓓ)', () => {
  it('닫힌 탭의 pane 안 읽음은 보존 행으로 남고, 보존 기록도 없어지면 버린다', () => {
    let model = run([START, { panes: [obs('p1', 'idle', 200, 'working'), obs('p2', 'working', 100, null), obs('p3', 'working', 100, null, B)], attentive: false }])
    model = run([{ panes: [obs('p2', 'working', 100, null)], retained: ['p1'] }], model)
    expect(unreadOf(model)).toEqual(['p1'])
    model = run([{ panes: [obs('p2', 'working', 100, null)] }], model)
    expect(unreadOf(model)).toEqual([])
  })
  it('이번 세션에 있던 worktree 가 사라지면(삭제·레포 제거) 그 벨을 지운다 — 처음부터 안 보인 경로·빈 목록은 건드리지 않는다', () => {
    let model = markUnread(markUnread(EMPTY_UNREAD, B), '/never/seen')
    model = run([{ ...START, paths: [A, B] }], model)
    model = run([{ ...START, paths: [] }], model)
    expect(bells(model)).toEqual(['/never/seen', B])
    model = run([{ ...START, paths: [A] }], model)
    expect(bells(model)).toEqual(['/never/seen'])
  })
})
