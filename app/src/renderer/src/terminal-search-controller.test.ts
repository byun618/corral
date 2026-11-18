// LIFE-812 C5 — 검색 막대 상태 표를 행마다 잰다. 규칙 하나: 응답은 적용 순간 「열려 있고 · 마지막으로 뗀 표」일 때만.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalRevealResult, TerminalSearchRequest, TerminalSearchResult, TerminalTextRange } from '../../shared/terminal-search.js'
import { SEARCH_DEBOUNCE_MS, TerminalSearchController, searchStatusText, type TerminalSearchState } from './terminal-search-controller.js'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const range = (row: number): TerminalTextRange => ({ start: { row, col: 0 }, end: { row, col: 2 } })
const found = (row: number, index: number): TerminalSearchResult => ({ kind: 'found', total: 9, index, current: range(row), matches: [range(row)], attempts: 1 })

function harness() {
  const searches: Array<{ request: TerminalSearchRequest; reply: Deferred<TerminalSearchResult> }> = []
  const reveals: Array<{ input: { paneId: string; row: number }; reply: Deferred<TerminalRevealResult> }> = []
  const states: TerminalSearchState[] = []
  const controller = new TerminalSearchController({
    paneId: 'p1',
    search: (request) => {
      const reply = deferred<TerminalSearchResult>()
      searches.push({ request, reply })
      return reply.promise
    },
    reveal: (input) => {
      const reply = deferred<TerminalRevealResult>()
      reveals.push({ input, reply })
      return reply.promise
    },
    onChange: (state) => states.push(state),
  })
  return { controller, searches, reveals, states }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('C5 상태 표', () => {
  it('열기 — 막대 열림, 질의 비어 있음, 요청 0', () => {
    const { controller, searches } = harness()
    controller.open()
    expect(controller.snapshot).toEqual({ open: true, query: '', result: null, pending: false, tooLong: false })
    expect(searches).toHaveLength(0)
  })

  it('질의 변경 — 지연 뒤 뷰포트 기준 새 질의 한 번(타자마다 아님)', () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('a')
    controller.setQuery('al')
    controller.setQuery('alp')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(searches.map((entry) => entry.request)).toEqual([{ paneId: 'p1', query: 'alp', direction: 'backward', from: 'viewport' }])
  })

  it('질의 변경 — 이전 질의의 늦은 응답은 버리고, 이전 결과(강조·k/총)는 바로 지운다', async () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('old')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[0]?.reply.resolve(found(5, 0))
    await flush()
    expect(controller.snapshot.result?.kind).toBe('found')
    controller.setQuery('older')
    expect(controller.snapshot.result).toBeNull()
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    controller.setQuery('new')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[2]?.reply.resolve(found(7, 1))
    await flush()
    searches[1]?.reply.resolve(found(99, 4)) // 「older」 응답이 늦게 왔다
    await flush()
    expect(controller.snapshot.result).toEqual(found(7, 1))
  })

  it('검색 응답 — 적용하면 결과로 이동을 요청한다', async () => {
    const { controller, searches, reveals } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[0]?.reply.resolve(found(12, 3))
    await flush()
    expect(searchStatusText(controller.snapshot)).toBe('4 / 9')
    expect(reveals.map((entry) => entry.input)).toEqual([{ paneId: 'p1', row: 12 }])
  })

  it('다음/이전 — 현재 일치에서 이어 묻고, 순서가 뒤바뀐 응답은 마지막 것만 적용한다', async () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[0]?.reply.resolve(found(10, 2))
    await flush()
    controller.step('forward')
    expect(searches[1]?.request).toEqual({ paneId: 'p1', query: 'x', direction: 'forward', from: range(10) })
    controller.step('backward')
    expect(searches[2]?.request.direction).toBe('backward')
    searches[2]?.reply.resolve(found(8, 1))
    await flush()
    searches[1]?.reply.resolve(found(11, 3))
    await flush()
    expect(controller.snapshot.result).toEqual(found(8, 1))
  })

  it('다음/이전 — 결과가 없거나 바빴으면(busy) 처음부터 다시 묻는다(C4ⓗ 재시도 경로)', async () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[0]?.reply.resolve({ kind: 'busy', attempts: 4 })
    await flush()
    expect(searchStatusText(controller.snapshot)).toContain('출력이 계속 바뀌어')
    controller.step('forward')
    expect(searches[1]?.request).toEqual({ paneId: 'p1', query: 'x', direction: 'backward', from: 'viewport' })
  })

  it('스크롤(이동) 응답 — 막대를 닫은 뒤 와도 아무것도 바꾸지 않는다', async () => {
    const { controller, searches, reveals, states } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[0]?.reply.resolve(found(3, 0))
    await flush()
    controller.close()
    const count = states.length
    reveals[0]?.reply.resolve({ scrolled: true, top: 0 })
    await flush()
    expect(states).toHaveLength(count)
    expect(controller.snapshot.open).toBe(false)
  })

  it('Esc 닫기 — 결과·대기 요청의 적용 권리를 지운다', async () => {
    const { controller, searches, reveals } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    controller.close()
    searches[0]?.reply.resolve(found(3, 0))
    await flush()
    expect(controller.snapshot).toEqual({ open: false, query: '', result: null, pending: false, tooLong: false })
    expect(reveals).toHaveLength(0)
  })

  it('닫기 — 지연 중인 질의도 보내지 않는다', () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('x')
    controller.close()
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(searches).toHaveLength(0)
  })

  it('탭 전환·pane 닫힘·worktree 전환(버리기) — 대기 요청은 적용되지 않고 알림도 없다', async () => {
    const { controller, searches, reveals, states } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    controller.dispose()
    const count = states.length
    searches[0]?.reply.resolve(found(3, 0))
    await flush()
    expect(states).toHaveLength(count)
    expect(reveals).toHaveLength(0)
    controller.open()
    controller.setQuery('y')
    expect(states).toHaveLength(count)
  })
})

describe('C4ⓕ·C1ⓔ — 빈 질의·상한 초과는 요청 0', () => {
  it('빈 질의 — 결과(강조) 0·요청 0', () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('a')
    controller.setQuery('')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    controller.step('forward')
    expect(searches).toHaveLength(0)
    expect(controller.snapshot.result).toBeNull()
  })
  it('4096바이트 초과 — 막대가 거절 문구를 보이고 요청하지 않는다', () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('가'.repeat(1366))
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    controller.step('forward')
    expect(searches).toHaveLength(0)
    expect(searchStatusText(controller.snapshot)).toBe('검색어가 너무 깁니다')
  })
})

describe('searchStatusText', () => {
  it('없음·오류·대기', () => {
    const base: TerminalSearchState = { open: true, query: 'x', result: null, pending: true, tooLong: false }
    expect(searchStatusText(base)).toBe('찾는 중…')
    expect(searchStatusText({ ...base, pending: false, result: { kind: 'none', attempts: 1 } })).toBe('결과 없음')
    expect(searchStatusText({ ...base, pending: false, result: { kind: 'error', message: 'x' } })).toBe('검색 실패')
  })
})
