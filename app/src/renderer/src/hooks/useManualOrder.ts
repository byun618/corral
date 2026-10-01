// 사이드바 수동 순서의 상태·영속 (LIFE-469). 계산은 `manual-order.ts`, 끌기는 `useSidebarReorder` 가 한다.
//
// 읽기는 App 의 첫 `getUiPrefs` 에 얹는다(`hydrate`) — 배정표와 같은 읽기라 부트 화면이 내려가기 전에 순서가
// 서 있다(기본 순서로 한 번 그렸다가 튀지 않는다). 저장은 `ui-prefs.json` 의 두 칸(`manualRepoOrder`·`manualWorktreeOrder`).
//
// **첫 드래그 전에도 파일을 쓴다**(K6ⓒ): 읽은 뒤 첫 목록에서 지금 보이는 순서를 그대로 적어 둔다(materialize).
// 그래야 업그레이드 뒤 처음 생긴 워크트리·레포를 「새것」으로 알아보고 198 자리(워크트리 맨 위·레포 맨 아래)에
// 놓는다(K5). 적는 값이 지금 화면 순서 그대로라 화면은 바뀌지 않는다(K6ⓐ).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepoRow, UiPrefs } from '../../../shared/types.js'
import {
  applyRepoMove,
  applyWorktreeMove,
  EMPTY_MANUAL_ORDER,
  forgetRepo,
  readKeyList,
  readWorktreeOrder,
  reconcileManualOrder,
  type ManualOrder,
} from '../manual-order.js'
import type { ReorderCommit } from './useSidebarReorder.js'

function persist(order: ManualOrder): void {
  window.corral.setUiPrefs({ manualRepoOrder: order.repos, manualWorktreeOrder: order.worktrees })
}

function applyCommit(input: { order: ManualOrder; commit: ReorderCommit }): ManualOrder | null {
  const { order, commit } = input
  const source = commit.source
  switch (source.kind) {
    case 'repo':
      return applyRepoMove({ order, visibleRoots: commit.keys, root: source.root, slot: commit.slot })
    case 'card':
      return applyWorktreeMove({ order, repoRoot: source.repoRoot, visiblePaths: commit.keys, path: source.path, slot: commit.slot })
  }
}

/** 지금 상태의 레지스트리 — 등록된 root 와 그 세대(`AppState.registry.roots` · `registryGeneration`). */
export type RegistrySnapshot = { roots: readonly string[]; generation: number }

export function useManualOrder(input: { repos: readonly RepoRow[]; registry: RegistrySnapshot }): {
  order: ManualOrder
  /** 첫 `getUiPrefs` 결과(읽기 실패면 `null`)로 한 번 싣는다. 싣기 전에는 정규화·저장을 하지 않는다. */
  hydrate: (prefs: Pick<UiPrefs, 'manualRepoOrder' | 'manualWorktreeOrder'> | null) => void
  commit: (commit: ReorderCommit) => void
  /** GUI 제거 성공 뒤 — `registryGeneration` 은 제거 응답의 세대(없으면 `null`). */
  forget: (removed: { root: string; registryGeneration: number | null }) => void
} {
  const { repos, registry } = input
  const [order, setOrder] = useState<ManualOrder | null>(null)
  /**
   * GUI 로 제거했지만 목록에는 아직 남은 레포 root → 제거가 반영된 레지스트리 세대(R1-04·R2-01). 제거 IPC 는 트리
   * 재조립(main `scheduleTree`, 80ms 뒤)보다 먼저 답하므로, 그 사이 정규화가 옛 목록을 보고 키를 다시 끼우지 않게 뺀다.
   * 내리는 때는 둘 중 먼저 오는 것 — 시간으로는 내리지 않는다(옛 스냅샷이 R1-04 를 다시 연다):
   *   · 목록에서 그 root 가 사라진 걸 본다(제거가 트리에 반영됨)
   *   · 레지스트리가 제거 **뒤 세대**인데 그 root 가 다시 등록돼 있다(재등록 — main 은 80ms 예약을 합치고 낡은 세대의
   *     조립을 버리므로 「root 없는 스냅샷」이 오지 않을 수 있다, R2-01). 이때 키는 이미 지웠으니 새 레포로(맨 아래) 들어온다.
   */
  const removingRef = useRef(new Map<string, number | null>())

  const hydrate = useCallback((prefs: Pick<UiPrefs, 'manualRepoOrder' | 'manualWorktreeOrder'> | null) => {
    setOrder(
      prefs === null
        ? EMPTY_MANUAL_ORDER
        : { repos: readKeyList(prefs.manualRepoOrder), worktrees: readWorktreeOrder(prefs.manualWorktreeOrder) },
    )
  }, [])

  // 목록이 바뀔 때(기동·새로고침·워크트리 생성/삭제) — 새 키만 끼우고 저장된 상대 순서는 그대로 둔다(C1).
  useEffect(() => {
    if (order === null) return
    const removing = removingRef.current
    for (const [root, removedAt] of removing) {
      const gone = !repos.some((repo) => repo.root === root)
      const reRegistered = removedAt !== null && registry.generation > removedAt && registry.roots.includes(root)
      if (gone || reRegistered) removing.delete(root)
    }
    const listed = removing.size === 0 ? repos : repos.filter((repo) => !removing.has(repo.root))
    const reconciled = reconcileManualOrder({ order, repos: listed })
    if (!reconciled.changed) return
    setOrder(reconciled.order)
    persist(reconciled.order)
  }, [order, repos, registry.roots, registry.generation])

  const commit = useCallback((input: ReorderCommit) => {
    setOrder((prev) => {
      const base = prev ?? EMPTY_MANUAL_ORDER
      const next = applyCommit({ order: base, commit: input })
      if (next === null) return prev
      persist(next)
      return next
    })
  }, [])

  const forget = useCallback((removed: { root: string; registryGeneration: number | null }) => {
    const { root } = removed
    removingRef.current.set(root, removed.registryGeneration)
    setOrder((prev) => {
      if (prev === null) return prev
      const next = forgetRepo({ order: prev, root })
      persist(next)
      return next
    })
  }, [])

  return { order: order ?? EMPTY_MANUAL_ORDER, hydrate, commit, forget }
}
