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
const found = (row: number, index: number, token = 1): TerminalSearchResult => ({ kind: 'found', total: 9, index, current: range(row), matches: [range(row)], attempts: 1, token })

function harness() {
  const searches: Array<{ request: TerminalSearchRequest; reply: Deferred<TerminalSearchResult> }> = []
  const reveals: Array<{ input: { paneId: string; row: number; token: number }; reply: Deferred<TerminalRevealResult> }> = []
  const cancels: number[] = []
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
    cancel: () => cancels.push(searches.length),
    onChange: (state) => states.push(state),
  })
  return { controller, searches, reveals, states, cancels }
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
    searches[0]?.reply.resolve(found(12, 3, 41))
    await flush()
    expect(searchStatusText(controller.snapshot)).toBe('4 / 9')
    // 이동 요청은 그 결과를 낸 검색의 표를 싣는다 — main 이 적용 시점에 그 표로 낡음을 가른다(fix1 R1-4)
    expect(reveals.map((entry) => entry.input)).toEqual([{ paneId: 'p1', row: 12, token: 41 }])
  })

  it('다음/이전 — 현재 일치에서 이어 묻고, 대기 중 누른 것은 응답의 현재 일치에서 이어 묻는다', async () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[0]?.reply.resolve(found(10, 2))
    await flush()
    controller.step('forward')
    expect(searches[1]?.request).toEqual({ paneId: 'p1', query: 'x', direction: 'forward', from: range(10) })
    controller.step('backward')
    expect(searches).toHaveLength(2) // 대기 중 — 낡은 현재 일치(10)에서 다시 묻지 않는다
    searches[1]?.reply.resolve(found(11, 3))
    await flush()
    expect(searches[2]?.request).toEqual({ paneId: 'p1', query: 'x', direction: 'backward', from: range(11) })
    searches[2]?.reply.resolve(found(10, 2))
    await flush()
    expect(controller.snapshot.result).toEqual(found(10, 2))
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

  it('스크롤(이동) 응답 — 닫은 뒤에는 main 에 취소를 보내 이미 보낸 이동도 낡게 한다(fix1 R1-4ⓑ)', async () => {
    const { controller, searches, reveals, cancels } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    searches[0]?.reply.resolve(found(3, 0, 5))
    await flush()
    expect(reveals.map((entry) => entry.input.token)).toEqual([5])
    expect(cancels).toEqual([])
    controller.close()
    // 이동 요청을 낸 뒤 닫았다 — 취소가 한 번 나가 main 이 그 표(5)의 이동을 버린다
    expect(cancels).toEqual([1])
  })

  it('Esc 닫기 — 결과·대기 요청의 적용 권리를 지우고 main 에도 취소를 보낸다', async () => {
    const { controller, searches, reveals, cancels } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    controller.close()
    searches[0]?.reply.resolve(found(3, 0))
    await flush()
    expect(controller.snapshot).toEqual({ open: false, query: '', result: null, pending: false, tooLong: false })
    expect(reveals).toHaveLength(0)
    expect(cancels).toEqual([1])
  })

  it('닫기 — 지연 중인 질의도 보내지 않는다, 보낸 것이 없으면 취소 IPC 도 없다', () => {
    const { controller, searches, cancels } = harness()
    controller.open()
    controller.setQuery('x')
    controller.close()
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(searches).toHaveLength(0)
    expect(cancels).toEqual([])
  })

  it('질의 변경 — 앞 질의를 보냈으면 main 에 취소를 보낸다(재시도·이동을 멈춘다 — fix1 R1-2·R1-4)', async () => {
    const { controller, searches, cancels } = harness()
    controller.open()
    controller.setQuery('a')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(searches).toHaveLength(1)
    controller.setQuery('ab')
    expect(cancels).toEqual([1])
  })

  it('fix1 R1-3 — 응답보다 빨리 누른 다음 n 번은 n 칸 간다(감기 포함), 이동 요청은 마지막 한 번', async () => {
    // 리뷰어 burst.mts 와 같은 꼴: 가짜 서버가 from 의 다음 행(9 다음은 0 — 감기)을 30ms 뒤 돌려준다, 5ms 간격으로 5번 누른다
    const rows = 10
    const served: number[] = []
    const reveals: number[] = []
    const controller = new TerminalSearchController({
      paneId: 'p1',
      search: (request) => new Promise((resolve) => {
        const row = request.from === 'viewport' ? 7 : (request.from.start.row + (request.direction === 'forward' ? 1 : rows - 1)) % rows
        served.push(row)
        setTimeout(() => resolve(found(row, row)), 30)
      }),
      reveal: async (input) => {
        reveals.push(input.row)
        return { scrolled: true, top: 0 }
      },
      cancel: () => {},
      onChange: () => {},
    })
    controller.open()
    controller.setQuery('x')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 30)
    expect(controller.snapshot.result).toEqual(found(7, 7))
    for (let i = 0; i < 5; i++) {
      controller.step('forward')
      await vi.advanceTimersByTimeAsync(5)
    }
    await vi.advanceTimersByTimeAsync(30 * 6)
    expect(served).toEqual([7, 8, 9, 0, 1, 2])
    expect(controller.snapshot.result).toEqual(found(2, 2))
    expect(reveals).toEqual([7, 2])
    // 이전 방향도 같은 규칙
    controller.step('backward')
    controller.step('backward')
    await vi.advanceTimersByTimeAsync(30 * 3)
    expect(controller.snapshot.result).toEqual(found(0, 0))
  })

  it('fix1 R1-3 — 쌓인 다음/이전은 닫기·질의 변경·결과 없음에서 버린다', async () => {
    const { controller, searches } = harness()
    controller.open()
    controller.setQuery('x')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    controller.step('forward')
    controller.step('forward')
    searches[0]?.reply.resolve({ kind: 'none', attempts: 1 })
    await flush()
    expect(searches).toHaveLength(1)
    controller.step('forward') // 결과 없음 → 처음부터 다시
    controller.step('forward') // 대기 중 → 쌓임
    controller.setQuery('y') // 쌓인 것 버림
    searches[1]?.reply.resolve(found(4, 0))
    await flush()
    expect(searches).toHaveLength(2)
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
