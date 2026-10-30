// PR 상태 구독 (LIFE-624 C11) — 대상(`prTargets`)이 바뀔 때만 main 에 묻는다. 상시 타이머 없음.
// 대상이 비면(페이지 닫힘 · 상세 숨김) 부르지 않는다. 같은 대상을 다시 열면 main 의 TTL 캐시가 gh 를 막는다.
import { useEffect, useRef, useState } from 'react'
import type { PrLookup } from '../../../shared/pr-status.js'

export type PrView = { lookups: ReadonlyMap<string, PrLookup>; recordedSeq: number }

export function usePrStatus({ targets }: { targets: { path: string; branch: string }[] }): PrView {
  const key = targets.length === 0 ? '' : JSON.stringify(targets)
  const latest = useRef(targets)
  latest.current = targets
  const [lookups, setLookups] = useState<ReadonlyMap<string, PrLookup>>(() => new Map())
  const [recordedSeq, setRecordedSeq] = useState(0)
  useEffect(() => {
    if (key === '') return
    let live = true
    const paths = latest.current.map((target) => target.path)
    void Promise.resolve()
      .then(() => window.corral.prBranches({ paths }))
      .then((result) => {
        if (!live) return
        setLookups((previous) => {
          const next = new Map(previous)
          for (const [path, lookup] of Object.entries(result.lookups)) next.set(path, lookup)
          return next
        })
        if (result.recorded > 0) setRecordedSeq((seq) => seq + 1)
      })
      .catch(() => undefined)
    return () => { live = false }
  }, [key])
  return { lookups, recordedSeq }
}
