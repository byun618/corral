// LIFE-812 — 검색 왕복(searchPane)·응답 해석. 서버 없이 부르는 쪽을 가짜로 둔다.
import { describe, expect, it } from 'vitest'
import { SEARCH_ATTEMPTS, SEARCH_RETRY_DELAYS_MS, readSearchResponse, searchPane, type SearchCall } from './search.js'

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

/** 기다림을 기록만 하고 바로 넘어간다. */
function waits(): { wait: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = []
  return { slept, wait: async (ms) => { slept.push(ms) } }
}

const stale = (): Error => Object.assign(new Error('pane content changed'), { code: 'stale_content' })
const base = { viewportCursor: { row: 0, col: 0 }, token: 7, alive: () => true }

describe('readSearchResponse', () => {
  it('창 안의 현재 일치(current)와 전체 순번(current_global)을 가르고 표를 싣는다', () => {
    const value = { total: 3001, current: 1, current_global: 1500, matches: [range(1499, 10, 1499, 14), range(1500, 10, 1500, 14)] }
    expect(readSearchResponse(value, { attempts: 2, token: 9 })).toEqual({ kind: 'found', total: 3001, index: 1500, current: range(1500, 10, 1500, 14), matches: value.matches, attempts: 2, token: 9 })
  })
  it('0건이면 none', () => {
    expect(readSearchResponse({ total: 0, matches: [] }, { attempts: 1, token: 1 })).toEqual({ kind: 'none', attempts: 1 })
  })
  it('모양이 어긋나면 null', () => {
    const at = { attempts: 1, token: 1 }
    expect(readSearchResponse({ total: 1, matches: [{ start: { row: -1, col: 0 }, end: { row: 0, col: 0 } }], current: 0, current_global: 0 }, at)).toBeNull()
    expect(readSearchResponse({ total: 1, matches: [], current: 0, current_global: 0 }, at)).toBeNull()
    expect(readSearchResponse(null, at)).toBeNull()
  })
})

describe('searchPane', () => {
  it('빈 질의·상한 초과는 묻지 않는다(C4ⓕ·C1ⓔ)', async () => {
    const { call, calls } = recorder(() => ({}))
    expect(await searchPane({ ...base, request: { paneId: 'p', query: '', direction: 'forward', from: 'viewport' }, call })).toEqual({ kind: 'none', attempts: 0 })
    expect((await searchPane({ ...base, request: { paneId: 'p', query: 'a'.repeat(4097), direction: 'forward', from: 'viewport' }, call })).kind).toBe('error')
    expect((await searchPane({ ...base, request: { paneId: 'p', query: '가'.repeat(1366), direction: 'forward', from: 'viewport' }, call })).kind).toBe('error')
    expect(calls).toEqual([])
  })

  it('다음/이전은 현재 일치의 시작을 커서로, 그 일치를 previous 로 싣는다', async () => {
    const { call, calls } = recorder((method) => (method === 'pane.copy_motion' ? { content_revision: 8 } : { total: 2, current: 0, current_global: 1, matches: [range(9, 0, 9, 2)] }))
    const result = await searchPane({ ...base, viewportCursor: { row: 99, col: 0 }, request: { paneId: 'p', query: 'abc', direction: 'forward', from: range(3, 4, 3, 6) }, call })
    expect(result).toMatchObject({ kind: 'found', token: 7 })
    expect(calls.map((entry) => entry.method)).toEqual(['pane.copy_motion', 'pane.copy_search'])
    expect(calls[1]?.params).toEqual({ pane_id: 'p', query: 'abc', direction: 'forward', cursor: { row: 3, col: 4 }, previous: range(3, 4, 3, 6), content_revision: 8 })
  })

  it('stale_content 가 아닌 오류는 바로 오류다(다시 묻지 않는다)', async () => {
    const { call, calls } = recorder((method) => {
      if (method === 'pane.copy_search') throw Object.assign(new Error('boom'), { code: 'invalid_params' })
      return { content_revision: 1 }
    })
    expect(await searchPane({ ...base, request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, call })).toEqual({ kind: 'error', message: 'boom' })
    expect(calls).toHaveLength(2)
  })

  it(`재시도 상한은 ${SEARCH_ATTEMPTS}회 — 사이마다 점증 대기(합 ≤ 1초), 넘으면 busy (fix1 R1-2)`, async () => {
    const { call, calls } = recorder((method) => {
      if (method === 'pane.copy_search') throw stale()
      return { content_revision: 1 }
    })
    const { wait, slept } = waits()
    expect(await searchPane({ ...base, wait, request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, call })).toEqual({ kind: 'busy', attempts: SEARCH_ATTEMPTS })
    expect(calls.filter((entry) => entry.method === 'pane.copy_motion')).toHaveLength(SEARCH_ATTEMPTS)
    expect(slept).toEqual([50, 100, 200, 400])
    expect(slept).toEqual([...SEARCH_RETRY_DELAYS_MS])
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1000)
  })

  it('첫 시도는 기다리지 않는다', async () => {
    const { call } = recorder((method) => (method === 'pane.copy_motion' ? { content_revision: 1 } : { total: 0, matches: [] }))
    const { wait, slept } = waits()
    expect(await searchPane({ ...base, wait, request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, call })).toEqual({ kind: 'none', attempts: 1 })
    expect(slept).toEqual([])
  })

  it('새 검색·취소로 낡으면 다음 시도를 하지 않는다 — 버려진 검색이 서버에 계속 묻지 않는다 (fix1 R1-2)', async () => {
    let live = true
    const { call, calls } = recorder((method) => {
      if (method === 'pane.copy_search') {
        live = false // 첫 거절 직후 새 질의가 들어왔다
        throw stale()
      }
      return { content_revision: 1 }
    })
    const { wait } = waits()
    expect(await searchPane({ ...base, wait, alive: () => live, request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, call })).toEqual({ kind: 'cancelled', attempts: 1 })
    expect(calls.map((entry) => entry.method)).toEqual(['pane.copy_motion', 'pane.copy_search'])
  })

  it('revision 을 못 읽으면 검색을 보내지 않는다', async () => {
    const { call, calls } = recorder(() => ({}))
    expect((await searchPane({ ...base, request: { paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' }, call })).kind).toBe('error')
    expect(calls.map((entry) => entry.method)).toEqual(['pane.copy_motion'])
  })
})
