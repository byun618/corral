// 터미널 화면 내 검색 (LIFE-812) — 렌더러·main 이 같이 쓰는 어휘와 순수 계산.
//
// 검색은 서버(herdr)가 한다 — xterm 은 scrollback 0 이라 뷰포트밖에 모른다. 서버는 **스크롤백 전체**를 리터럴·smart-case 로
// 찾아 절대 행(0 = 스크롤백 맨 위)·셀 열(넓은 글자 2칸, 끝 포함)로 돌려준다. 일치 목록은 현재 일치 주변 최대 1024개 창이고
// 총 개수는 정확하다. 여기 있는 것은 그 결과를 **뷰포트 셀**로 옮기는 계산과 스크롤 오프셋 계산뿐이다.

/** 서버 질의 상한(바이트) — 넘으면 요청하지 않고 막대에서 거절한다(C1ⓔ). */
export const TERMINAL_SEARCH_MAX_QUERY_BYTES = 4096

export type TerminalTextPoint = { row: number; col: number }
/** 일치 하나 — 시작·끝 모두 포함. 끝 행이 시작 행보다 뒤면 줄이 감겨 이어진 일치다. */
export type TerminalTextRange = { start: TerminalTextPoint; end: TerminalTextPoint }

/**
 * 검색 요청. `from` 이 `'viewport'` 면 지금 뷰포트 바닥에서 위로 가장 가까운 일치(새 질의),
 * 일치 범위면 그 일치 다음(`forward`)·이전(`backward`) — 끝에서 감긴다.
 */
export type TerminalSearchRequest = {
  paneId: string
  query: string
  direction: 'forward' | 'backward'
  from: 'viewport' | TerminalTextRange
}

/** 재시도 계수 — 출력이 바뀌어 거절된 횟수까지 센다(C7ⓒ). */
export type TerminalSearchAttempts = { attempts: number }

export type TerminalSearchResult =
  | ({
      kind: 'found'
      total: number
      /** 현재 일치의 전체 순번(0-기반). 표시는 `index + 1 / total`. */
      index: number
      current: TerminalTextRange
      /** 현재 일치 주변의 일치 창(최대 1024) — 강조는 이 안에서 보이는 것만. */
      matches: TerminalTextRange[]
    } & TerminalSearchAttempts)
  | ({ kind: 'none' } & TerminalSearchAttempts)
  /** 출력이 계속 바뀌어 재시도 상한까지 거절됐다(C4ⓗ). */
  | ({ kind: 'busy' } & TerminalSearchAttempts)
  | { kind: 'error'; message: string }

/** 결과로 이동 — `top` 은 이동 뒤 뷰포트 맨 위의 절대 행. 스크롤 상태를 모르는 pane(alt-screen 등)은 `null`. */
export type TerminalRevealResult = { scrolled: boolean; top: number | null }

/** pane 의 스크롤 상태 — 서버 서피스가 준 값. */
export type TerminalScrollState = { offsetFromBottom: number; maxOffsetFromBottom: number }

export function queryBytes(query: string): number {
  return new TextEncoder().encode(query).length
}

/** 뷰포트 맨 위의 절대 행 — 보이는 행은 `[top, top + rows − 1]`. */
export function viewportTop(scroll: TerminalScrollState): number {
  return scroll.maxOffsetFromBottom - scroll.offsetFromBottom
}

/**
 * `row` 를 보이게 하는 스크롤 오프셋. 이미 보이면 `null`(스크롤 요청 0 — C2).
 * 보이지 않으면 그 행이 뷰포트 가운데쯤 오게 두고 `[0, max]` 로 자른다 — 스크롤백 맨 위·바닥 근처에서도 행은 보인다(C2ⓒ).
 */
export function revealOffset(input: { row: number; scroll: TerminalScrollState; rows: number }): number | null {
  const top = viewportTop(input.scroll)
  if (input.row >= top && input.row <= top + input.rows - 1) return null
  const offset = input.scroll.maxOffsetFromBottom - input.row + Math.floor(input.rows / 2)
  return Math.max(0, Math.min(input.scroll.maxOffsetFromBottom, offset))
}

