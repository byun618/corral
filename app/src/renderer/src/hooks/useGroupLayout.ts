// worktree 별 영역 배치를 들고, 영속하고, 살아 있는 탭에 맞춰 추린다 (LIFE-373 ① · §10-R3-h).
//
// 순수 모델은 `group-tree.ts` 다. 여기 있는 것은 **바깥과 닿는 부분**뿐이다:
//   · 어느 worktree 의 배치인가 (키 = worktree **경로**. workspace_id 는 herdr 재기동에 안 산다)
//   · 살아 있는 탭 목록에 맞춰 추리기 (F1-6 안전한 붕괴)
//   · `ui-prefs.json` 읽고 쓰기 (tabOrdinals 와 같은 길·같은 주의: 다 싣기 전엔 쓰지 않는다)
//
// 배치는 **worktree 마다 따로** 산다 — 창은 한 번에 하나만 보이지만(R3-f) 나머지도 보존된다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { closeFileTab, keepFileTab, openFileTab, reopenFileTab, retargetFileTabs } from '../file-tabs.js'
import {
  closeGroup as closeGroupIn,
  dropDeadTabs,
  LAYOUT_FORMAT,
  listGroups,
  mergeTabIntoGroup as mergeTabIntoGroupIn,
  moveTabWithinTabbar as moveTabWithinTabbarIn,
  partitionPinnedLayout,
  placeTab as placeTabIn,
  reconcileLayout,
  readStoredLayouts,
  setRatio as setRatioIn,
  singleLayout,
  splitGroup as splitGroupIn,
  splitGroupWithForeignTab as splitGroupWithForeignTabIn,
  trackRecentTabs,
  updateGroup,
  withoutRecentTabs,
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
  /**
   * 그 worktree 가 화면에 보일 배치(활성이 아닌 worktree 포함 — LIFE-495 fix1 R1-02 다시 열기 스냅샷). 저장값을 그대로 주지 않고
   * 활성 배치와 같은 파생(살아 있는 탭 reconcile + 핀 partition)을 거친다 — 저장값은 핀을 바꾸기 전 순서일 수 있다(fix2 R2-02).
   */
  layoutOf: (input: { worktreePath: string; liveTabIds: string[]; pinned: ReadonlySet<string> }) => GroupLayout
  setActiveGroup: (groupId: string) => void
  setActiveTab: (input: { groupId: string; tabId: string }) => void
  /** 그 탭이 있는 영역을 활성으로 + 그 영역의 활성 탭으로 (R3-e reveal). 없으면 false. */
  revealTab: (tabId: string) => boolean
  splitGroup: (input: { groupId: string; tabId: string; direction: 'row' | 'column'; edge?: 'before' | 'after' }) => void
  closeGroup: (groupId: string) => void
  setRatio: (input: { splitId: string; ratio: number }) => void
  /** LIFE-387 A1 — 탭바 안 드롭(재정렬/크로스그룹 이동). */
  moveTabWithinTabbar: (input: { tabId: string; fromGroupId: string; toGroupId: string; index: number }) => void
  /** LIFE-387 A1 — 본문 중앙/빈 영역 드롭(병합, corral 에 없던 "기존 영역으로 이동"). */
  mergeTabIntoGroup: (input: { tabId: string; fromGroupId: string; toGroupId: string }) => void
  /** LIFE-387 A1 — 다른 영역의 탭을 대상 가장자리로 끌어 새 영역 생성. */
  splitGroupWithForeignTab: (input: {
    tabId: string
    fromGroupId: string
    targetGroupId: string
    direction: 'row' | 'column'
    edge: 'before' | 'after'
  }) => void
  /** LIFE-495 K6 — 다시 연 탭을 닫을 때의 영역·자리로. */
  placeTab: (input: { tabId: string; groupId: string; index: number }) => void
  /**
   * LIFE-590 — 파일 탭 열기(탐색기 한 번 클릭 = 미리보기, 더블클릭 = 고정). 미리보기 교체로 밀려난 파일은 `onReplaced` 로 알린다(닫은 탭 기록).
   * 지금 worktree 의 배치에서만 한다.
   */
  openFile: (input: { rel: string; preview: boolean; onReplaced?: (replaced: { rel: string; groupId: string; index: number }) => void }) => void
  /** 미리보기 파일 탭 고정(탭 더블클릭). */
  keepFile: (tabId: string) => void
  /** 파일 탭 닫기 — 닫기 전 자리를 `onClosed` 로(⌘⇧T 기록). */
  closeFile: (input: { tabId: string; onClosed?: (closed: { groupId: string; index: number; preview: boolean }) => void }) => void
  /** 닫은 파일 탭 다시 열기(⌘⇧T) — 같은 영역·자리·미리보기 여부. */
  reopenFile: (input: { rel: string; groupId: string; index: number; preview: boolean }) => void
  /**
   * LIFE-592 E4 — 탐색기 이름 변경·이동을 **그 worktree 의 배치**에 반영한다(파일 탭 id 만 바뀐다). 화면에 안 보이는 worktree 배치도 같은 규칙으로 바꾼다.
   * 바뀐 탭 id 쌍은 지금 화면 배치로 미리 셈해 돌려준다(view state 등을 같이 옮긴다).
   */
  retargetFiles: (input: { worktreePath: string; from: string; to: string }) => { from: string; to: string }[]
  /** LIFE-592 수정 r1 R1-A — 그 worktree 의 배치(화면에 없는 worktree 포함 — 조작을 요청한 worktree 기준으로 탭을 본다). 없으면 null. */
  fileLayoutOf: (worktreePath: string) => GroupLayout | null
  /** LIFE-592 수정 r1 R1-A — 그 worktree 배치에서 파일 탭들을 닫는다(삭제한 파일의 수정 없는 탭 — Q3). 닫은 탭 기록에는 넣지 않는다. */
  closeFiles: (input: { worktreePath: string; tabIds: readonly string[] }) => void
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

/** 화면에 내는 배치 — 저장값(없으면 살아 있는 탭 한 영역)을 살아 있는 탭에 맞춰 추리고 핀 접두부로 나눈다. 활성·비활성 worktree 가 같은 파생을 쓴다. */
function shownLayout(input: { saved: GroupLayout | undefined; liveTabIds: string[]; pinned: ReadonlySet<string> }): GroupLayout {
  const base = input.saved ?? singleLayout({ groupId: ROOT_GROUP, tabOrder: input.liveTabIds, activeTabId: input.liveTabIds[0] ?? null })
  return partitionPinnedLayout({ layout: reconcileLayout({ layout: base, liveTabIds: input.liveTabIds, pinned: input.pinned }), pinned: input.pinned })
}

export function useGroupLayout(input: {
  /** 지금 보고 있는 worktree 의 경로. 없으면 null. */
  worktreePath: string | null
  /** 그 worktree 에 **살아 있는** 탭들 (herdr 가 준 순서 그대로). */
  liveTabIds: string[]
  /** ui-prefs 를 다 실었나 — 싣기 전에 쓰면 저장값을 빈 것으로 지운다 (C13 과 같은 사고). */
  ready: boolean
  stored: unknown[]
  /** 핀 탭 (LIFE-495 K3ⓓ) — 화면에 내는 배치와 바꾸는 배치 모두 핀 접두부를 지난다(`partitionPinnedLayout`). */
  pinned: ReadonlySet<string>
  /** herdr 세션 전체의 산 탭 (LIFE-507 `AppState.herdrTabIds`) — null 이면 모른다(링크 live 아님). 여기 없는 탭은 저장 배치에서 걷는다. */
  herdrTabIds: readonly string[] | null
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
   * herdr 에 이제 없는 탭을 저장 배치에서 걷는다 (LIFE-507 — `dropDeadTabs`). 닫힌 워크스페이스의 탭 id 는 herdr 재기동 뒤 같은 worktree 의 새
   * 워크스페이스에 다시 쓰여 옛 배치에 새 탭이 앉는다(아래 「추리기는 화면용」 원칙의 예외 — 근거가 herdr 의 전체 목록이라 덜 온 상태가 아니다).
   * 싣기 전에는 하지 않는다. 같은 렌더의 싣기 effect 가 먼저 예약한 갱신 위에서 돈다(선언 순서).
   */
  useEffect(() => {
    if (!input.ready || !hydrated.current || input.herdrTabIds === null) return
    const live = new Set(input.herdrTabIds)
    setByWorktree((previous) => {
      let changed = false
      const next: Record<string, GroupLayout> = {}
      for (const [worktreePath, value] of Object.entries(previous)) {
        // 핀은 탭 id 키라 worktree 를 가리지 않는다 — 화면 순서로 이웃을 센다(LIFE-691 f1 B).
        const kept = dropDeadTabs({ layout: value, herdrTabIds: live, pinned: input.pinned })
        if (kept !== value) changed = true
        if (kept !== null) next[worktreePath] = kept
      }
      return changed ? next : previous
    })
  }, [input.ready, input.herdrTabIds])

  /**
   * 화면에 쓰는 배치 — 저장된 것을 **살아 있는 탭에 맞춰 추린 결과**다 (F1-6).
   *
   * 저장값을 직접 고치지 않고 파생시키는 이유: herdr 재기동으로 tabId 가 전부 바뀐 회차에
   * 저장값을 덮어쓰면 옛 배치가 영영 사라진다. 추리기는 화면용이고, 저장은 사용자가 실제로
   * 배치를 바꿨을 때만 한다.
   */
  const layout = useMemo<GroupLayout | null>(() => {
    if (input.worktreePath === null) return null
    return shownLayout({ saved: byWorktree[input.worktreePath], liveTabIds: input.liveTabIds, pinned: input.pinned })
  }, [byWorktree, input.worktreePath, input.liveTabIds, input.pinned])

  /**
   * 사용자가 바꾼 배치를 저장한다. 추린 결과가 아니라 **들고 있는 것**을 쓴다(위 주석).
   *
   * 초기값이 `''` 가 아니라 `'[]'` 인 것이 핵심이다 (r8-ordinal-wipe 와 **같은 사고**):
   * 싣기(hydrate)와 저장이 같은 렌더 패스의 effect 두 개라, 싣기가 `setState` 를 예약한 직후
   * 저장 effect 가 **아직 빈** `byWorktree` 를 보고 `groupLayouts: []` 를 파일에 쓴다. 그 한
   * 커밋 사이에 앱이 죽으면 저장된 배치가 사라진다. 빈 배열을 "이미 쓴 값"으로 두면 그 패스는
   * 조용히 지나간다.
   */
  const saved = useRef('[]')
  useEffect(() => {
    if (!input.ready || !hydrated.current) return
    // 영역별 탭 MRU(LIFE-691)는 메모리 전용 — 저장 JSON 에 싣지 않는다(형식 무변경).
    const rows = Object.entries(byWorktree).map(([worktreePath, value]) => ({ worktreePath, layout: withoutRecentTabs(value), layoutFormat: LAYOUT_FORMAT }))
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
      const pinned = input.pinned
      setByWorktree((previous) => {
        const base =
          previous[worktreePath] ?? singleLayout({ groupId: ROOT_GROUP, tabOrder: liveTabIds, activeTabId: liveTabIds[0] ?? null })
        // 화면이 보이는 순서(핀 접두부) 위에서 바꾼다 — 드롭 자리 index 가 그 순서로 계산됐다. 바꾼 뒤에도 한 번 더 지나 경계를 지킨다.
        // 영역별 탭 MRU(LIFE-691 R3)는 여기 한 자리에서 기록한다 — **바꾸기 전**(지금 화면의 활성: 재기동 직후 저장값의 활성·닫혀서 고른 활성·
        // 지난 mutate 가 바꾼 활성). 바꾼 뒤의 활성은 다음 mutate 의 「전」 이 넣는다 — 그 사이 그 탭이 떠나도 떠난 탭은 후보가 아니라 차이가 없다(f1 E).
        const current = trackRecentTabs(partitionPinnedLayout({ layout: reconcileLayout({ layout: base, liveTabIds, pinned }), pinned }))
        const next = partitionPinnedLayout({ layout: change(current), pinned })
        return next === previous[worktreePath] ? previous : { ...previous, [worktreePath]: next }
      })
    },
    [input.worktreePath, input.liveTabIds, input.pinned],
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

  const layoutOf = useCallback(
    (target: { worktreePath: string; liveTabIds: string[]; pinned: ReadonlySet<string> }) =>
      shownLayout({ saved: byWorktree[target.worktreePath], liveTabIds: target.liveTabIds, pinned: target.pinned }),
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
    (target: { groupId: string; tabId: string; direction: 'row' | 'column'; edge?: 'before' | 'after' }) =>
      mutate((current) =>
        splitGroupIn({
          layout: current,
          groupId: target.groupId,
          tabId: target.tabId,
          direction: target.direction,
          edge: target.edge,
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

  const moveTabWithinTabbar = useCallback(
    (target: { tabId: string; fromGroupId: string; toGroupId: string; index: number }) =>
      mutate((current) => moveTabWithinTabbarIn(current, target)),
    [mutate],
  )

  const mergeTabIntoGroup = useCallback(
    (target: { tabId: string; fromGroupId: string; toGroupId: string }) =>
      mutate((current) => mergeTabIntoGroupIn(current, target)),
    [mutate],
  )

  const splitGroupWithForeignTab = useCallback(
    (target: { tabId: string; fromGroupId: string; targetGroupId: string; direction: 'row' | 'column'; edge: 'before' | 'after' }) =>
      mutate((current) =>
        splitGroupWithForeignTabIn({
          layout: current,
          ...target,
          newGroupId: nextGroupId(listGroups(current.root).map((group) => group.groupId)),
        }),
      ),
    [mutate],
  )

  const placeTab = useCallback(
    (target: { tabId: string; groupId: string; index: number }) => mutate((current) => placeTabIn({ layout: current, ...target })),
    [mutate],
  )

  // 밀려난·닫힌 자리 알림은 **화면 배치**(`layout` — 저장값을 같은 파생으로 추린 것)에서 미리 셈한다 — 상태 갱신 함수 안에서 부르면 순수하지 않다.
  const openFile = useCallback(
    (target: { rel: string; preview: boolean; onReplaced?: (replaced: { rel: string; groupId: string; index: number }) => void }) => {
      const replaced = layout === null ? null : openFileTab({ layout, rel: target.rel, preview: target.preview }).replaced
      mutate((current) => openFileTab({ layout: current, rel: target.rel, preview: target.preview }).layout)
      if (replaced !== null) target.onReplaced?.(replaced)
    },
    [mutate, layout],
  )

  const keepFile = useCallback((tabId: string) => mutate((current) => keepFileTab({ layout: current, tabId })), [mutate])

  const closeFile = useCallback(
    (target: { tabId: string; onClosed?: (closed: { groupId: string; index: number; preview: boolean }) => void }) => {
      const closed = layout === null ? null : closeFileTab({ layout, tabId: target.tabId }).closed
      mutate((current) => closeFileTab({ layout: current, tabId: target.tabId }).layout)
      if (closed !== null) target.onClosed?.(closed)
    },
    [mutate, layout],
  )

  const reopenFile = useCallback(
    (target: { rel: string; groupId: string; index: number; preview: boolean }) => mutate((current) => reopenFileTab({ layout: current, ...target })),
    [mutate],
  )

  const retargetFiles = useCallback(
    (target: { worktreePath: string; from: string; to: string }) => {
      const shown = target.worktreePath === input.worktreePath ? layout : (byWorktree[target.worktreePath] ?? null)
      const moved = shown === null ? [] : retargetFileTabs({ layout: shown, from: target.from, to: target.to }).moved
      if (target.worktreePath === input.worktreePath) mutate((current) => retargetFileTabs({ layout: current, from: target.from, to: target.to }).layout)
      else
        setByWorktree((previous) => {
          const value = previous[target.worktreePath]
          if (value === undefined) return previous
          const next = retargetFileTabs({ layout: value, from: target.from, to: target.to }).layout
          return next === value ? previous : { ...previous, [target.worktreePath]: next }
        })
      return moved
    },
    [mutate, layout, byWorktree, input.worktreePath],
  )

  const fileLayoutOf = useCallback((worktreePath: string) => (worktreePath === input.worktreePath ? layout : (byWorktree[worktreePath] ?? null)), [layout, byWorktree, input.worktreePath])

  const closeFiles = useCallback(
    (target: { worktreePath: string; tabIds: readonly string[] }) => {
      if (target.tabIds.length === 0) return
      const close = (value: GroupLayout): GroupLayout => target.tabIds.reduce((current, tabId) => closeFileTab({ layout: current, tabId }).layout, value)
      if (target.worktreePath === input.worktreePath) {
        mutate(close)
        return
      }
      // 비활성 worktree 도 화면 순서(핀 접두부)로 이웃을 센다 — 활성 경로(`mutate`)와 같은 결(LIFE-691 f2 L). 핀은 탭 id 키라 worktree 를 가리지 않는다.
      const pinned = input.pinned
      setByWorktree((previous) => {
        const value = previous[target.worktreePath]
        if (value === undefined) return previous
        const shown = partitionPinnedLayout({ layout: value, pinned })
        const next = close(shown)
        return next === shown ? previous : { ...previous, [target.worktreePath]: next }
      })
    },
    [mutate, input.worktreePath, input.pinned],
  )

  return {
    layout,
    groups,
    activeGroupId: layout?.activeGroupId ?? null,
    groupCountOf,
    splitDirectionOf,
    layoutOf,
    setActiveGroup,
    setActiveTab,
    revealTab,
    splitGroup,
    closeGroup,
    setRatio,
    moveTabWithinTabbar,
    mergeTabIntoGroup,
    splitGroupWithForeignTab,
    placeTab,
    openFile,
    keepFile,
    closeFile,
    reopenFile,
    retargetFiles,
    fileLayoutOf,
    closeFiles,
  }
}
