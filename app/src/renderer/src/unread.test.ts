// LIFE-471 안 읽음 판정 매트릭스 — K2(완료 → pane 안 읽음) · K3(확인) · K6(Mark Read/Unread) · K7(벨 켜기·끄기) · K8ⓓ(유령 벨).
// 「보고 있음」 = 창이 보이고 포커스 + 활성 영역 선택 pane. 판정 시각은 완료 순간(enteredAt)과 보기 시작한 시각(since)의 비교다.
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../../shared/types.js'
import { acknowledgeInput, completionsOf, EMPTY_UNREAD, ingest, markRead, markUnread, type PaneObservation, type RepoScan, type UnreadModel, type Watched } from './unread.js'

const A = '/r/a'
const B = '/r/b'
/** 직전 상태 하나만 있는 관측(그 상태에 들어선 시각 = enteredAt - 1). 이력이 더 긴 것은 `withHistory`. */
const obs = (paneId: string, status: AgentStatus, enteredAt: number, previousStatus: AgentStatus | null, worktreePath = A): PaneObservation => ({
  paneId, worktreePath, status, enteredAt, history: previousStatus === null ? [] : [{ status: previousStatus, enteredAt: enteredAt - 1 }],
})
/** 이력을 오래된 것부터 [상태, 진입 시각] 으로 — 마지막이 지금 상태. */
const withHistory = (paneId: string, steps: Array<[AgentStatus, number]>, worktreePath = A): PaneObservation => {
  const ordered = steps.map(([status, enteredAt]) => ({ status, enteredAt }))
  const now = ordered[ordered.length - 1]
  if (now === undefined) throw new Error('빈 이력')
  return { paneId, worktreePath, status: now.status, enteredAt: now.enteredAt, history: ordered.slice(0, -1).reverse() }
}
type Step = { panes: PaneObservation[]; watched?: Watched; attentive?: boolean; active?: string | null; retained?: string[]; paths?: string[]; repos?: RepoScan[] }
function run(steps: Step[], start: UnreadModel = EMPTY_UNREAD): UnreadModel {
  let model = start
  for (const step of steps) {
    model = ingest(model, {
      panes: step.panes,
      retainedPaneIds: new Set(step.retained ?? []),
      repos: step.repos ?? [{ root: '/r', error: false, worktreePaths: step.paths ?? [A, B] }],
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
  const found = (o: PaneObservation, firstBatch = false, since?: number): string =>
    completionsOf({ obs: o, firstBatch, since }).map((c) => `${c.at}${c.bell ? '+bell' : ''}`).join(',')
  it('working/blocked → idle/done 만 완료다 (벨을 켜는 실제 전이)', () => {
    expect(found(obs('p', 'idle', 5, 'working'))).toBe('5+bell')
    expect(found(obs('p', 'done', 5, 'blocked'))).toBe('5+bell')
    expect(found(obs('p', 'working', 5, 'idle'))).toBe('')
  })
  it('ⓓ 처음 보는 idle = 아님 · 처음 보는 done = pane 안 읽음만(벨 없음 — M2) · 기동 직후 첫 idle(unknown→idle) = 아님', () => {
    expect(found(obs('p', 'idle', 5, null))).toBe('')
    expect(found(obs('p', 'done', 5, null))).toBe('5')
    expect(found(obs('p', 'idle', 5, 'unknown'))).toBe('')
  })
  it('done → idle(herdr 의 조용한 seen)은 새 완료가 아니다 · unknown → done 도 아니다(#4825 류)', () => {
    expect(found(obs('p', 'idle', 5, 'done'))).toBe('')
    expect(found(obs('p', 'done', 5, 'unknown'))).toBe('')
  })
  it('렌더러 첫 묶음은 지나간 전이를 세지 않는다 — done 만 pane 안 읽음, 벨 없음(M2)', () => {
    expect(found(obs('p', 'idle', 5, 'working'), true)).toBe('')
    expect(found(obs('p', 'done', 5, 'working'), true)).toBe('5')
  })
  it('L3 묶음 하나에 합쳐진 연쇄도 센다 — 마지막으로 살핀 시각 뒤의 이력만, 같은 완료는 두 번 안 센다', () => {
    // 재현 2: working → idle → working 이 한 묶음 — 지금은 working 이지만 사이의 완료가 있다.
    expect(found(withHistory('p', [['working', 100], ['idle', 200], ['working', 300]]), false, 100)).toBe('200+bell')
    // 재현 3: working → idle → done — 직전 칸(idle)만 보면 놓친다.
    expect(found(withHistory('p', [['working', 100], ['idle', 200], ['done', 300]]), false, 100)).toBe('200+bell')
    // 이미 살핀 완료(200)는 다시 세지 않는다.
    expect(found(withHistory('p', [['working', 100], ['idle', 200], ['working', 300], ['idle', 400]]), false, 200)).toBe('400+bell')
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
  it('ⓓ 처음 보는 done pane = 안 읽음 (재기동 뒤 herdr done 에서 다시 선다 — K8ⓔ) · 벨은 새로 안 켠다(M2)', () => {
    const model = run([{ panes: [obs('p1', 'done', 100, null), obs('p2', 'idle', 100, null)] }])
    expect(unreadOf(model)).toEqual(['p1'])
    expect(bells(model)).toEqual([])
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
  it('이번 세션에 있던 worktree 가 사라지면(삭제·레포 제거) 그 벨을 지운다 — 빈 목록(첫 적재 전)은 건드리지 않는다', () => {
    let model = markUnread(EMPTY_UNREAD, B)
    model = run([{ ...START, paths: [A, B] }], model)
    model = run([{ ...START, paths: [] }], model)
    expect(bells(model)).toEqual([B])
    model = run([{ ...START, paths: [A] }], model)
    expect(bells(model)).toEqual([])
  })
})

describe('r1 M1·L1 — 스캔 실패는 「사라짐」이 아니다 · 본 적 없는 저장 벨은 깨끗한 적재에서만 지운다', () => {
  const W1 = '/r1/w1'
  const W2 = '/r2/w2'
  const repos = (input: { r1: 'ok' | 'error'; r2?: 'ok' | 'error'; extra?: string[] }): RepoScan[] => [
    { root: '/r1', error: input.r1 === 'error', worktreePaths: input.r1 === 'ok' ? [W1, ...(input.extra ?? [])] : [] },
    { root: '/r2', error: input.r2 === 'error', worktreePaths: input.r2 === 'error' ? [] : [W2] },
  ]
  const panes: PaneObservation[] = [obs('p1', 'working', 100, null, W2)]
  it('재현 6 반대: 레포 하나의 git 스캔이 한 번 실패했다 돌아와도 그 벨은 남는다 (다른 레포가 있어 목록이 비지 않는 경우)', () => {
    let model = markUnread(markUnread(EMPTY_UNREAD, W1), W2)
    model = run([{ panes, repos: repos({ r1: 'ok' }) }], model)
    model = run([{ panes, repos: repos({ r1: 'error' }) }], model)
    expect(bells(model)).toEqual([W1, W2])
    model = run([{ panes, repos: repos({ r1: 'ok' }) }], model)
    expect(bells(model)).toEqual([W1, W2])
  })
  it('깨끗한 적재(모든 레포 에러 없음)에서 본 적 없는 저장 벨(앱이 꺼진 사이 지운 worktree)을 지운다 — 재현 1 반대', () => {
    let model = markUnread(markUnread(EMPTY_UNREAD, W2), '/r1/gone')
    model = run([{ panes, repos: repos({ r1: 'ok' }) }], model)
    expect(bells(model)).toEqual([W2])
  })
  it('레포 에러가 남아 있는 동안은 본 적 없는 저장 벨 정리를 미룬다 → 에러가 걷힌 묶음에서 지운다', () => {
    let model = markUnread(markUnread(EMPTY_UNREAD, W2), '/r1/gone')
    model = run([{ panes, repos: repos({ r1: 'error' }) }], model)
    expect(bells(model)).toEqual(['/r1/gone', W2])
    model = run([{ panes, repos: repos({ r1: 'ok' }) }], model)
    expect(bells(model)).toEqual([W2])
  })
  it('에러 없는 레포에서 사라진 경로는 다른 레포에 에러가 있어도 지운다 (삭제는 삭제)', () => {
    let model = markUnread(markUnread(EMPTY_UNREAD, W1), '/r1/extra')
    model = run([{ panes, repos: repos({ r1: 'ok', extra: ['/r1/extra'] }) }], model)
    model = run([{ panes, repos: repos({ r1: 'ok', r2: 'error' }) }], model)
    expect(bells(model)).toEqual([W1])
  })
})

describe('r1 M2 — 재시작 뒤 벨은 저장값을 따른다', () => {
  it('Mark Read 한 뒤에도 herdr 에 남은 done 이 재시작(첫 묶음)마다 벨을 다시 켜지 않는다 · 굵기(pane 안 읽음)는 선다', () => {
    // 재현 5: 첫 묶음 done → 벨이 서던 것.
    const restarted = run([{ panes: [obs('p3', 'done', 100, 'working', B)] }])
    expect(unreadOf(restarted)).toEqual(['p3'])
    expect(bells(restarted)).toEqual([])
  })
  it('세션 중 실제 완료 전이는 그대로 벨을 켠다', () => {
    const model = run([START, { panes: [obs('p1', 'working', 100, null), obs('p2', 'working', 100, null), obs('p3', 'done', 200, 'working', B)] }])
    expect(bells(model)).toEqual([B])
  })
})
