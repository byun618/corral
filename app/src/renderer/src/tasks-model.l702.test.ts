// LIFE-702 D2 — 오래된 완료 판정(`isHiddenOnBoard`). LA `apps/web/src/lib/board-visibility.ts` 와 같은 식(`>=` 14일, null·NaN 표시).
import { describe, expect, it } from 'vitest'
import type { WorkCategory } from '../../shared/work.js'
import { DONE_HIDE_MS, isHiddenOnBoard } from './tasks-model.js'

const NOW = Date.parse('2026-10-25T12:00:00.000Z')
const HOUR = 3_600_000
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString()
const hidden = ({ category, doneAt }: { category: WorkCategory; doneAt: string | null }): boolean => isHiddenOnBoard({ item: { category, doneAt }, now: NOW })

describe('D2 isHiddenOnBoard', () => {
  it('기간 = 14일(LA DONE_HIDE_DAYS)', () => {
    expect(DONE_HIDE_MS).toBe(14 * 24 * HOUR)
  })
  it('ⓐ done + 14일 지남 → 숨김', () => {
    expect(hidden({ category: 'done', doneAt: at(20 * 24 * HOUR) })).toBe(true)
  })
  it('ⓑ done + 13일 23시간 → 표시', () => {
    expect(hidden({ category: 'done', doneAt: at(13 * 24 * HOUR + 23 * HOUR) })).toBe(false)
  })
  it('ⓒ 정확히 14일 → 숨김(경계 >=) · 1ms 모자라면 표시', () => {
    expect(hidden({ category: 'done', doneAt: at(DONE_HIDE_MS) })).toBe(true)
    expect(hidden({ category: 'done', doneAt: at(DONE_HIDE_MS - 1) })).toBe(false)
  })
  it('ⓓ done + doneAt null → 표시', () => {
    expect(hidden({ category: 'done', doneAt: null })).toBe(false)
  })
  it('ⓔ todo·in_progress 인데 doneAt 이 남아 있어도 표시', () => {
    expect(hidden({ category: 'todo', doneAt: at(30 * 24 * HOUR) })).toBe(false)
    expect(hidden({ category: 'in_progress', doneAt: at(30 * 24 * HOUR) })).toBe(false)
  })
  it('ⓕ 해석 불가 doneAt → 표시', () => {
    expect(hidden({ category: 'done', doneAt: '어제쯤' })).toBe(false)
    expect(hidden({ category: 'done', doneAt: '' })).toBe(false)
  })
})
