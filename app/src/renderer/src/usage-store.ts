// 렌더러 쪽 provider 사용량 (LIFE-636) — 상태바 칩·팝오버와 설정 › 외관 「상태바」 카드가 이 값 하나를 본다.
//
// 처음 구독할 때 main 에서 스냅숏을 한 번 받고(`getUsage`), 이후는 main 의 푸시(`onUsage`)만 진실로 쓴다.
// 수집·일정·stale 정책은 전부 main(`main/usage/service.ts`)에 있다 — 여기는 받은 값을 들고만 있다.
// 받은 값은 `readUsageSnapshot` 으로 다시 읽는다(모양이 다른 항목은 버린다). preload 가 없으면(테스트) 빈 스냅숏.
import { useSyncExternalStore } from 'react'
import { EMPTY_USAGE_SNAPSHOT, readUsageSnapshot, type UsageSnapshot } from '../../shared/usage.js'

let current: UsageSnapshot = EMPTY_USAGE_SNAPSHOT
const listeners = new Set<() => void>()
let started = false

function api(): Window['corral'] | null {
  return typeof window !== 'undefined' && window.corral !== undefined ? window.corral : null
}

function accept(next: unknown): void {
  const read = readUsageSnapshot(next)
  if (read === null) return
  current = read
  for (const listener of listeners) listener()
}

function ensureStarted(): void {
  if (started) return
  const corral = api()
  if (corral === null) return
  started = true
  if (typeof corral.onUsage === 'function') corral.onUsage((snapshot) => accept(snapshot))
  if (typeof corral.getUsage === 'function') {
    void Promise.resolve(corral.getUsage()).then(accept, (error: unknown) => console.warn('[usage] getUsage rejected', error))
  }
}

function subscribe(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): UsageSnapshot {
  return current
}

export function useUsage(): UsageSnapshot {
  return useSyncExternalStore(subscribe, snapshot)
}

/** 새로고침 버튼 — main 이 진행 중 요청을 같이 기다리게 한다(중복 요청 0). 결과는 푸시로도 오지만 응답으로 한 번 더 받는다. */
export async function refreshUsage(id: string | null): Promise<void> {
  const corral = api()
  if (corral === null || typeof corral.refreshUsage !== 'function') return
  try {
    accept(await corral.refreshUsage({ id }))
  } catch (error) {
    console.warn('[usage] refreshUsage rejected', error)
  }
}

/** 테스트 전용 — 모듈 상태를 비운다. */
export function resetUsageStoreForTest(next: UsageSnapshot = EMPTY_USAGE_SNAPSHOT): void {
  current = next
  started = false
  listeners.clear()
}
