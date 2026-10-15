// 사이드바 작업 줄의 제목 캐시 (LIFE-603 C11) — (연결, 키)당 `findByKey` 한 번. 카드 렌더는 요청을 내지 않는다.
//
// - 연결이 해제된 링크(`connected: false`)는 묻지 않는다 — 키만 그린다.
// - 못 찾음은 캐시한다. 오류는 RETRY_MS 뒤 다시 묻는다(R1-R — 한 번의 실패로 그 열림 내내 키만 남지 않게).
// - 새 링크(`wantedId` 변화)는 바로 묻는다. 이미 받은 제목은 작업 페이지가 닫힐 때(`refresh` 가 바뀔 때) 비우고 다시 묻는다 —
//   페이지에서 바꾼 제목·상태가 사이드바에 남지 않게.
// - 동시에 나가는 요청은 LIMIT 개까지(R1-Q) — 링크가 많아도 출처에 한꺼번에 쏘지 않는다.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkItem } from '../../../shared/work.js'

export type LinkTitle = { state: 'loading' } | { state: 'found'; item: WorkItem } | { state: 'missing' } | { state: 'error' }

export function linkTitleId({ connectionId, key }: { connectionId: string; key: string }): string {
  return `${connectionId}::${key}`
}

const LIMIT = 4
const RETRY_MS = 30_000

export function useLinkTitles({ repos, refresh }: { repos: RepoRow[]; refresh: number }): ReadonlyMap<string, LinkTitle> {
  const [titles, setTitles] = useState<ReadonlyMap<string, LinkTitle>>(() => new Map())
  const [retry, setRetry] = useState(0)
  const asked = useRef(new Set<string>())
  const queue = useRef<{ id: string; connectionId: string; key: string }[]>([])
  const inFlight = useRef(0)
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
    queue.current = []
    setTitles(new Map())
  }, [refresh])

  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    const pump = (): void => {
      while (mounted.current && inFlight.current < LIMIT) {
        const next = queue.current.shift()
        if (next === undefined) return
        const here = round.current
        inFlight.current += 1
        const settle = (title: LinkTitle): void => {
          inFlight.current -= 1
          if (here === round.current) {
            setTitles((current) => new Map(current).set(next.id, title))
            if (title.state === 'error') window.setTimeout(() => { if (here === round.current) { asked.current.delete(next.id); setRetry((value) => value + 1) } }, RETRY_MS)
          }
          pump()
        }
        void window.corral.workRequest({ requestId: `link-title:${here}:${next.id}`, connectionId: next.connectionId, call: { op: 'findByKey', key: next.key } }).then((response) => {
          settle(!response.ok ? { state: 'error' }
            : response.result.op !== 'findByKey' ? { state: 'error' }
              : response.result.item === null ? { state: 'missing' } : { state: 'found', item: response.result.item })
        }, () => settle({ state: 'error' }))
      }
    }
    for (const [id, target] of wanted) {
      if (asked.current.has(id)) continue
      asked.current.add(id)
      queue.current.push({ id, ...target })
      setTitles((current) => (current.get(id)?.state === 'found' ? current : new Map(current).set(id, { state: 'loading' })))
    }
    pump()
  }, [wantedId, refresh, retry])

  return titles
}
