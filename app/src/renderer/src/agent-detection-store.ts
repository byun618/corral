// 렌더러 쪽 에이전트 감지 결과 (LIFE-520) — ⌘⌥T · `+` 메뉴 · 설정 「기본 Agent」 · 작업 시작 모달이 이 값 하나를 본다.
//
// 처음 구독할 때 main 에서 스냅숏을 한 번 받고(`getAgentDetection`), 이후는 main 의 푸시(`onAgentDetection`)만 진실로 쓴다.
// 감지·캐시·새로고침 정책은 전부 main(`main/agent-detection.ts`). 받기 전·preload 가 없으면(테스트) `unknown` — 화면은 base 와 같다.
import { useSyncExternalStore } from 'react'
import { readAgentDetection, UNKNOWN_AGENT_DETECTION, type AgentDetectionSnapshot } from '../../shared/agent-detection.js'

let current: AgentDetectionSnapshot = UNKNOWN_AGENT_DETECTION
let refreshing = false
const listeners = new Set<() => void>()
let started = false

function api(): Window['corral'] | null {
  return typeof window !== 'undefined' && window.corral !== undefined ? window.corral : null
}

function emit(): void {
  for (const listener of listeners) listener()
}

function accept(next: unknown): void {
  if (next === null || next === undefined) return
  current = readAgentDetection(next)
  emit()
}

function ensureStarted(): void {
  if (started) return
  const corral = api()
  if (corral === null) return
  started = true
  if (typeof corral.onAgentDetection === 'function') corral.onAgentDetection((snapshot) => accept(snapshot))
  if (typeof corral.getAgentDetection === 'function') {
    void Promise.resolve(corral.getAgentDetection()).then(accept, (error: unknown) => console.warn('[agents] getAgentDetection rejected', error))
  }
}

function subscribe(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAgentDetection(): AgentDetectionSnapshot {
  return current
}

// 세 번째 인자(서버 스냅숏) — `renderToStaticMarkup` 으로 그리는 시험(WorktreeBlock 등)에서도 같은 값으로 선다(fix1 w-f1 전량 실패 원인).
export function useAgentDetection(): AgentDetectionSnapshot {
  return useSyncExternalStore(subscribe, getAgentDetection, getAgentDetection)
}

function isRefreshing(): boolean {
  return refreshing
}

/** 「다시 감지」 진행 중 — 버튼 표시용. */
export function useAgentDetectionRefreshing(): boolean {
  return useSyncExternalStore(subscribe, isRefreshing, isRefreshing)
}

/** 다시 감지 — main 캐시를 무시하고 새로 돈다. 결과는 푸시로도 오지만 응답으로 한 번 더 받는다. */
export async function refreshAgentDetection(): Promise<void> {
  const corral = api()
  if (corral === null || typeof corral.refreshAgentDetection !== 'function') return
  refreshing = true
  emit()
  try {
    accept(await corral.refreshAgentDetection())
  } catch (error) {
    console.warn('[agents] refreshAgentDetection rejected', error)
  } finally {
    refreshing = false
    emit()
  }
}

/** 테스트 전용 — 모듈 상태를 비운다. */
export function resetAgentDetectionStoreForTest(next: AgentDetectionSnapshot = UNKNOWN_AGENT_DETECTION): void {
  current = next
  refreshing = false
  started = false
  listeners.clear()
}

/** 테스트 전용 — 푸시를 흉내 낸다. */
export function setAgentDetectionForTest(next: AgentDetectionSnapshot): void {
  current = next
  emit()
}
