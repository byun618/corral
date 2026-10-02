// Workspace options 값의 상태·영속 (LIFE-470). 모양·기본값·읽기 규칙은 `shared/sidebar-view.ts`, 저장은 `ui-prefs.json` 칸.
// 읽기는 App 의 첫 `getUiPrefs` 에 얹는다(`hydrate`) — 수동 순서와 같은 읽기라 부트 화면이 내려가기 전에 옵션이 선다.
// 바꾼 칸만 쓴다(198 `persisted-ui-write-baseline.ts` 와 같은 결 — 부분 갱신 IPC).
import { useCallback, useRef, useState } from 'react'
import type { UiPrefs } from '../../../shared/types.js'
import { DEFAULT_SIDEBAR_VIEW, readSidebarView, sidebarViewToPrefs, type SidebarView } from '../../../shared/sidebar-view.js'

export function useSidebarView(): {
  view: SidebarView
  hydrate: (prefs: UiPrefs) => void
  change: (patch: Partial<SidebarView>) => void
} {
  const [view, setView] = useState<SidebarView>(DEFAULT_SIDEBAR_VIEW)
  /** 같은 이벤트 안에서 두 번 바꿔도(끌어서 Manual 전환 등) 앞의 값 위에 쌓이게 최신 값을 ref 로도 든다. */
  const viewRef = useRef<SidebarView>(DEFAULT_SIDEBAR_VIEW)

  const hydrate = useCallback((prefs: UiPrefs) => {
    // main 이 이미 칸마다 걸렀다 — 여기서 다시 읽는 것은 IPC 너머 값을 믿지 않는 방어다(같은 함수라 결과가 같다).
    const next = readSidebarView({ ...prefs })
    viewRef.current = next
    setView(next)
  }, [])

  const change = useCallback((patch: Partial<SidebarView>) => {
    const next = { ...viewRef.current, ...patch }
    viewRef.current = next
    setView(next)
    window.corral.setUiPrefs(sidebarPrefsPatch({ patch, next }))
  }, [])

  return { view, hydrate, change }
}

/**
 * 바꾼 칸만 `ui-prefs` 칸 이름으로 — **저장 화이트리스트**다. 새 칸을 `SidebarView` 에 더하면 여기에도 한 줄 더해야 저장된다
 * (LIFE-477 F10 — 빠뜨리면 화면만 바뀌고 재시작 뒤 사라진다). `useSidebarView.test.ts` 가 모든 칸이 빠짐없이 쓰이는지 본다.
 */
export function sidebarPrefsPatch(input: { patch: Partial<SidebarView>; next: SidebarView }): Partial<UiPrefs> {
  const { patch } = input
  const prefs = sidebarViewToPrefs(input.next)
  const written: Partial<UiPrefs> = {}
  if (patch.groupBy !== undefined) written.sidebarGroupBy = prefs.sidebarGroupBy
  if (patch.sortBy !== undefined) written.sidebarSortBy = prefs.sidebarSortBy
  if (patch.projectOrderBy !== undefined) written.sidebarProjectOrderBy = prefs.sidebarProjectOrderBy
  if (patch.repoFilter !== undefined) written.sidebarRepoFilter = prefs.sidebarRepoFilter
  if (patch.hideDefaultBranch !== undefined) written.sidebarHideDefaultBranch = prefs.sidebarHideDefaultBranch
  if (patch.hideDetachedHead !== undefined) written.sidebarHideDetachedHead = prefs.sidebarHideDetachedHead
  if (patch.cardLayout !== undefined) written.sidebarCardLayout = prefs.sidebarCardLayout
  if (patch.cardProperties !== undefined) written.sidebarCardProperties = prefs.sidebarCardProperties
  if (patch.agentActivityLayout !== undefined) written.sidebarAgentActivityLayout = prefs.sidebarAgentActivityLayout
  return written
}
