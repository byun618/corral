// 목록 상태 배선 (LIFE-580) — 연결 관리자 위에 목록 구독·안 읽음 장부·접힘 기억을 하나씩 둔다. React 구독 훅.
import { useSyncExternalStore } from 'react'
import { createTimerClock } from '../core/clock'
import { CollapseMemory } from '../core/collapse'
import { ListStore, type ListSnapshot } from '../core/list-store'
import { UnreadLedger } from '../core/unread'
import { connection, connectionLog } from './connection'
import { collapseFile, unreadFile } from './phone-store'

const now = () => Date.now()

export const unread = new UnreadLedger({ store: unreadFile, now })
export const collapse = new CollapseMemory({ store: collapseFile, now })
export const listStore = new ListStore({ connection, ledger: unread, now, timer: createTimerClock(), log: connectionLog })

export function useList(): ListSnapshot {
  return useSyncExternalStore(listStore.subscribe, listStore.getSnapshot)
}

export function useCollapseVersion(): number {
  return useSyncExternalStore(collapse.subscribe, collapse.getVersion)
}
