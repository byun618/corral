// 탐색기 데이터 (LIFE-589 F1) — worktree 루트마다 받은 목록·펼침·선택·스크롤·git 상태를 **메모리에** 들고 있는다.
//
// · 지연 로딩(E2ⓐ): 루트와 **보이는** 펼친 폴더만 `explorerList` 로 읽는다(조상이 접힌 폴더의 펼침은 기억만 하고 읽지 않는다 — 조상을 다시 펼치면 읽는다).
//   같은 폴더 요청이 이미 날아가 있으면 또 보내지 않는다(E1ⓓ 폭주 방지). 대신 그 사이 변경이 오면 응답을 낡은 것으로 표시하고 끝난 뒤 한 번 더 읽는다(R1-D).
// · worktree 를 바꿔도 컴포넌트를 다시 마운트하지 않는다(Orca `RS/index.tsx:83-88` — key 리마운트가 IPC 폭주를 냈다). 루트 키로 상태를 갈아 끼울 뿐이고,
//   돌아오면 펼침·선택·스크롤이 그대로다(E2ⓘ). 패널을 닫아도 이 훅은 App 에 남아 상태를 잃지 않는다(E1ⓔ).
// · 감시(E4): 「패널 열림 + 활성 worktree」 하나만 구독한다. 변경 push 가 오면 **읽어 둔 폴더만** 다시 읽는다. 다시 열 때·worktree 로 돌아올 때는
//   닫힌 동안 바뀐 것을 맞추려고 읽어 둔 것을 다시 읽는다(E4ⓑ — Orca #24044). 열려 있는 동안은 안전망 주기로 다시 읽는다(E4ⓒ).
//   변경 push 의 폴더는 **실경로**(realpath(루트) 기준)다 — 목록마다 main 이 준 실경로(`real`)로 맞춰, 루트 안 디렉터리 링크로 펼친 목록도 대상 변경에 다시 읽힌다(R1-G).
// · 표시 토글(dotfile·ignored)은 전역 ui-prefs(E2ⓓⓔ — 범위 「전역」, `shared/types.ts` UiPrefs 주석).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { EXPLORER_SAFETY_NET_MS, type ExplorerEntry, type ExplorerFilter } from '../../../shared/explorer.js'
import { fromWire, type GitSnapshot } from '../../../shared/explorer-git.js'

export type ExplorerRootState = {
  listings: Map<string, ExplorerEntry[]>
  /** 목록 키(논리 경로) → 실경로(realpath(루트) 기준 상대). 링크 아닌 폴더는 같다. */
  real: Map<string, string>
  /** 읽기 실패한 폴더 → 사유(가둠 거절 포함). 다시 펼치면 다시 시도한다. */
  errors: Map<string, string>
  expanded: Set<string>
  selected: string | null
  scrollTop: number
  /** 마지막 git 스냅샷(없으면 아직 못 받음·git 아님). */
  git: GitSnapshot | null
}

const emptyState = (): ExplorerRootState => ({ listings: new Map(), real: new Map(), errors: new Map(), expanded: new Set(), selected: null, scrollTop: 0, git: null })

