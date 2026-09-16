// worktree 별 영역 배치를 들고, 영속하고, 살아 있는 탭에 맞춰 추린다 (LIFE-373 ① · §10-R3-h).
//
// 순수 모델은 `group-tree.ts` 다. 여기 있는 것은 **바깥과 닿는 부분**뿐이다:
//   · 어느 worktree 의 배치인가 (키 = worktree **경로**. workspace_id 는 herdr 재기동에 안 산다)
//   · 살아 있는 탭 목록에 맞춰 추리기 (F1-6 안전한 붕괴)
//   · `ui-prefs.json` 읽고 쓰기 (tabOrdinals 와 같은 길·같은 주의: 다 싣기 전엔 쓰지 않는다)
//
// 배치는 **worktree 마다 따로** 산다 — 창은 한 번에 하나만 보이지만(R3-f) 나머지도 보존된다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  closeGroup as closeGroupIn,
  listGroups,
  reconcileLayout,
  readStoredLayouts,
  setRatio as setRatioIn,
  singleLayout,
  splitGroup as splitGroupIn,
  updateGroup,
  type GroupLayout,
  type TabGroup,
} from '../group-tree.js'

export type GroupLayoutApi = {
  /** 지금 보고 있는 worktree 의 배치. worktree 가 없으면 null. */
  layout: GroupLayout | null
  groups: TabGroup[]
  activeGroupId: string | null
  /** 다른 worktree 의 영역 수 — 사이드바 `◫`/`⊟` 가 쓴다 (R17-2 공백 2). */
  groupCountOf: (worktreePath: string) => number
  splitDirectionOf: (worktreePath: string) => 'row' | 'column' | null
  setActiveGroup: (groupId: string) => void
  setActiveTab: (input: { groupId: string; tabId: string }) => void
  /** 그 탭이 있는 영역을 활성으로 + 그 영역의 활성 탭으로 (R3-e reveal). 없으면 false. */
  revealTab: (tabId: string) => boolean
  splitGroup: (input: { groupId: string; tabId: string; direction: 'row' | 'column' }) => void
  closeGroup: (groupId: string) => void
  setRatio: (input: { splitId: string; ratio: number }) => void
}

const ROOT_GROUP = 'g1'

/** 영역 id 는 **worktree 안에서만** 유일하면 된다. 저장값과 안 부딪히게 시각을 섞는다. */
function nextGroupId(existing: string[]): string {
  for (let index = 2; index < 1000; index++) {
    const candidate = `g${index}`
    if (!existing.includes(candidate)) return candidate
  }
  return `g${Date.now()}`
}

