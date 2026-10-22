// LIFE-691 K2ⓐ · f1 C·D — 파일 탭 닫기 뒤 입력 pane 이 따라갈 터미널 탭(`recordCloseFollow`·`closeFollowTarget`).
// 규칙: 같은 worktree 의 활성 영역에서 **활성 탭이 닫혀** 새 활성이 터미널 탭일 때만. 닫기 경로 둘(탭 닫기·탐색기 삭제/이동)이 같은 기록을 쓴다.
import { describe, expect, it } from 'vitest'
import { closeFollowTarget, recordCloseFollow, type CloseFollow } from './file-tabs.js'

const F1 = 'file:a.md'
const F2 = 'file:b.md'
const S2 = 'w1:t2'
const note = (input: { pending?: CloseFollow | null; active?: string | null; worktreePath?: string; activeTabBefore?: string | null; tabIds: string[] }): CloseFollow | null =>
  recordCloseFollow({
    pending: input.pending ?? null,
    activeWorktreePath: input.active === undefined ? '/r' : input.active,
    worktreePath: input.worktreePath ?? '/r',
    activeTabBefore: input.activeTabBefore === undefined ? F2 : input.activeTabBefore,
    tabIds: input.tabIds,
  })

describe('closeFollowTarget', () => {
  it('ⓐ 활성 파일2 닫기 → 새 활성 세션2(터미널) = 따라간다', () => {
    expect(closeFollowTarget({ pending: note({ tabIds: [F2] }), worktreePath: '/r', activeTabId: S2 })).toBe(S2)
  })
  it('새 활성이 파일 탭이면 따라가지 않는다(파일1)', () => {
    expect(closeFollowTarget({ pending: note({ tabIds: [F2] }), worktreePath: '/r', activeTabId: F1 })).toBeNull()
  })
  it('비활성 탭(또는 다른 영역의 탭) 닫기 — 닫기 직전 활성 탭이 닫힌 목록에 없으면 따라가지 않는다', () => {
    expect(closeFollowTarget({ pending: note({ activeTabBefore: S2, tabIds: [F1] }), worktreePath: '/r', activeTabId: S2 })).toBeNull()
  })
  it('대기 중 worktree 가 바뀌었으면 따라가지 않는다(확인 모달 중 전환)', () => {
    expect(closeFollowTarget({ pending: note({ tabIds: [F2] }), worktreePath: '/other', activeTabId: S2 })).toBeNull()
  })
  it('대기가 없으면 null — 다른 배치 변경(옮기기·탭 전환)은 반응하지 않는다', () => {
    expect(closeFollowTarget({ pending: null, worktreePath: '/r', activeTabId: S2 })).toBeNull()
  })
  it('활성 탭이 없었으면 null', () => {
    expect(closeFollowTarget({ pending: note({ activeTabBefore: null, tabIds: [F2] }), worktreePath: '/r', activeTabId: S2 })).toBeNull()
  })
})

describe('recordCloseFollow', () => {
  it('다른 worktree 닫기(탐색기 — 비활성 worktree 배치)는 싣지 않는다', () => {
    expect(note({ active: '/r', worktreePath: '/other', tabIds: [F2] })).toBeNull()
    expect(note({ active: null, tabIds: [F2] })).toBeNull()
  })
  it('같은 worktree 여러 탭 닫기 — 닫은 탭을 보태고 activeTabBefore 는 첫 값', () => {
    const first = note({ tabIds: [F1] , activeTabBefore: F2 })
    const both = note({ pending: first, activeTabBefore: S2, tabIds: [F2] })
    expect(both).toEqual({ worktreePath: '/r', activeTabBefore: F2, closedTabIds: [F1, F2] })
    expect(closeFollowTarget({ pending: both, worktreePath: '/r', activeTabId: S2 })).toBe(S2)
  })
  it('빈 닫기는 기존 대기 그대로', () => {
    const first = note({ tabIds: [F2] })
    expect(note({ pending: first, tabIds: [] })).toBe(first)
  })
  it('다른 worktree 의 옛 대기는 새 worktree 닫기로 갈아 끼운다', () => {
    const stale: CloseFollow = { worktreePath: '/old', activeTabBefore: F2, closedTabIds: [F2] }
    expect(note({ pending: stale, tabIds: [F1], activeTabBefore: F1 })).toEqual({ worktreePath: '/r', activeTabBefore: F1, closedTabIds: [F1] })
  })
})
