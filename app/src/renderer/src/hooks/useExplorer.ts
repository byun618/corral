// 탐색기 데이터 (LIFE-589 F1) — worktree 루트마다 받은 목록·펼침·선택·스크롤을 **메모리에** 들고 있는다.
//
// · 지연 로딩(E2ⓐ): 루트와 펼친 폴더만 `explorerList` 로 읽는다. 같은 폴더 요청이 이미 날아가 있으면 또 보내지 않는다(E1ⓓ 폭주 방지).
// · worktree 를 바꿔도 컴포넌트를 다시 마운트하지 않는다(Orca `RS/index.tsx:83-88` — key 리마운트가 IPC 폭주를 냈다). 루트 키로 상태를 갈아 끼울 뿐이고,
//   돌아오면 펼침·선택·스크롤이 그대로다(E2ⓘ). 패널을 닫아도 이 훅은 App 에 남아 상태를 잃지 않는다(E1ⓔ).
// · 표시 토글(dotfile·ignored)은 전역 ui-prefs(E2ⓓⓔ — 범위 「전역」, `shared/types.ts` UiPrefs 주석).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ExplorerEntry, ExplorerFilter } from '../../../shared/explorer.js'

export type ExplorerRootState = {
  listings: Map<string, ExplorerEntry[]>
  /** 읽기 실패한 폴더 → 사유(가둠 거절 포함). 다시 펼치면 다시 시도한다. */
  errors: Map<string, string>
  expanded: Set<string>
  selected: string | null
  scrollTop: number
}

const emptyState = (): ExplorerRootState => ({ listings: new Map(), errors: new Map(), expanded: new Set(), selected: null, scrollTop: 0 })

export type ExplorerApi = {
  root: string | null
  state: ExplorerRootState | null
  filter: ExplorerFilter
  version: number
  toggle: (rel: string) => void
  expand: (rel: string) => void
  collapse: (rel: string) => void
  select: (rel: string | null) => void
  setScrollTop: (value: number) => void
  collapseAll: () => void
  refresh: () => void
  setFilter: (patch: Partial<ExplorerFilter>) => void
}

export function useExplorer({ root, active }: { root: string | null; active: boolean }): ExplorerApi {
  const stores = useRef(new Map<string, ExplorerRootState>())
  const inflight = useRef(new Set<string>())
  const [version, bump] = useReducer((value: number) => value + 1, 0)
  const [filter, setFilterState] = useState<ExplorerFilter>({ showDotfiles: true, showIgnored: true })

  useEffect(() => {
    let cancelled = false
    void window.corral
      .getUiPrefs()
      .then((prefs) => {
        if (!cancelled) setFilterState({ showDotfiles: prefs.explorerShowDotfiles, showIgnored: prefs.explorerShowIgnored })
      })
      .catch(() => {
        // 기본값 유지.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const storeOf = useCallback((key: string): ExplorerRootState => {
    const existing = stores.current.get(key)
    if (existing !== undefined) return existing
    const created = emptyState()
    stores.current.set(key, created)
    return created
  }, [])

  const load = useCallback(
    (key: string, rel: string) => {
      const flight = `${key}\0${rel}`
      if (inflight.current.has(flight)) return
      inflight.current.add(flight)
      void window.corral
        .explorerList({ root: key, rel })
        .then((result) => {
          const store = storeOf(key)
          if (result.ok) {
            store.listings.set(rel, result.entries)
            store.errors.delete(rel)
          } else {
            store.listings.delete(rel)
            store.errors.set(rel, `${result.code}: ${result.error}`)
          }
        })
        .catch((error: unknown) => storeOf(key).errors.set(rel, String(error)))
        .finally(() => {
          inflight.current.delete(flight)
          bump()
        })
    },
    [storeOf],
  )

  // 패널이 보이는 동안 루트 목록이 없으면 읽는다 — 닫혀 있으면 아무것도 읽지 않는다(Orca `file-explorer-reset.ts:3-15`).
  useEffect(() => {
    if (!active || root === null) return
    if (!storeOf(root).listings.has('')) load(root, '')
  }, [active, root, load, storeOf])

  const withRoot = useCallback(
    (fn: (key: string, store: ExplorerRootState) => void) => {
      if (root === null) return
      fn(root, storeOf(root))
      bump()
    },
    [root, storeOf],
  )

  const expand = useCallback(
    (rel: string) =>
      withRoot((key, store) => {
        store.expanded.add(rel)
        if (!store.listings.has(rel)) load(key, rel)
      }),
    [withRoot, load],
  )
  const collapse = useCallback((rel: string) => withRoot((_key, store) => void store.expanded.delete(rel)), [withRoot])
  const toggle = useCallback(
    (rel: string) => {
      if (root !== null && storeOf(root).expanded.has(rel)) collapse(rel)
      else expand(rel)
    },
    [root, storeOf, collapse, expand],
  )
  const select = useCallback((rel: string | null) => withRoot((_key, store) => void (store.selected = rel)), [withRoot])
  const setScrollTop = useCallback((value: number) => {
    if (root !== null) storeOf(root).scrollTop = value
  }, [root, storeOf])
  const collapseAll = useCallback(() => withRoot((_key, store) => store.expanded.clear()), [withRoot])
  /** 새로고침 — 루트와 펼친 폴더만 다시 읽는다. 접힌 폴더의 옛 목록은 버린다(다시 펼치면 새로 읽는다 — Orca stale-dir-cache 와 같은 결). */
  const refresh = useCallback(
    () =>
      withRoot((key, store) => {
        for (const rel of [...store.listings.keys()]) if (rel !== '' && !store.expanded.has(rel)) store.listings.delete(rel)
        load(key, '')
        for (const rel of store.expanded) load(key, rel)
      }),
    [withRoot, load],
  )
  const setFilter = useCallback((patch: Partial<ExplorerFilter>) => {
    setFilterState((current) => {
      const next = { ...current, ...patch }
      window.corral.setUiPrefs({ explorerShowDotfiles: next.showDotfiles, explorerShowIgnored: next.showIgnored })
      return next
    })
  }, [])

  return { root, state: root === null ? null : (stores.current.get(root) ?? null), filter, version, toggle, expand, collapse, select, setScrollTop, collapseAll, refresh, setFilter }
}
