// 사이드바 작업 줄의 제목 캐시 (LIFE-603 C11) — (연결, 키)당 `findByKey` 한 번. 카드 렌더는 요청을 내지 않는다.
//
// - 연결이 해제된 링크(`connected: false`)는 묻지 않는다 — 키만 그린다.
// - 오류·못 찾음도 캐시한다(같은 열림 동안 다시 묻지 않는다). 작업 페이지가 닫힐 때(`refresh` 가 바뀔 때) 비우고 다시 묻는다 —
//   페이지에서 바꾼 제목·상태가 사이드바에 남지 않게.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkItem } from '../../../shared/work.js'

export type LinkTitle = { state: 'loading' } | { state: 'found'; item: WorkItem } | { state: 'missing' } | { state: 'error' }

export function linkTitleId({ connectionId, key }: { connectionId: string; key: string }): string {
  return `${connectionId}::${key}`
}

export function useLinkTitles({ repos, refresh }: { repos: RepoRow[]; refresh: number }): ReadonlyMap<string, LinkTitle> {
  const [titles, setTitles] = useState<ReadonlyMap<string, LinkTitle>>(() => new Map())
  const asked = useRef(new Set<string>())
  const round = useRef(0)
  const wanted = useMemo(() => {
    const ids = new Map<string, { connectionId: string; key: string }>()
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        const link = worktree.workLink ?? null
        if (link === null || !link.connected) continue
        ids.set(linkTitleId(link), { connectionId: link.connectionId, key: link.key })
      }
    }
    return ids
  }, [repos])
  const wantedId = [...wanted.keys()].sort().join('|')

  useEffect(() => {
    round.current += 1
    asked.current = new Set()
    setTitles(new Map())
  }, [refresh])

  useEffect(() => {
    const here = round.current
    for (const [id, target] of wanted) {
      if (asked.current.has(id)) continue
      asked.current.add(id)
      setTitles((current) => new Map(current).set(id, { state: 'loading' }))
      void window.corral.workRequest({ requestId: `link-title:${here}:${id}`, connectionId: target.connectionId, call: { op: 'findByKey', key: target.key } }).then((response) => {
        if (here !== round.current) return
        const title: LinkTitle = !response.ok ? { state: 'error' }
          : response.result.op !== 'findByKey' ? { state: 'error' }
            : response.result.item === null ? { state: 'missing' } : { state: 'found', item: response.result.item }
        setTitles((current) => new Map(current).set(id, title))
      }, () => {
        if (here === round.current) setTitles((current) => new Map(current).set(id, { state: 'error' }))
      })
    }
  }, [wantedId, refresh])

  return titles
}
