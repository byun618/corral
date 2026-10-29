// 받은 행에 없는 부모의 단건 보충(LIFE-745) — 부모 칩·레인 머리·부모 필터가 쓴다. 읽기(`getItem`)만 보낸다 — 쓰기 경로 없음.
//
// - 부모 (연결, id) 하나당 진행 중 요청은 하나다 — 화면이 다시 그려져도 다시 보내지 않는다.
// - 결과는 스페이스 자료가 다시 읽힐 때(`epoch` 가 바뀔 때)까지 재사용한다. 바뀌면 끝난 결과만 버리고 다시 받는다 —
//   그때 진행 중인 요청은 그대로 기다려 그 답을 쓴다(같은 부모에 요청이 둘 겹치지 않게).
// - 실패는 조용히 숨기지 않는다 — `error` 로 남겨 칩이 「부모를 불러오지 못함」 을 그린다. 다음 `epoch` 에 다시 받는다.
import { useEffect, useRef, useState } from 'react'
import { itemUid, type ParentLookup } from '../tasks-model.js'
import { request } from './useTasksPage.js'

export function useParentLookup({ needs, epoch, active }: { needs: { connectionId: string; itemId: string }[]; epoch: string; active: boolean }): ReadonlyMap<string, ParentLookup> {
  const [fetched, setFetched] = useState<ReadonlyMap<string, ParentLookup>>(new Map())
  const inflight = useRef(new Set<string>())
  const seq = useRef(0)
  const epochRef = useRef(epoch)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  // 자료가 다시 읽혔다 — 끝난 결과만 버린다(진행 중인 것은 답을 기다린다).
  useEffect(() => {
    if (epochRef.current === epoch) return
    epochRef.current = epoch
    setFetched((current) => new Map([...current].filter(([uid]) => inflight.current.has(uid))))
  }, [epoch])

  const needsId = needs.map((need) => itemUid(need)).sort().join('|')
  useEffect(() => {
    if (!active) return
    for (const need of needs) {
      const uid = itemUid(need)
      if (inflight.current.has(uid) || fetched.has(uid)) continue
      inflight.current.add(uid)
      seq.current += 1
      setFetched((current) => new Map(current).set(uid, { state: 'loading' }))
      void request({ requestId: `parent-${seq.current}-${uid}`, connectionId: need.connectionId, call: { op: 'getItem', itemId: need.itemId } }).then((response) => {
        inflight.current.delete(uid)
        if (!live.current) return
        const lookup: ParentLookup = !response.ok
          ? { state: 'error', message: response.error.message }
          : response.result.op === 'getItem' ? { state: 'found', item: response.result.item } : { state: 'error', message: '출처 응답 모양이 다릅니다.' }
        setFetched((current) => new Map(current).set(uid, lookup))
      })
    }
  }, [needsId, active, fetched])

  return fetched
}