/** 뷰포트 셀 위의 강조 조각 하나 — 행·열은 뷰포트 기준 0-기반, `width` 는 셀 수. */
export type HighlightSegment = { row: number; col: number; width: number; current: boolean }

const sameRange = (a: TerminalTextRange, b: TerminalTextRange): boolean =>
  a.start.row === b.start.row && a.start.col === b.start.col && a.end.row === b.end.row && a.end.col === b.end.col

/**
 * 일치 → 뷰포트 셀 조각 (C3). 감긴 일치는 행마다 한 조각 — 시작 행은 시작 열부터 줄 끝까지, 가운데 행은 한 줄 전체,
 * 끝 행은 0 열부터 끝 열까지. 뷰포트 밖 행은 버리고, 열은 `[0, cols)` 로 자른다.
 */
export function highlightSegments(input: {
  matches: readonly TerminalTextRange[]
  current: TerminalTextRange | null
  top: number
  rows: number
  cols: number
}): HighlightSegment[] {
  const segments: HighlightSegment[] = []
  const bottom = input.top + input.rows - 1
  for (const match of input.matches) {
    if (match.end.row < input.top || match.start.row > bottom) continue
    const current = input.current !== null && sameRange(match, input.current)
    for (let row = Math.max(match.start.row, input.top); row <= Math.min(match.end.row, bottom); row++) {
      const from = row === match.start.row ? match.start.col : 0
      const to = row === match.end.row ? match.end.col : input.cols - 1
      const col = Math.max(0, from)
      const last = Math.min(input.cols - 1, to)
      if (last < col) continue
      segments.push({ row: row - input.top, col, width: last - col + 1, current })
    }
  }
  return segments
}

/** smart-case — 대문자가 하나라도 있으면 대소문자를 가린다(herdr 규칙 그대로, 막대 안내용 — C4ⓖ). */
export function isCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase()
}

function readCell(value: unknown, key: string): number | null {
  const found = value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined
  return typeof found === 'number' && Number.isInteger(found) && found >= 0 ? found : null
}

function readRangeInput(value: unknown): TerminalTextRange | null {
  const start = value !== null && typeof value === 'object' ? Reflect.get(value, 'start') : undefined
  const end = value !== null && typeof value === 'object' ? Reflect.get(value, 'end') : undefined
  const startRow = readCell(start, 'row')
  const startCol = readCell(start, 'col')
  const endRow = readCell(end, 'row')
  const endCol = readCell(end, 'col')
  if (startRow === null || startCol === null || endRow === null || endCol === null) return null
  return { start: { row: startRow, col: startCol }, end: { row: endRow, col: endCol } }
}

/** IPC 경계 검증 — renderer 가 보낸 검색 요청의 모양을 main 이 다시 본다. 어긋나면 null. */
export function parseSearchRequest(value: unknown): TerminalSearchRequest | null {
  if (value === null || typeof value !== 'object') return null
  const paneId = Reflect.get(value, 'paneId')
  const query = Reflect.get(value, 'query')
  const direction = Reflect.get(value, 'direction')
  const from = Reflect.get(value, 'from')
  if (typeof paneId !== 'string' || typeof query !== 'string') return null
  if (direction !== 'forward' && direction !== 'backward') return null
  if (from === 'viewport') return { paneId, query, direction, from }
  const range = readRangeInput(from)
  return range === null ? null : { paneId, query, direction, from: range }
}

/** IPC 경계 검증 — 결과로 이동 요청. */
export function parseRevealRequest(value: unknown): { paneId: string; row: number } | null {
  if (value === null || typeof value !== 'object') return null
  const paneId = Reflect.get(value, 'paneId')
  const row = readCell(value, 'row')
  return typeof paneId === 'string' && row !== null ? { paneId, row } : null
}
