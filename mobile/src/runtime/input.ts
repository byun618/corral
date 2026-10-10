// 쓰기 상태 배선 (LIFE-582) — 연결 관리자 위에 보낸 지시·답·중단 하나. React 구독 훅.
import { useSyncExternalStore } from 'react'
import { createTimerClock } from '../core/clock'
import { InputStore, type InputSnapshot } from '../core/input-store'
import { connection, connectionLog } from './connection'

export const inputStore = new InputStore({ connection, now: () => Date.now(), timer: createTimerClock(), log: connectionLog })

export function useInput(): InputSnapshot {
  return useSyncExternalStore(inputStore.subscribe, inputStore.getSnapshot)
}
