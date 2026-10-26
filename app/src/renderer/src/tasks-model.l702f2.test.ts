// LIFE-702 수정 r2 G2 — 낙관 반영의 done→done 은 doneAt 을 그대로 둔다(`applyIntent` status · `optimisticDoneAt`).
import { describe, expect, it } from 'vitest'
import type { WorkItem, WorkStatus } from '../../shared/work.js'
import { applyIntent, optimisticDoneAt } from './tasks-model.js'

const STATUSES: WorkStatus[] = [
  { key: 'todo', label: '할 일', category: 'todo', order: 0, color: null },
  { key: 'done', label: '완료', category: 'done', order: 1, color: null },
  { key: 'cancelled', label: '취소', category: 'done', order: 2, color: null },
]
const OLD = '2026-10-01T03:04:05.000Z'
const item: WorkItem = { bodyLock: null, doneAt: OLD,
  id: 'i1', key: 'K-1', spaceKey: 's1', title: 't', body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'done', category: 'done', priority: null, dueAt: null,
  parentId: null, placement: 'board', rank: '1', resolution: 'completed', openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [],
}

describe('G2 낙관 done→done', () => {
  it('완료 → 취소(다른 done 상태)로 끌면 doneAt 그대로', () => {
    const [moved] = applyIntent({ items: [item], itemId: 'i1', intent: { kind: 'status', statusKey: 'cancelled' }, statuses: STATUSES })
    expect(moved?.category).toBe('done')
    expect(moved?.doneAt).toBe(OLD)
  })
  it('optimisticDoneAt — done→done 유지 · 이탈·진입 null', () => {
    expect(optimisticDoneAt({ from: 'done', to: 'done', doneAt: OLD })).toBe(OLD)
    expect(optimisticDoneAt({ from: 'done', to: 'todo', doneAt: OLD })).toBeNull()
    expect(optimisticDoneAt({ from: 'in_progress', to: 'done', doneAt: OLD })).toBeNull()
  })
})
