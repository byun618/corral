// 사이드바 작업 줄의 제목 캐시 (LIFE-603 C11) — (연결, 키)당 `findByKey` 한 번. 카드 렌더는 요청을 내지 않는다.
//
// - 연결이 해제된 링크(`connected: false`)는 묻지 않는다 — 키만 그린다.
// - 못 찾음은 캐시한다. 오류는 RETRY_MS 뒤 다시 묻는다(R1-R — 한 번의 실패로 그 열림 내내 키만 남지 않게).
// - 새 링크(`wantedId` 변화)는 바로 묻는다. 이미 받은 제목은 작업 페이지가 닫힐 때(`refresh` 가 바뀔 때) 비우고 다시 묻는다 —
//   페이지에서 바꾼 제목·상태가 사이드바에 남지 않게.
// - 동시에 나가는 요청은 LIMIT 개까지(R1-Q) — 링크가 많아도 출처에 한꺼번에 쏘지 않는다.
// - LIFE-755 r2 `reread` — 패널 상세 쓰기 성공 뒤 **그 연결의 링크만, 받은 값을 비우지 않고** 다시 묻는다(키만 그리는 깜빡임 없음).
//   같은 줄의 앞선 답이 늦게 와도 새 답을 덮지 않게 줄마다 마지막 요청 번호(`tickets`)만 받는다.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkItem } from '../../../shared/work.js'

export type LinkTitle = { state: 'loading' } | { state: 'found'; item: WorkItem } | { state: 'missing' } | { state: 'error' }

export function linkTitleId({ connectionId, key }: { connectionId: string; key: string }): string {
  return `${connectionId}::${key}`
}

const LIMIT = 4
const RETRY_MS = 30_000

/** 쓰기 계기 재조회 — `seq` 가 바뀔 때마다 그 연결의 링크를 다시 묻는다. */
export type LinkTitleReread = { seq: number; connectionId: string }

export function useLinkTitles({ repos, refresh, reread = null }: { repos: RepoRow[]; refresh: number; reread?: LinkTitleReread | null }): ReadonlyMap<string, LinkTitle> {
  const [titles, setTitles] = useState<ReadonlyMap<string, LinkTitle>>(() => new Map())
  const [retry, setRetry] = useState(0)
  const asked = useRef(new Set<string>())
  const queue = useRef<{ id: string; connectionId: string; key: string }[]>([])
  const inFlight = useRef(0)
  const round = useRef(0)
  const tickets = useRef(new Map<string, number>())
  const ticketSeq = useRef(0)
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

  const rereadSeq = reread?.seq ?? 0
  useEffect(() => {
    if (reread === null) return
    for (const [id, target] of wanted) if (target.connectionId === reread.connectionId) asked.current.delete(id)
  }, [rereadSeq])

  const mounted = useRef(true)
  // 마운트마다 다시 세운다(R2-G) — StrictMode 개발 실행의 마운트 → 정리 → 재마운트에서 정리가 남긴 false 가 요청을 영원히 막지 않게.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const pump = (): void => {
      while (mounted.current && inFlight.current < LIMIT) {
        const next = queue.current.shift()
        if (next === undefined) return
        const here = round.current
        const ticket = (ticketSeq.current += 1)
        tickets.current.set(next.id, ticket)
        inFlight.current += 1
        const settle = (title: LinkTitle): void => {
          inFlight.current -= 1
          if (here === round.current && tickets.current.get(next.id) === ticket) {
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
  }, [wantedId, refresh, retry, rereadSeq])

  return titles
}
