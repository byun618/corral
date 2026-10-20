// 작업 상세 패널 배치 (LIFE-670 P1·P4) — `.tasks-main` 의 테두리 상자 폭을 재서 밀기/덮기를 고른다(판정은 `detail-push.ts`).
// 폭·토큰은 ResizeObserver 로 따라간다. 밀기는 안쪽 여백만 바꾸므로 잰 폭이 상태에 따라 흔들리지 않는다(되먹임 없음).
// 상태는 잰 폭이 아니라 「밀기가 들어가는가」 하나다 — 임계를 넘을 때만 바뀌어 창 크기 조절이 페이지를 매 프레임 다시 그리지 않는다(r1 L1).
// ResizeObserver 가 없거나 토큰을 못 읽으면(테스트 환경) 덮기 — LIFE-602 동작 그대로다.

import { useEffect, useRef, useState } from 'react'
import { detailLayout, pushFits, pxToken, type DetailLayout } from '../detail-push.js'

export function useDetailLayout({ mainRef, open, full }: { mainRef: React.RefObject<HTMLElement | null>; open: boolean; full: boolean }): DetailLayout {
  const [fits, setFits] = useState<boolean | null>(null)
  // 같은 값 setState 도 React 가 한 번 더 렌더할 수 있어(eager bailout 실패) 바뀔 때만 넣는다.
  const last = useRef<boolean | null>(null)
  useEffect(() => {
    const main = mainRef.current
    if (main === null) return
    const read = (): void => {
      const style = getComputedStyle(main)
      const next = pushFits({
        mainWidth: main.getBoundingClientRect().width,
        panelWidth: pxToken(style.getPropertyValue('--w-issue-detail')),
        minBodyWidth: pxToken(style.getPropertyValue('--w-tasks-body-min')),
      })
      if (next === last.current) return
      last.current = next
      setFits(next)
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(main)
    return () => observer.disconnect()
  }, [mainRef])
  return detailLayout({ open, full, fits })
}
