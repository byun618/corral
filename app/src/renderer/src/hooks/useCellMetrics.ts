// 바닥 셀 크기를 화면 전체가 공유한다 (LIFE-373 §10-R13-c).
//
// 갱신 트리거 셋:
//   ① `document.fonts.ready` — 폰트가 늦게 실리면 첫 측정이 폴백 폰트의 셀이다
//   ② **DPR 변경** — 외장 모니터로 옮기거나 창을 다른 스케일의 화면으로 끌면 셀 px 이 바뀐다.
//      `matchMedia('(resolution: Xdppx)')` 를 현재 DPR 로 걸고, 벗어나면 다시 잰다
//   ③ 창 확대/축소(`zoomLevel`) — Electron 의 브라우저 줌도 ②의 resolution 쿼리를 흔든다
//
// 값이 바뀌면 이 훅을 쓰는 쪽이 **전 연결의 격자를 한 번씩** 다시 요청한다. 틀리면 전 pane 이
// 한꺼번에 어긋나므로 측정 실패는 폴백(목업 상수)으로 버티되 화면을 멈추지는 않는다.

import { useEffect, useState } from 'react'
import { FALLBACK_CELL, measureCellSize, type CellSize } from '../term-metrics.js'

export function useCellMetrics(): CellSize {
  const [cell, setCell] = useState<CellSize>(() => measureCellSize() ?? FALLBACK_CELL)

  useEffect(() => {
    let disposed = false
    const remeasure = (): void => {
      if (disposed) return
      const next = measureCellSize()
      if (next === null) return
      setCell((previous) => (previous.width === next.width && previous.height === next.height ? previous : next))
    }

    // ① 폰트 로딩
    void document.fonts?.ready.then(remeasure)

    // ②③ DPR·줌 — 지금 배율에 딱 맞는 쿼리를 걸고, 깨지는 순간 다시 잰다.
    let query: MediaQueryList | null = null
    const watchResolution = (): void => {
      query?.removeEventListener('change', onResolutionChange)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      query.addEventListener('change', onResolutionChange)
    }
    const onResolutionChange = (): void => {
      remeasure()
      watchResolution()
    }
    watchResolution()

    return () => {
      disposed = true
      query?.removeEventListener('change', onResolutionChange)
    }
  }, [])

  return cell
}
