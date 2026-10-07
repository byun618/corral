// LIFE-490 K2 — 활성 동기화 판정(순수 함수). 훅 수준(응답·state 도착 순서·사용자 의도)은 `hooks/useLifecycleActions.active-pending.test.mjs`.
import { describe, expect, it } from 'vitest'
import { PENDING_ACTIVE_MS, syncActiveWorkspace } from './active-workspace.js'

const main = { workspaceId: 'w1', focused: true }
const other = { workspaceId: 'w2', focused: false }

describe('syncActiveWorkspace', () => {
  it('활성이 열린 목록에 있으면 그대로, 그 보류는 풀린다(도착)', () => {
    expect(syncActiveWorkspace({ current: 'w2', pending: { workspaceId: 'w2', deadline: 10 }, open: [main, other], now: 0 })).toEqual({ next: 'w2', pending: null })
  })
  it('보류 중이고 기한 전이면 목록에 없어도 지우지 않는다 — 결함 경로(응답 → 새 workspace 없는 push)', () => {
    const pending = { workspaceId: 'w9', deadline: 100 }
    expect(syncActiveWorkspace({ current: 'w9', pending, open: [main], now: 99 })).toEqual({ next: 'w9', pending })
  })
  it('보류 기한이 지나면 옛 규칙(focused)으로 — 죽은 id 에 머물지 않는다', () => {
    expect(syncActiveWorkspace({ current: 'w9', pending: { workspaceId: 'w9', deadline: 100 }, open: [other, main], now: 100 })).toEqual({ next: 'w1', pending: null })
  })
  it('focused 가 없으면 첫 workspace, 열린 것이 없으면 null', () => {
    expect(syncActiveWorkspace({ current: 'w9', pending: null, open: [other, { workspaceId: 'w3', focused: false }], now: 0 }).next).toBe('w2')
    expect(syncActiveWorkspace({ current: 'w9', pending: { workspaceId: 'w9', deadline: 1 }, open: [], now: 5 })).toEqual({ next: null, pending: null })
  })
  it('보류는 활성과 같은 id 일 때만 지킨다 — 다른 id 의 보류는 활성을 지키지 않는다', () => {
    expect(syncActiveWorkspace({ current: 'w8', pending: { workspaceId: 'w9', deadline: 100 }, open: [main], now: 0 })).toEqual({ next: 'w1', pending: null })
  })
  it('재기동(활성 없음·보류 없음) — focused 승격 그대로', () => {
    expect(syncActiveWorkspace({ current: null, pending: null, open: [other, main], now: 0 })).toEqual({ next: 'w1', pending: null })
  })
  it('기한 값은 10초', () => {
    expect(PENDING_ACTIVE_MS).toBe(10_000)
  })
})
