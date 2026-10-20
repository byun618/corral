// 작업 상세 패널 배치 (LIFE-670 P1·P4) — `.tasks-main` 의 테두리 상자 폭을 재서 밀기/덮기를 고른다(판정은 `detail-push.ts`).
// 폭·토큰은 ResizeObserver 로 따라간다. 밀기는 안쪽 여백만 바꾸므로 잰 폭이 상태에 따라 흔들리지 않는다(되먹임 없음).
// ResizeObserver 가 없거나 토큰을 못 읽으면(테스트 환경) 덮기 — LIFE-602 동작 그대로다.

import { useEffect, useState } from 'react'
import { detailLayout, pxToken, type DetailLayout } from '../detail-push.js'

type Measure = { mainWidth: number; panelWidth: number | null; minBodyWidth: number | null }

export function useDetailLayout({ mainRef, open, full }: { mainRef: React.RefObject<HTMLElement | null>; open: boolean; full: boolean }): DetailLayout {
  const [measure, setMeasure] = useState<Measure | null>(null)
  useEffect(() => {
    const main = mainRef.current
    if (main === null) return
    const read = (): void => {
      const style = getComputedStyle(main)
      const next = {
        mainWidth: main.getBoundingClientRect().width,
        panelWidth: pxToken(style.getPropertyValue('--w-issue-detail')),
        minBodyWidth: pxToken(style.getPropertyValue('--w-tasks-body-min')),
      }
      setMeasure((prev) => (prev !== null && prev.mainWidth === next.mainWidth && prev.panelWidth === next.panelWidth && prev.minBodyWidth === next.minBodyWidth ? prev : next))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(main)
    return () => observer.disconnect()
  }, [mainRef])
  return detailLayout({ open, full, mainWidth: measure?.mainWidth ?? 0, panelWidth: measure?.panelWidth ?? null, minBodyWidth: measure?.minBodyWidth ?? null })
}
