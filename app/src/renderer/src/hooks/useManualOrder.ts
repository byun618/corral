// 사이드바 수동 순서의 상태·영속 (LIFE-469). 계산은 `manual-order.ts`, 끌기는 `useSidebarReorder` 가 한다.
//
// 읽기는 App 의 첫 `getUiPrefs` 에 얹는다(`hydrate`) — 배정표와 같은 읽기라 부트 화면이 내려가기 전에 순서가
// 서 있다(기본 순서로 한 번 그렸다가 튀지 않는다). 저장은 `ui-prefs.json` 의 두 칸(`manualRepoOrder`·`manualWorktreeOrder`).
//
// **첫 드래그 전에도 파일을 쓴다**(K6ⓒ): 읽은 뒤 첫 목록에서 지금 보이는 순서를 그대로 적어 둔다(materialize).
// 그래야 업그레이드 뒤 처음 생긴 워크트리·레포를 「새것」으로 알아보고 198 자리(워크트리 맨 위·레포 맨 아래)에
// 놓는다(K5). 적는 값이 지금 화면 순서 그대로라 화면은 바뀌지 않는다(K6ⓐ).

import { useCallback, useEffect, useState } from 'react'
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

export function useManualOrder(repos: readonly RepoRow[]): {
  order: ManualOrder
  /** 첫 `getUiPrefs` 결과(읽기 실패면 `null`)로 한 번 싣는다. 싣기 전에는 정규화·저장을 하지 않는다. */
  hydrate: (prefs: Pick<UiPrefs, 'manualRepoOrder' | 'manualWorktreeOrder'> | null) => void
  commit: (commit: ReorderCommit) => void
  forget: (root: string) => void
} {
  const [order, setOrder] = useState<ManualOrder | null>(null)

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
    const reconciled = reconcileManualOrder({ order, repos })
    if (!reconciled.changed) return
    setOrder(reconciled.order)
    persist(reconciled.order)
  }, [order, repos])

  const commit = useCallback((input: ReorderCommit) => {
    setOrder((prev) => {
      const base = prev ?? EMPTY_MANUAL_ORDER
      const source = input.source
      const next =
        source.kind === 'repo'
          ? applyRepoMove({ order: base, visibleRoots: input.keys, root: source.root, slot: input.slot })
          : applyWorktreeMove({ order: base, repoRoot: source.repoRoot, visiblePaths: input.keys, path: source.path, slot: input.slot })
      if (next === null) return prev
      persist(next)
      return next
    })
  }, [])

  const forget = useCallback((root: string) => {
    setOrder((prev) => {
      if (prev === null) return prev
      const next = forgetRepo({ order: prev, root })
      persist(next)
      return next
    })
  }, [])

  return { order: order ?? EMPTY_MANUAL_ORDER, hydrate, commit, forget }
}
