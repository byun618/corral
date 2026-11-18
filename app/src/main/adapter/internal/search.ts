// LIFE-812 — 터미널 스크롤백 검색의 서버 왕복 (herdr 0.9.0 `pane.copy_search`).
//
// 실측(corral-specs LIFE-812 00-analysis §4·raw/claude/probe):
//   · `copy_search` 는 활성 화면 전체(스크롤백 포함)를 리터럴·smart-case 로 찾는다. 행 0 = 스크롤백 맨 위, 열 = 셀(넓은 글자 2칸), 끝 포함
//   · `direction: forward` = 커서 **뒤** 첫 일치, `backward` = 커서 **앞** 마지막 일치 — 끝에서 감긴다
//   · 일치 목록은 현재 일치 주변 최대 1024개, `total`·`current_global` 은 정확하다
//   · `content_revision` 이 지금 내용과 다르면 `stale_content` 로 거절한다 — 값은 `copy_motion` 응답에서 얻는다
// 그래서 한 번의 검색 = (`copy_motion` 으로 revision → `copy_search`) 이고, 거절되면 상한까지 처음부터 다시 한다.
// 출력이 쉬지 않고 흐르는 pane 은 상한에 닿을 수 있다 — 그때는 `busy` 로 돌려 막대가 상태를 보인다(무한 반복·무음 실패 0).

import {
  TERMINAL_SEARCH_MAX_QUERY_BYTES,
  queryBytes,
  type TerminalSearchRequest,
  type TerminalSearchResult,
  type TerminalTextPoint,
  type TerminalTextRange,
} from '../../../shared/terminal-search.js'

/** 재시도 상한 — 첫 시도 포함. */
export const SEARCH_ATTEMPTS = 4

/** endpoint 메서드 하나 부르기 — 광고 확인·줄 세우기·시간 상한은 부르는 쪽(GroupSession)이 진다. */
export type SearchCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

const STALE = 'stale_content'

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function readPoint(value: unknown): TerminalTextPoint | null {
  const row = readCount(field(value, 'row'))
  const col = readCount(field(value, 'col'))
  return row === null || col === null ? null : { row, col }
}

function readRange(value: unknown): TerminalTextRange | null {
  const start = readPoint(field(value, 'start'))
  const end = readPoint(field(value, 'end'))
  return start === null || end === null ? null : { start, end }
}

function errorCode(error: unknown): string | null {
  const code = field(error, 'code')
  return typeof code === 'string' ? code : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `copy_search` 응답 → 결과. 모양이 어긋나면 null(오류로 올린다). */
export function readSearchResponse(value: unknown, attempts: number): TerminalSearchResult | null {
  const total = readCount(field(value, 'total'))
  const raw = field(value, 'matches')
  if (total === null || !Array.isArray(raw)) return null
  if (total === 0) return { kind: 'none', attempts }
  const matches: TerminalTextRange[] = []
  for (const item of raw) {
    const range = readRange(item)
    if (range === null) return null
    matches.push(range)
  }
  const local = readCount(field(value, 'current'))
  const index = readCount(field(value, 'current_global'))
  const current = local === null ? undefined : matches[local]
  if (index === null || current === undefined) return null
  return { kind: 'found', total, index, current, matches, attempts }
}

export async function searchPane(input: {
  request: TerminalSearchRequest
  /** `from: 'viewport'` 일 때 커서 — 뷰포트 바닥 바로 아래(그 위로 가장 가까운 일치를 찾는다). */
  viewportCursor: TerminalTextPoint
  call: SearchCall
}): Promise<TerminalSearchResult> {
  const { request } = input
  if (request.query === '') return { kind: 'none', attempts: 0 }
  if (queryBytes(request.query) > TERMINAL_SEARCH_MAX_QUERY_BYTES) return { kind: 'error', message: '검색어가 너무 깁니다' }
  const cursor = request.from === 'viewport' ? input.viewportCursor : request.from.start
  const previous = request.from === 'viewport' ? null : request.from
  for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
    try {
      const motion = await input.call('pane.copy_motion', { pane_id: request.paneId, cursor: { row: 0, col: 0 }, motion: 'line_end' })
      const revision = readCount(field(motion, 'content_revision'))
      if (revision === null) return { kind: 'error', message: '검색 기준(revision)을 읽지 못했습니다' }
      const response = await input.call('pane.copy_search', {
        pane_id: request.paneId,
        query: request.query,
        direction: request.direction,
        cursor,
        previous,
        content_revision: revision,
      })
      return readSearchResponse(response, attempt) ?? { kind: 'error', message: '검색 응답을 읽지 못했습니다' }
    } catch (error) {
      if (errorCode(error) === STALE) continue
      return { kind: 'error', message: errorMessage(error) }
    }
  }
  return { kind: 'busy', attempts: SEARCH_ATTEMPTS }
}
