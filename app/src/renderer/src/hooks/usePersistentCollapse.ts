// 접기 상태 영속 (C3) — "접힌 id 집합"을 ui-prefs.json 에 저장한다. 기본은 전부 펼침이라
// 빈 집합이 기본값이고, 접은 것만 기록한다(대부분 펼쳐 두는 쪽이 흔할 것이라는 가정 — 저장량 최소화).
//
// localStorage 가 아니라 `window.corral.getUiPrefs/setUiPrefs` 를 쓴다 — useSidebarResize.ts
// 와 같은 이유(C2 실측: 이 앱의 프로덕션 file:// 로드 경로에서 localStorage 가 재기동 후 사라진다).

import { useCallback, useEffect, useState } from 'react'
import type { UiPrefs } from '../../../shared/types.js'

/** LIFE-478: `pinnedWorktrees`(고정한 워크트리 경로)도 같은 모양 — 경로 집합 하나를 ui-prefs 에 통째로 쓴다. */
/** LIFE-576: `collapsedLineage`(「N 하위」 를 접은 부모 경로)도 같은 모양. */
type CollapseField = 'collapsedRepos' | 'collapsedGroups' | 'expandedAgentGroups' | 'pinnedWorktrees' | 'collapsedLineage'

/**
 * `field` 별로 독립된 id 집합 하나. repo 접기(C3ⓐ)가 쓰고, 에이전트 알약 펼침(LIFE-467)은 같은 모양을
 * **펼친 집합**으로 쓴다(`expandedAgentGroups` — 알약은 기본 접힘이라 펼친 것만 담는다).
 */
export function usePersistentCollapse(field: CollapseField): {
  has: (id: string) => boolean
  toggle: (id: string) => void
  /** 지금 집합 — 렌더마다 같은 객체(바뀔 때만 새 Set). */
  values: ReadonlySet<string>
  /** 집합에서 뺀다(없으면 그대로) — 삭제한 워크트리의 고정 정리(K5ⓗ). */
  remove: (id: string) => void
} {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let cancelled = false
    window.corral
      .getUiPrefs()
      .then((prefs: UiPrefs) => {
        if (cancelled) return
        setCollapsed(new Set(prefs[field]))
      })
      .catch(() => {
        // 읽기 실패 — 기본(전부 펼침) 유지.
      })
    return () => {
      cancelled = true
    }
  }, [field])

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        window.corral.setUiPrefs({ [field]: [...next] })
        return next
      })
    },
    [field],
  )

  const has = useCallback((id: string) => collapsed.has(id), [collapsed])

  const remove = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        window.corral.setUiPrefs({ [field]: [...next] })
        return next
      })
    },
    [field],
  )

  return { has, toggle, values: collapsed, remove }
}