export function useGroupLayout(input: {
  /** 지금 보고 있는 worktree 의 경로. 없으면 null. */
  worktreePath: string | null
  /** 그 worktree 에 **살아 있는** 탭들 (herdr 가 준 순서 그대로). */
  liveTabIds: string[]
  /** ui-prefs 를 다 실었나 — 싣기 전에 쓰면 저장값을 빈 것으로 지운다 (C13 과 같은 사고). */
  ready: boolean
  stored: unknown[]
}): GroupLayoutApi {
  const [byWorktree, setByWorktree] = useState<Record<string, GroupLayout>>({})
  const hydrated = useRef(false)

  // 저장값을 한 번만 싣는다. 이후의 진실은 화면이 들고 있다.
  useEffect(() => {
    if (!input.ready || hydrated.current) return
    hydrated.current = true
    const rows = readStoredLayouts(input.stored)
    if (rows.length === 0) return
    setByWorktree((previous) => {
      const next = { ...previous }
      for (const row of rows) if (next[row.worktreePath] === undefined) next[row.worktreePath] = row.layout
      return next
    })
  }, [input.ready, input.stored])

  /**
   * 화면에 쓰는 배치 — 저장된 것을 **살아 있는 탭에 맞춰 추린 결과**다 (F1-6).
   *
   * 저장값을 직접 고치지 않고 파생시키는 이유: herdr 재기동으로 tabId 가 전부 바뀐 회차에
   * 저장값을 덮어쓰면 옛 배치가 영영 사라진다. 추리기는 화면용이고, 저장은 사용자가 실제로
   * 배치를 바꿨을 때만 한다.
   */
  const layout = useMemo<GroupLayout | null>(() => {
    if (input.worktreePath === null) return null
    const saved = byWorktree[input.worktreePath]
    const base = saved ?? singleLayout({ groupId: ROOT_GROUP, tabOrder: input.liveTabIds, activeTabId: input.liveTabIds[0] ?? null })
    return reconcileLayout({ layout: base, liveTabIds: input.liveTabIds })
  }, [byWorktree, input.worktreePath, input.liveTabIds])

  // 사용자가 바꾼 배치를 저장한다. 추린 결과가 아니라 **들고 있는 것**을 쓴다(위 주석).
  const saved = useRef('')
  useEffect(() => {
    if (!input.ready || !hydrated.current) return
    const rows = Object.entries(byWorktree).map(([worktreePath, value]) => ({ worktreePath, layout: value }))
    const serialized = JSON.stringify(rows)
    if (serialized === saved.current) return
    saved.current = serialized
    window.corral.setUiPrefs({ groupLayouts: rows })
  }, [byWorktree, input.ready])

  /** 배치를 바꾸는 유일한 길 — 지금 worktree 의 **추린 배치** 위에서 바꾼다. */
  const mutate = useCallback(
    (change: (current: GroupLayout) => GroupLayout) => {
      const worktreePath = input.worktreePath
      if (worktreePath === null) return
      const liveTabIds = input.liveTabIds
      setByWorktree((previous) => {
        const base =
          previous[worktreePath] ?? singleLayout({ groupId: ROOT_GROUP, tabOrder: liveTabIds, activeTabId: liveTabIds[0] ?? null })
        const current = reconcileLayout({ layout: base, liveTabIds })
        const next = change(current)
        return next === previous[worktreePath] ? previous : { ...previous, [worktreePath]: next }
      })
    },
    [input.worktreePath, input.liveTabIds],
  )

  const groups = useMemo(() => (layout === null ? [] : listGroups(layout.root)), [layout])

  const groupCountOf = useCallback(
    (worktreePath: string) => {
      const value = byWorktree[worktreePath]
      return value === undefined ? 0 : listGroups(value.root).length
    },
    [byWorktree],
  )

  const splitDirectionOf = useCallback(
    (worktreePath: string) => {
      const value = byWorktree[worktreePath]
      if (value === undefined || value.root.kind !== 'split') return null
      return value.root.direction
    },
    [byWorktree],
  )

  const setActiveGroup = useCallback((groupId: string) => mutate((current) => ({ ...current, activeGroupId: groupId })), [mutate])

  const setActiveTab = useCallback(
    (target: { groupId: string; tabId: string }) =>
      mutate((current) => ({
        ...updateGroup(current, target.groupId, (group) => ({ ...group, activeTabId: target.tabId })),
        activeGroupId: target.groupId,
      })),
    [mutate],
  )

  const revealTab = useCallback(
    (tabId: string) => {
      if (layout === null) return false
      const owner = listGroups(layout.root).find((group) => group.tabOrder.includes(tabId))
      if (owner === undefined) return false
      setActiveTab({ groupId: owner.groupId, tabId })
      return true
    },
    [layout, setActiveTab],
  )

  const splitGroup = useCallback(
    (target: { groupId: string; tabId: string; direction: 'row' | 'column' }) =>
      mutate((current) =>
        splitGroupIn({
          layout: current,
          groupId: target.groupId,
          tabId: target.tabId,
          direction: target.direction,
          newGroupId: nextGroupId(listGroups(current.root).map((group) => group.groupId)),
        }),
      ),
    [mutate],
  )

  const closeGroup = useCallback((groupId: string) => mutate((current) => closeGroupIn(current, groupId)), [mutate])

  const setRatio = useCallback(
    (target: { splitId: string; ratio: number }) => mutate((current) => setRatioIn(current, target.splitId, target.ratio)),
    [mutate],
  )

  return {
    layout,
    groups,
    activeGroupId: layout?.activeGroupId ?? null,
    groupCountOf,
    splitDirectionOf,
    setActiveGroup,
    setActiveTab,
    revealTab,
    splitGroup,
    closeGroup,
    setRatio,
  }
}
