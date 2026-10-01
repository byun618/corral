// 재정렬 지연 (LIFE-470 U3) — 활동 시각으로 움직이는 모드(Agent Activity·Recent·Project order Recent)에서 카드 자리를 3초 늦게
// 옮긴다(198 `use-sort-order.ts:24,57-79` `SORT_SETTLE_MS`). 판정은 `sidebar-sections.ts` `settleDecision` 순수 함수다.
// 지연 중에도 카드 **내용**은 최신이다 — 자리만 그대로 둔다(`applyShownLayout`). 상태가 계속 바뀌면 타이머가 다시 돈다(디바운스).
import { useEffect, useState } from 'react'
import type { SidebarView } from '../../../shared/sidebar-view.js'
import type { ManualOrder } from '../manual-order.js'
import {
  applyShownLayout,
  isActivityDriven,
  layoutSignature,
  settleDecision,
  SORT_SETTLE_MS,
  type LayoutSignature,
  type SidebarSection,
} from '../sidebar-sections.js'

export function useSettledSections(input: { sections: SidebarSection[]; view: SidebarView; order: ManualOrder }): SidebarSection[] {
  const next = layoutSignature(input)
  const [shown, setShown] = useState<LayoutSignature>(next)
  const decision = settleDecision({ shown, next, activityDriven: isActivityDriven(input.view) })

  useEffect(() => {
    switch (decision) {
      case 'same':
        return
      case 'now':
        setShown(next)
        return
      case 'settle': {
        const timer = setTimeout(() => setShown(next), SORT_SETTLE_MS)
        return () => clearTimeout(timer)
      }
    }
    // `next` 는 매 렌더 새 객체라 내용 문자열로만 다시 돈다.
  }, [decision, next.order, next.membership, next.options, next.manual])

  return decision === 'settle' ? applyShownLayout({ layout: shown.layout, sections: input.sections }) : input.sections
}
