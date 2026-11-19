// PR 코멘트 구독 (LIFE-811 C8·C9) — 「PR」 보기가 보일 때만, 대상(활성 worktree 경로 + 브랜치)이 바뀔 때 main 에 묻는다. 상시 타이머 없음.
// 같은 대상을 다시 열면 main 의 TTL 캐시가 gh 를 막는다. 새로고침 단추만 TTL 을 무시한다.
// 대상에 브랜치를 넣는다(리뷰 r1 A1) — 같은 worktree 에서 브랜치(→ PR)가 바뀌면 다시 묻고, 바뀌기 전 요청의 응답은 버린다.
// main 에는 경로만 넘긴다 — 브랜치·PR 은 main 이 지금 트리에서 다시 푼다(C1).
//
// 늦은 응답(C9 상태 표 — `.agents/rules/coding.md` 비동기 적용 규칙):
//   · 세우는 것: 보기 내용 = 「현재 대상」 의 **마지막 요청**의 응답
//   · 지우는 것: 현재 대상이 실제로 바뀔 때만 이전 내용을 지운다(같은 대상 재조회·새로고침 중에는 이전 내용 + 불러오는 중 표지)
//   · 적용 시점: 응답의 대상 = 현재 대상이고 그 요청이 마지막 요청일 때만 적용, 아니면 버린다
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrCommentsResult } from '../../../shared/pr-comments.js'

export type PrCommentsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: PrCommentsResult; refreshing: boolean }

export type PrCommentsApi = { path: string | null; state: PrCommentsState; refresh: () => void }

/** 대상 키 — 경로 + 브랜치. 경로 없음이면 null. */
const targetKey = ({ path, branch }: { path: string | null; branch: string | null }): string | null => (path === null ? null : `${path}\n${branch ?? ''}`)

type Shown = { key: string | null; state: PrCommentsState }

export function usePrComments({ path, branch, active }: { path: string | null; branch: string | null; active: boolean }): PrCommentsApi {
  const [shown, setShown] = useState<Shown>({ key: null, state: { kind: 'idle' } })
  const key = targetKey({ path, branch })
  const target = useRef<{ key: string; path: string } | null>(null)
  const seq = useRef(0)

  const request = useCallback(({ at, refresh }: { at: { key: string; path: string }; refresh: boolean }) => {
    seq.current += 1
    const mine = seq.current
    // 같은 대상이면 내용을 두고 불러오는 중 표지만, 대상이 바뀌었으면 비운다.
    setShown((current) => (current.key === at.key && current.state.kind === 'ready' ? { key: at.key, state: { ...current.state, refreshing: true } } : { key: at.key, state: { kind: 'loading' } }))
    const apply = (result: PrCommentsResult): void => {
      if (mine !== seq.current || target.current?.key !== at.key) return
      setShown({ key: at.key, state: { kind: 'ready', result, refreshing: false } })
    }
    void Promise.resolve()
      .then(() => window.corral.prComments(refresh ? { path: at.path, refresh: true } : { path: at.path }))
      .then(apply)
      .catch((error: unknown) => apply({ kind: 'error', error: 'failed', message: String(error).slice(0, 200) }))
  }, [])

  useEffect(() => {
    if (path === null || key === null) {
      target.current = null
      seq.current += 1
      setShown({ key: null, state: { kind: 'idle' } })
      return
    }
    target.current = { key, path }
    if (!active) {
      // 보이지 않으면 묻지 않는다(C8). 대상이 바뀌었으면 옛 대상의 내용만 지운다 — 다시 보일 때 새로 묻는다.
      setShown((current) => (current.key === key ? current : { key, state: { kind: 'loading' } }))
      return
    }
    request({ at: { key, path }, refresh: false })
  }, [key, path, active, request])

  const refresh = useCallback(() => {
    if (target.current !== null) request({ at: target.current, refresh: true })
  }, [request])

  return { path, state: shown.key === key ? shown.state : key === null ? { kind: 'idle' } : { kind: 'loading' }, refresh }
}