/** 보이는 펼친 폴더 — 조상이 전부 펼쳐져 있는 것만(루트 '' 는 따로). */
export function visibleExpanded(expanded: ReadonlySet<string>): string[] {
  return [...expanded].filter((rel) => {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) if (!expanded.has(parts.slice(0, i).join('/'))) return false
    return true
  })
}

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
  /** 날아가 있는 동안 변경이 온 요청 — 응답은 낡았으니 끝나면 한 번 더 읽는다. */
  const stale = useRef(new Set<string>())
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
      if (inflight.current.has(flight)) {
        stale.current.add(flight)
        return
      }
      inflight.current.add(flight)
      const again = (): void => {
        inflight.current.delete(flight)
        if (stale.current.delete(flight)) load(key, rel)
        bump()
      }
      void window.corral
        .explorerList({ root: key, rel })
        .then((result) => {
          const store = storeOf(key)
          if (result.ok) {
            store.listings.set(rel, result.entries)
            store.real.set(rel, result.real)
            store.errors.delete(rel)
          } else {
            store.listings.delete(rel)
            store.real.delete(rel)
            store.errors.set(rel, `${result.code}: ${result.error}`)
          }
        })
        .catch((error: unknown) => storeOf(key).errors.set(rel, String(error)))
        .finally(again)
    },
    [storeOf],
  )

  /** 읽어 둔 것을 다시 — 루트 + 보이는 펼친 폴더. 안 보이는 폴더의 옛 목록은 버린다(다시 보이면 새로 읽는다 — Orca stale-dir-cache 와 같은 결). */
  const reloadLoaded = useCallback(
    (key: string) => {
      const store = storeOf(key)
      const visible = new Set(visibleExpanded(store.expanded))
      for (const rel of [...store.listings.keys()]) {
        if (rel !== '' && !visible.has(rel)) {
          store.listings.delete(rel)
          store.real.delete(rel)
        }
      }
      load(key, '')
      for (const rel of visible) load(key, rel)
    },
    [storeOf, load],
  )

  /** 바뀐 폴더(실경로) → 다시 읽을 목록 키. 읽어 둔 것과 지금 읽는 중인 것 모두(R1-D), 실경로가 같으면 링크로 펼친 것도(R1-G). */
  const reloadChanged = useCallback(
    (key: string, dirs: readonly string[]) => {
      const store = storeOf(key)
      const changed = new Set(dirs)
      const prefix = `${key}\0`
      const reading = [...inflight.current].filter((flight) => flight.startsWith(prefix)).map((flight) => flight.slice(prefix.length))
      for (const rel of new Set([...store.listings.keys(), ...reading])) {
        if (changed.has(rel) || changed.has(store.real.get(rel) ?? rel)) load(key, rel)
      }
    },
    [storeOf, load],
  )

  // main push — 감시 배치·overflow·git 스냅샷. 리스너는 한 번만 단다(루트는 push 에 실려 온다).
  useEffect(
    () =>
      window.corral.onExplorerEvent((event) => {
        const store = stores.current.get(event.root)
        if (store === undefined) return
        switch (event.kind) {
          case 'changed':
            reloadChanged(event.root, event.dirs)
            return
          case 'overflow':
            reloadLoaded(event.root)
            return
          case 'git':
            store.git = event.git === null ? null : fromWire(event.git)
            bump()
            return
        }
      }),
    [reloadChanged, reloadLoaded],
  )

  // 열림·활성 루트가 바뀔 때 — 처음이면 루트를 읽고, 이미 읽은 적이 있으면 닫힌 동안의 변경을 맞추려고 다시 읽는다. 감시는 이 루트 하나만.
  useEffect(() => {
    if (!active || root === null) return
    const store = storeOf(root)
    if (store.listings.size === 0) load(root, '')
    else reloadLoaded(root)
    void window.corral.explorerWatch({ root, on: true })
    const timer = window.setInterval(() => {
      reloadLoaded(root)
      window.corral.explorerRefreshGit(root)
    }, EXPLORER_SAFETY_NET_MS)
    return () => {
      window.clearInterval(timer)
      void window.corral.explorerWatch({ root, on: false })
    }
  }, [active, root, load, reloadLoaded, storeOf])

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
        // 이 폴더와, 다시 보이게 된 펼침 기억 하위 폴더 중 목록이 없는 것.
        for (const dir of visibleExpanded(store.expanded)) if (!store.listings.has(dir)) load(key, dir)
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
  const setScrollTop = useCallback(
    (value: number) => {
      if (root !== null) storeOf(root).scrollTop = value
    },
    [root, storeOf],
  )
  const collapseAll = useCallback(() => withRoot((_key, store) => store.expanded.clear()), [withRoot])
  const refresh = useCallback(
    () =>
      withRoot((key) => {
        reloadLoaded(key)
        window.corral.explorerRefreshGit(key)
      }),
    [withRoot, reloadLoaded],
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
