// LIFE-490 K2 — 활성 동기화 판정(순수 함수). 훅 수준(응답·state 도착 순서·사용자 의도·기한 타이머)은 `hooks/useLifecycleActions.active-pending.test.mjs`.
import { describe, expect, it } from 'vitest'
import { TREE_REBUILD_MS_PER_REPO, pendingActiveMs, syncActiveWorkspace } from './active-workspace.js'

const main = { workspaceId: 'w1', focused: true }
const other = { workspaceId: 'w2', focused: false }

describe('syncActiveWorkspace', () => {
  it('활성이 열린 목록에 있으면 그대로, 그 보류는 풀린다(도착)', () => {
    expect(syncActiveWorkspace({ current: 'w2', pending: { workspaceId: 'w2' }, open: [main, other] })).toEqual({ next: 'w2', pending: null })
  })
  it('보류 중이면 목록에 없어도 지우지 않는다 — 결함 경로(응답 → 새 workspace 없는 push)', () => {
    const pending = { workspaceId: 'w9' }
    expect(syncActiveWorkspace({ current: 'w9', pending, open: [main] })).toEqual({ next: 'w9', pending })
  })
  it('보류가 없으면(만료로 지워짐) 옛 규칙(focused) — 죽은 id 에 머물지 않는다', () => {
    expect(syncActiveWorkspace({ current: 'w9', pending: null, open: [other, main] })).toEqual({ next: 'w1', pending: null })
  })
  it('focused 가 없으면 첫 workspace, 열린 것이 없으면 null', () => {
    expect(syncActiveWorkspace({ current: 'w9', pending: null, open: [other, { workspaceId: 'w3', focused: false }] }).next).toBe('w2')
    expect(syncActiveWorkspace({ current: 'w8', pending: { workspaceId: 'w9' }, open: [] })).toEqual({ next: null, pending: null })
  })
  it('보류는 활성과 같은 id 일 때만 지킨다 — 다른 id 의 보류는 활성을 지키지 않는다', () => {
    expect(syncActiveWorkspace({ current: 'w8', pending: { workspaceId: 'w9' }, open: [main] })).toEqual({ next: 'w1', pending: null })
  })
  it('재기동(활성 없음·보류 없음) — focused 승격 그대로', () => {
    expect(syncActiveWorkspace({ current: null, pending: null, open: [other, main] })).toEqual({ next: 'w1', pending: null })
  })
})

describe('pendingActiveMs (fix1 F2 · r1 G-2)', () => {
  it('재구성 두 번 × 레포 수 × 레포당 상한(18초) — 레포 0 은 1 로 센다', () => {
    expect(TREE_REBUILD_MS_PER_REPO).toBe(18_000)
    expect(pendingActiveMs({ repoCount: 0 })).toBe(36_000)
    expect(pendingActiveMs({ repoCount: 1 })).toBe(36_000)
    expect(pendingActiveMs({ repoCount: 3 })).toBe(108_000)
  })
})
