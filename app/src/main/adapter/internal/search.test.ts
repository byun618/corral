// LIFE-812 — 검색 왕복(searchPane)·응답 해석. 서버 없이 부르는 쪽을 가짜로 둔다.
import { describe, expect, it } from 'vitest'
import { SEARCH_ATTEMPTS, readSearchResponse, searchPane, type SearchCall } from './search.js'

const range = (row: number, col: number, endRow: number, endCol: number) => ({ start: { row, col }, end: { row: endRow, col: endCol } })

function recorder(reply: (method: string, params: Record<string, unknown>) => unknown): { call: SearchCall; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params })
      return reply(method, params)
    },
  }
}

describe('readSearchResponse', () => {
  it('창 안의 현재 일치(current)와 전체 순번(current_global)을 가른다', () => {
    const value = { total: 3001, current: 1, current_global: 1500, matches: [range(1499, 10, 1499, 14), range(1500, 10, 1500, 14)] }
    expect(readSearchResponse(value, 2)).toEqual({ kind: 'found', total: 3001, index: 1500, current: range(1500, 10, 1500, 14), matches: value.matches, attempts: 2 })
  })
  it('0건이면 none', () => {
    expect(readSearchResponse({ total: 0, matches: [] }, 1)).toEqual({ kind: 'none', attempts: 1 })
  })
  it('모양이 어긋나면 null', () => {
    expect(readSearchResponse({ total: 1, matches: [{ start: { row: -1, col: 0 }, end: { row: 0, col: 0 } }], current: 0, current_global: 0 }, 1)).toBeNull()
    expect(readSearchResponse({ total: 1, matches: [], current: 0, current_global: 0 }, 1)).toBeNull()
    expect(readSearchResponse(null, 1)).toBeNull()
  })
})

describe('searchPane', () => {
  it('빈 질의·상한 초과는 묻지 않는다(C4ⓕ·C1ⓔ)', async () => {
    const { call, calls } = recorder(() => ({}))
    expect(await searchPane({ request: { paneId: 'p', query: '', direction: 'forward', from: 'viewport' }, viewportCursor: { row: 0, col: 0 }, call })).toEqual({ kind: 'none', attempts: 0 })
    expect((await searchPane({ request: { paneId: 'p', query: 'a'.repeat(4097), direction: 'forward', from: 'viewport' }, viewportCursor: { row: 0, col: 0 }, call })).kind).toBe('error')
    expect((await searchPane({ request: { paneId: 'p', query: '가'.repeat(1366), direction: 'forward', from: 'viewport' }, viewportCursor: { row: 0, col: 0 }, call })).kind).toBe('error')
    expect(calls).toEqual([])
  })

  it('다음/이전은 현재 일치의 시작을 커서로, 그 일치를 previous 로 싣는다', async () => {
    const { call, calls } = recorder((method) => (method === 'pane.copy_motion' ? { content_revision: 8 } : { total: 2, current: 0, current_global: 1, matches: [range(9, 0, 9, 2)] }))
    const result = await searchPane({ request: { paneId: 'p', query: 'abc', direction: 'forward', from: range(3, 4, 3, 6) }, viewportCursor: { row: 99, col: 0 }, call })
    expect(result.kind).toBe('found')
    expect(calls.map((entry) => entry.method)).toEqual(['pane.copy_motion', 'pane.copy_search'])
    expect(calls[1]?.params).toEqual({ pane_id: 'p', query: 'abc', direction: 'forward', cursor: { row: 3, col: 4 }, previous: range(3, 4, 3, 6), content_revision: 8 })
  })

  it('stale_content 가 아닌 오류는 바로 오류다(다시 묻지 않는다)', async () => {
    const { call, calls } = recorder((method) => {
      if (method === 'pane.copy_search') throw Object.assign(new Error('boom'), { code: 'invalid_params' })
      return { content_revision: 1 }
    })
    expect(await searchPane({ request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, viewportCursor: { row: 0, col: 0 }, call })).toEqual({ kind: 'error', message: 'boom' })
    expect(calls).toHaveLength(2)
  })

  it(`재시도 상한은 ${SEARCH_ATTEMPTS}회 — 넘으면 busy`, async () => {
    const { call, calls } = recorder((method) => {
      if (method === 'pane.copy_search') throw Object.assign(new Error('pane content changed'), { code: 'stale_content' })
      return { content_revision: 1 }
    })
    expect(await searchPane({ request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, viewportCursor: { row: 0, col: 0 }, call })).toEqual({ kind: 'busy', attempts: SEARCH_ATTEMPTS })
    expect(calls.filter((entry) => entry.method === 'pane.copy_motion')).toHaveLength(SEARCH_ATTEMPTS)
  })

  it('revision 을 못 읽으면 검색을 보내지 않는다', async () => {
    const { call, calls } = recorder(() => ({}))
    expect((await searchPane({ request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, viewportCursor: { row: 0, col: 0 }, call })).kind).toBe('error')
    expect(calls.map((entry) => entry.method)).toEqual(['pane.copy_motion'])
  })
})
