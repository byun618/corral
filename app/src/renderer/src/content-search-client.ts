// 내용 전체 검색 요청 (LIFE-803) — main `corral:contentSearch` 를 부르고, 돌려주는 `cancel` 은 진행 중이면 main 의 git 을 끝낸다.
// 취소한 요청은 늦게 ok 가 와도 `cancelled` 다(적용 여부는 부르는 쪽 세션이 세대로 한 번 더 본다 — `content-search-session.ts`).
import type { ContentSearchInput, ContentSearchResult } from '../../shared/content-search.js'

let sequence = 0

export function requestContentSearch(input: Omit<ContentSearchInput, 'requestId'>): { result: Promise<ContentSearchResult>; cancel: () => void } {
  sequence += 1
  const requestId = `cs-${Date.now().toString(36)}-${sequence}`
  let settled = false
  let cancelled = false
  const result = window.corral.contentSearch({ ...input, requestId }).then(
    (value): ContentSearchResult => {
      settled = true
      return cancelled ? { ok: false, code: 'cancelled', error: '취소됨' } : value
    },
    (error: unknown): ContentSearchResult => {
      settled = true
      return { ok: false, code: 'io_error', error: String(error) }
    },
  )
  return {
    result,
    cancel: () => {
      cancelled = true
      if (!settled) window.corral.contentSearchCancel(requestId)
    },
  }
}
