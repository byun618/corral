// 받은 행에 없는 부모의 단건 보충(LIFE-745) — 부모 칩·레인 머리·부모 필터가 쓴다. 읽기(`getItem`)만 보낸다 — 쓰기 경로 없음.
//
// - 부모 (연결, id) 하나당 진행 중 요청은 하나다 — 화면이 다시 그려져도 다시 보내지 않는다. 동시에 나가는 요청은 `PARENT_REQUESTS_MAX` 개까지(R1-5) —
//   나머지는 「받는 중」 으로 기다렸다가 앞 요청이 끝나면 나간다(받은 행 밖 부모가 많은 스페이스에서 한꺼번에 수십 요청을 내지 않게).
// - 결과는 스페이스 자료가 다시 읽힐 때(`epoch` 가 바뀔 때)까지 재사용한다. 바뀌면 다시 받되 **받아 둔 결과는 버리지 않는다**(R1-2) —
//   새 답이 오면 덮고, 새 답이 실패면 옛 「받음」 을 그대로 둔다(옛 값이 없을 때만 실패 칩). 그래서 재읽기마다 칩·레인이 깜빡이지 않는다.
//   epoch 가 바뀔 때 진행 중인 요청은 다시 보내지 않고 그 답을 새 결과로 쓴다(같은 부모에 요청이 둘 겹치지 않게).
// - 실패는 조용히 숨기지 않는다 — `error` 로 남겨 칩이 「부모를 불러오지 못함」 을 그린다.
import { useEffect, useRef, useState } from 'react'
import { itemUid, type ParentLookup } from '../tasks-model.js'
import { request } from './useTasksPage.js'

/** 부모 보충 동시 요청 상한. */
export const PARENT_REQUESTS_MAX = 4

export function useParentLookup({ needs, epoch, active }: { needs: { connectionId: string; itemId: string }[]; epoch: string; active: boolean }): ReadonlyMap<string, ParentLookup> {
  const [fetched, setFetched] = useState<ReadonlyMap<string, ParentLookup>>(new Map())
  /** 요청이 끝날 때마다 올린다 — 상한에 걸려 기다리던 부모를 보내러 다시 돈다(결과가 그대로여도). */
  const [settled, setSettled] = useState(0)
  const inflight = useRef(new Set<string>())
  /** 이번 epoch 에 보냈거나 보내는 중인 부모 — 이것만 다시 보내지 않는다. */
  const sent = useRef(new Set<string>())
  const seq = useRef(0)
  const epochRef = useRef(epoch)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const needsId = needs.map((need) => itemUid(need)).sort().join('|')
  useEffect(() => {
    if (!active) return
    if (epochRef.current !== epoch) {
      epochRef.current = epoch
      sent.current = new Set(inflight.current)
    }
    for (const need of needs) {
      if (inflight.current.size >= PARENT_REQUESTS_MAX) break
      const uid = itemUid(need)
      if (sent.current.has(uid)) continue
      sent.current.add(uid)
      inflight.current.add(uid)
      seq.current += 1
      void request({ requestId: `parent-${seq.current}-${uid}`, connectionId: need.connectionId, call: { op: 'getItem', itemId: need.itemId } }).then((response) => {
        inflight.current.delete(uid)
        if (!live.current) return
        const lookup: ParentLookup = !response.ok
          ? { state: 'error', message: response.error.message }
          : response.result.op === 'getItem' ? { state: 'found', item: response.result.item } : { state: 'error', message: '출처 응답 모양이 다릅니다.' }
        setFetched((current) => (lookup.state === 'error' && current.get(uid)?.state === 'found' ? current : new Map(current).set(uid, lookup)))
        setSettled((value) => value + 1)
      })
    }
  }, [needsId, active, epoch, settled])

  return fetched
}
