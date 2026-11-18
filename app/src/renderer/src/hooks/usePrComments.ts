// PR 코멘트 구독 (LIFE-811 C8·C9) — 「PR」 보기가 보일 때만, 대상(활성 worktree 경로)이 바뀔 때 main 에 묻는다. 상시 타이머 없음.
// 같은 대상을 다시 열면 main 의 TTL 캐시가 gh 를 막는다. 새로고침 단추만 TTL 을 무시한다.
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

type Shown = { path: string | null; state: PrCommentsState }

export function usePrComments({ path, active }: { path: string | null; active: boolean }): PrCommentsApi {
  const [shown, setShown] = useState<Shown>({ path: null, state: { kind: 'idle' } })
  const target = useRef<string | null>(null)
  const seq = useRef(0)

  const request = useCallback(({ at, refresh }: { at: string; refresh: boolean }) => {
    seq.current += 1
    const mine = seq.current
    // 같은 대상이면 내용을 두고 불러오는 중 표지만, 대상이 바뀌었으면 비운다.
    setShown((current) => (current.path === at && current.state.kind === 'ready' ? { path: at, state: { ...current.state, refreshing: true } } : { path: at, state: { kind: 'loading' } }))
    void Promise.resolve()
      .then(() => window.corral.prComments(refresh ? { path: at, refresh: true } : { path: at }))
      .then((result) => {
        if (mine !== seq.current || target.current !== at) return
        setShown({ path: at, state: { kind: 'ready', result, refreshing: false } })
      })
      .catch((error: unknown) => {
        if (mine !== seq.current || target.current !== at) return
        setShown({ path: at, state: { kind: 'ready', result: { kind: 'error', error: 'failed', message: String(error).slice(0, 200) }, refreshing: false } })
      })
  }, [])

  useEffect(() => {
    target.current = path
    if (path === null) {
      seq.current += 1
      setShown({ path: null, state: { kind: 'idle' } })
      return
    }
    if (!active) {
      // 보이지 않으면 묻지 않는다(C8). 대상이 바뀌었으면 옛 대상의 내용만 지운다 — 다시 보일 때 새로 묻는다.
      setShown((current) => (current.path === path ? current : { path, state: { kind: 'loading' } }))
      return
    }
    request({ at: path, refresh: false })
  }, [path, active, request])

  const refresh = useCallback(() => {
    if (target.current !== null) request({ at: target.current, refresh: true })
  }, [request])

  return { path: shown.path, state: shown.path === path ? shown.state : path === null ? { kind: 'idle' } : { kind: 'loading' }, refresh }
}
