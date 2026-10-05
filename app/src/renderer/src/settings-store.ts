// 렌더러 쪽 사용자 설정 (LIFE-512 K1ⓑ) — 화면 전체가 이 값 하나를 본다(라이브 pane·셀 측정·미리보기·설정 화면).
//
// 첫 값은 모듈이 처음 읽힐 때 **동기로** 가져온다(`getSettingsSync`). 이유: `useCellMetrics` 의 첫 측정과 첫 격자 요청이
// 저장값 셀로 나가야 한다 — 비동기로 받으면 기본값 셀로 한 번 요청한 뒤 저장값 셀로 또 요청하는 2단 resize 가 생긴다(K2ⓔ).
// 이후 값은 main 의 변경 푸시(`onSettings`)만 진실로 쓴다 — 쓰기(`updateSettings`)는 main 이 검증한 값을 돌려받아 반영한다.
import { useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS, readSettings, type Settings } from '../../shared/terminal-settings.js'

type Listener = () => void

let current: Settings | null = null
const listeners = new Set<Listener>()
let subscribed = false

function api(): Window['corral'] | null {
  return typeof window !== 'undefined' && window.corral !== undefined ? window.corral : null
}

function set(next: Settings): void {
  current = next
  for (const listener of listeners) listener()
}

/** 지금 설정 — 처음 부르면 main 에서 동기로 읽고 푸시를 구독한다. 테스트처럼 preload 가 없으면 기본값. */
export function getSettings(): Settings {
  if (current === null) {
    const corral = api()
    // 칸별로 다시 읽는다 — main 이 이미 검증한 값이지만, preload 가 없거나(테스트) 모양이 다른 값이 와도 화면이 기본값으로 선다.
    current = corral !== null && typeof corral.getSettingsSync === 'function' ? readSettings(corral.getSettingsSync()) : { ...DEFAULT_SETTINGS }
    if (corral !== null && !subscribed && typeof corral.onSettings === 'function') {
      subscribed = true
      corral.onSettings((next) => set(readSettings(next)))
    }
  }
  return current
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings)
}

/**
 * 부분 갱신. 확정 순간에만 부른다(숫자 입력 Enter/blur · ± 한 번 · 테마 한 번 클릭) — 그래서 저장소는 디바운스가 필요 없다.
 * 화면 반영은 main 이 돌려준(=푸시한) 검증된 값으로 한다. preload 가 없으면(테스트) 로컬 값만 고친다.
 */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const corral = api()
  if (corral === null || typeof corral.setSettings !== 'function') {
    set({ ...getSettings(), ...patch })
    return
  }
  const next = await corral.setSettings(patch)
  if (next !== null && typeof next === 'object') set(readSettings(next))
}

/** 테스트 전용 — 모듈 상태를 비운다. */
export function resetSettingsStoreForTest(next: Settings | null = null): void {
  current = next
  subscribed = false
  listeners.clear()
}
