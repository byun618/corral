// 내용 전체 검색 (LIFE-803 ⌘⇧F) — main·렌더러가 같이 쓰는 모양.
//
// 백엔드는 `git grep`(02-kickoff D1) — 범위는 ⌘P 기본과 같다(추적 + 미추적, ignore·바이너리 제외). 렌더러가 넘기는 것은 루트·질의·토글 3개·요청 id 뿐이고,
// 질의는 main 이 `-e <질의>` 한 칸으로만 git 에 넘긴다(셸 없음). 결과 경로는 루트 상대(`isSafeRel`), 열은 **UTF-16 코드 단위**(Monaco 열과 같은 단위).
import type { ExplorerRefusal } from './explorer.js'

/** 요청 id 형 — 렌더러가 만든 짧은 토큰(취소 키). */
export const CONTENT_SEARCH_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
/** 질의 길이 상한(UTF-16) — 입력칸 한 줄. */
export const CONTENT_SEARCH_QUERY_MAX = 1000

export type ContentSearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
export type ContentSearchInput = ContentSearchOptions & { root: string; query: string; requestId: string }

/** 미리보기 글 안의 일치 범위 — UTF-16 오프셋, `end` 는 제외. */
export type ContentSearchRange = { start: number; end: number }
/**
 * 일치 줄 하나. `line` 1부터, `column` = 그 줄 첫 일치의 UTF-16 열(1부터 — Monaco `setPosition` 그대로).
 * `preview` 는 줄 글(긴 줄은 첫 일치 둘레만 — `clippedStart`·`clippedEnd`), `ranges` 는 그 미리보기 기준. 일치 위치를 모르면 `ranges` 는 비고 강조하지 않는다.
 * `matches` = 그 줄의 일치 수(미리보기 밖 일치 포함, 모르면 1).
 */
export type ContentSearchLine = { line: number; column: number; preview: string; ranges: ContentSearchRange[]; matches: number; clippedStart: boolean; clippedEnd: boolean }
export type ContentSearchFile = { rel: string; lines: ContentSearchLine[] }

export type ContentSearchFailure = { ok: false; code: ExplorerRefusal | 'cancelled' | 'git_failed' | 'timeout'; error: string }
export type ContentSearchResult =
  | { ok: true; root: string; files: ContentSearchFile[]; lineCount: number; matchCount: number; truncated: boolean; ms: number }
  | ContentSearchFailure
