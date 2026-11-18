// LIFE-812 — 터미널 검색의 순수 계산: 오프셋(C2)·강조 셀(C3)·질의 상한(C1ⓔ)·IPC 검증.
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_SEARCH_MAX_QUERY_BYTES,
  highlightSegments,
  isCaseSensitive,
  parseRevealRequest,
  parseSearchRequest,
  queryBytes,
  revealOffset,
  viewportTop,
} from './terminal-search.js'

const range = (row: number, col: number, endRow: number, endCol: number) => ({ start: { row, col }, end: { row: endRow, col: endCol } })

describe('revealOffset (C2) — 실측 B4: top = max − offset', () => {
  const scroll = { offsetFromBottom: 0, maxOffsetFromBottom: 2962 }
  it('보이는 행이면 null — 스크롤 요청 0', () => {
    expect(viewportTop(scroll)).toBe(2962)
    expect(revealOffset({ row: 2962, scroll, rows: 40 })).toBeNull()
    expect(revealOffset({ row: 3001, scroll, rows: 40 })).toBeNull()
  })
  it('일반 경우(ⓐ) — 행이 가운데쯤, 뷰포트 안', () => {
    const offset = revealOffset({ row: 100, scroll, rows: 40 })
    expect(offset).toBe(2962 - 100 + 20)
    const top = 2962 - (offset ?? 0)
    expect(100).toBeGreaterThanOrEqual(top)
    expect(100).toBeLessThanOrEqual(top + 39)
  })
  it('스크롤백 맨 위 근처(ⓒ) — max 로 자르고 행은 보인다', () => {
    expect(revealOffset({ row: 3, scroll, rows: 40 })).toBe(2962)
  })
  it('바닥 근처 — 0 으로 자른다(위로 스크롤된 상태에서 마지막 행)', () => {
    expect(revealOffset({ row: 3001, scroll: { offsetFromBottom: 500, maxOffsetFromBottom: 2962 }, rows: 40 })).toBe(0)
  })
})

describe('highlightSegments (C3) — 일치 → 뷰포트 셀', () => {
  it('ASCII(ⓐ) — 행·열 그대로, 현재 일치 구분', () => {
    const matches = [range(100, 0, 100, 8), range(101, 2, 101, 4)]
    expect(highlightSegments({ matches, current: matches[1] ?? null, top: 90, rows: 40, cols: 99 })).toEqual([
      { row: 10, col: 0, width: 9, current: false },
      { row: 11, col: 2, width: 3, current: true },
    ])
  })
  it('한글(ⓑ) — 서버 열은 셀 열이라 넓은 글자 2칸이 그대로 폭이 된다(실측: 「한글」 = 0..3)', () => {
    expect(highlightSegments({ matches: [range(0, 0, 0, 3)], current: null, top: 0, rows: 4, cols: 99 })).toEqual([{ row: 0, col: 0, width: 4, current: false }])
  })
  it('감긴 일치(ⓒ) — 시작 행은 줄 끝까지, 끝 행은 0 열부터(실측 CROSSNEEDLE 6:95–7:6)', () => {
    expect(highlightSegments({ matches: [range(6, 95, 7, 6)], current: null, top: 0, rows: 40, cols: 99 })).toEqual([
      { row: 6, col: 95, width: 4, current: false },
      { row: 7, col: 0, width: 7, current: false },
    ])
  })
  it('세 줄에 걸친 일치 — 가운데 줄은 한 줄 전체', () => {
    expect(highlightSegments({ matches: [range(1, 8, 3, 1)], current: null, top: 0, rows: 5, cols: 10 }).map((segment) => [segment.row, segment.col, segment.width])).toEqual([[1, 8, 2], [2, 0, 10], [3, 0, 2]])
  })
  it('스크롤(ⓓⓔ) — top 이 n 바뀌면 같은 일치가 n 행 옮겨 그려진다, 뷰포트 밖은 버린다', () => {
    const matches = [range(50, 1, 50, 2)]
    expect(highlightSegments({ matches, current: null, top: 45, rows: 10, cols: 10 })).toEqual([{ row: 5, col: 1, width: 2, current: false }])
    expect(highlightSegments({ matches, current: null, top: 48, rows: 10, cols: 10 })).toEqual([{ row: 2, col: 1, width: 2, current: false }])
    expect(highlightSegments({ matches, current: null, top: 51, rows: 10, cols: 10 })).toEqual([])
    // 감긴 일치의 앞 행만 뷰포트 위로 나간 경우 — 보이는 행만
    expect(highlightSegments({ matches: [range(6, 8, 7, 1)], current: null, top: 7, rows: 3, cols: 10 })).toEqual([{ row: 0, col: 0, width: 2, current: false }])
  })
})

describe('질의 상한 (C1ⓔ)·smart-case 안내 (C4ⓖ)', () => {
  it('바이트로 센다 — 한글 한 글자 3바이트', () => {
    expect(queryBytes('가')).toBe(3)
    expect(queryBytes('a'.repeat(TERMINAL_SEARCH_MAX_QUERY_BYTES))).toBe(4096)
  })
  it('대문자가 있으면 대소문자 구분', () => {
    expect(isCaseSensitive('alpha')).toBe(false)
    expect(isCaseSensitive('Alpha')).toBe(true)
    expect(isCaseSensitive('한글')).toBe(false)
  })
})

describe('IPC 검증', () => {
  it('검색 요청 — 모양이 맞을 때만', () => {
    expect(parseSearchRequest({ paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' })).toEqual({ paneId: 'p', query: 'a', direction: 'forward', from: 'viewport' })
    expect(parseSearchRequest({ paneId: 'p', query: 'a', direction: 'backward', from: range(1, 2, 3, 4) })).toEqual({ paneId: 'p', query: 'a', direction: 'backward', from: range(1, 2, 3, 4) })
    expect(parseSearchRequest({ paneId: 'p', query: 'a', direction: 'up', from: 'viewport' })).toBeNull()
    expect(parseSearchRequest({ paneId: 'p', query: 1, direction: 'forward', from: 'viewport' })).toBeNull()
    expect(parseSearchRequest({ paneId: 'p', query: 'a', direction: 'forward', from: { start: { row: 1, col: 0 } } })).toBeNull()
    expect(parseSearchRequest(null)).toBeNull()
  })
  it('이동 요청', () => {
    expect(parseRevealRequest({ paneId: 'p', row: 3 })).toEqual({ paneId: 'p', row: 3 })
    expect(parseRevealRequest({ paneId: 'p', row: -1 })).toBeNull()
    expect(parseRevealRequest({ paneId: 'p', row: 1.5 })).toBeNull()
  })
})
