// 사이드바 작업 줄의 제목 캐시 (LIFE-603 C11) — (연결, 키)당 `findByKey` 한 번. 카드 렌더는 요청을 내지 않는다.
//
// - 연결이 해제된 링크(`connected: false`)는 묻지 않는다 — 키만 그린다.
// - 못 찾음은 캐시한다. 오류는 RETRY_MS 뒤 다시 묻는다(R1-R — 한 번의 실패로 그 열림 내내 키만 남지 않게).
// - 새 링크(`wantedId` 변화)는 바로 묻는다. 이미 받은 제목은 작업 페이지가 닫힐 때(`refresh` 가 바뀔 때) 비우고 다시 묻는다 —
//   페이지에서 바꾼 제목·상태가 사이드바에 남지 않게.
// - 동시에 나가는 요청은 LIMIT 개까지(R1-Q) — 링크가 많아도 출처에 한꺼번에 쏘지 않는다.
// - LIFE-755 r2·r3 `reread` — 패널 상세 쓰기 성공 뒤 **그 연결의 링크만, 받은 값을 비우지 않고** 다시 묻는다(키만 그리는 깜빡임 없음).
//   같은 줄의 앞선 답이 늦게 와도 새 답을 덮지 않게 줄마다 마지막 요청 번호(`tickets`)만 받는다. 오류는 받은 제목을 지우지 않는다.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkItem } from '../../../shared/work.js'

export type LinkTitle = { state: 'loading' } | { state: 'found'; item: WorkItem } | { state: 'missing' } | { state: 'error' }

export function linkTitleId({ connectionId, key }: { connectionId: string; key: string }): string {
  return `${connectionId}::${key}`
}

const LIMIT = 4
const RETRY_MS = 30_000

/** 쓰기 계기 재조회 — 연결별 쓰기 회차. 회차가 바뀐 연결의 링크를 다시 묻는다(한 렌더에 여러 연결이 묶여도 빠지지 않는다 — r3 T). */
export type LinkTitleReread = ReadonlyMap<string, number>

const NO_REREAD: LinkTitleReread = new Map()

export function useLinkTitles({ repos, refresh, reread = NO_REREAD }: { repos: RepoRow[]; refresh: number; reread?: LinkTitleReread }): ReadonlyMap<string, LinkTitle> {
  const [titles, setTitles] = useState<ReadonlyMap<string, LinkTitle>>(() => new Map())
  const [retry, setRetry] = useState(0)
  const asked = useRef(new Set<string>())
  const queue = useRef<{ id: string; connectionId: string; key: string }[]>([])
  const inFlight = useRef(0)
  const round = useRef(0)
  /** 줄마다 마지막 요청 번호 — 늦게 온 앞선 답·앞선 답의 재시도 타이머는 버린다(r2 N · r3 S). */
  const tickets = useRef(new Map<string, number>())
  const ticketSeq = useRef(0)
  const seenRefresh = useRef<number | null>(null)
  const seenReread = useRef<LinkTitleReread>(NO_REREAD)
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
  const rereadId = [...reread].map(([connectionId, seq]) => `${connectionId}=${seq}`).sort().join('|')

  const mounted = useRef(true)
  // 마운트마다 다시 세운다(R2-G) — StrictMode 개발 실행의 마운트 → 정리 → 재마운트에서 정리가 남긴 false 가 요청을 영원히 막지 않게.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // 한 효과에서 「비우기(refresh) → 다시 물을 줄 고르기(reread) → 묻기」 를 차례로 한다 — 효과 사이 실행 순서에 기대지 않는다(r3 권고).
  useEffect(() => {
    if (seenRefresh.current !== refresh) {
      seenRefresh.current = refresh
      round.current += 1
      asked.current = new Set()
      queue.current = []
      setTitles(new Map())
    }
    if (seenReread.current !== reread) {
      const before = seenReread.current
      seenReread.current = reread
      const changed = new Set([...reread].filter(([connectionId, seq]) => before.get(connectionId) !== seq).map(([connectionId]) => connectionId))
      for (const [id, target] of wanted) if (changed.has(target.connectionId)) asked.current.delete(id)
    }
    const pump = (): void => {
      while (mounted.current && inFlight.current < LIMIT) {
        const next = queue.current.shift()
        if (next === undefined) return
        const here = round.current
        const ticket = (ticketSeq.current += 1)
        tickets.current.set(next.id, ticket)
        inFlight.current += 1
        const latest = (): boolean => here === round.current && tickets.current.get(next.id) === ticket
        const settle = (title: LinkTitle): void => {
          inFlight.current -= 1
          if (latest()) {
            // 오류는 받은 제목을 지우지 않는다(r3 Q) — 쓰기 뒤 재조회가 실패해도 줄은 마지막 값을 그리고, 재시도만 건다.
            setTitles((current) => (title.state === 'error' && current.get(next.id)?.state === 'found' ? current : new Map(current).set(next.id, title)))
            if (title.state === 'error') window.setTimeout(() => { if (latest()) { asked.current.delete(next.id); setRetry((value) => value + 1) } }, RETRY_MS)
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
  }, [wantedId, refresh, retry, rereadId])

  return titles
}
