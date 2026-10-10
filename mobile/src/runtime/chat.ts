// 대화 상태 배선 (LIFE-581) — 연결 관리자 위에 대화 구독 하나. React 구독 훅.
import { useSyncExternalStore } from 'react'
import { createTimerClock } from '../core/clock'
import { ChatStore, type ChatSnapshot } from '../core/chat-store'
import { connection, connectionLog } from './connection'

export const chatStore = new ChatStore({ connection, now: () => Date.now(), timer: createTimerClock(), log: connectionLog })

export function useChat(): ChatSnapshot {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot)
}
