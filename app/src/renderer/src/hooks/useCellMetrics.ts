// 바닥 셀 크기를 화면 전체가 공유한다 (LIFE-373 §10-R13-c).
//
// 갱신 트리거 셋:
//   ① `document.fonts.ready` — 폰트가 늦게 실리면 첫 측정이 폴백 폰트의 셀이다
//   ② **DPR 변경** — 외장 모니터로 옮기거나 창을 다른 스케일의 화면으로 끌면 셀 px 이 바뀐다.
//      `matchMedia('(resolution: Xdppx)')` 를 현재 DPR 로 걸고, 벗어나면 다시 잰다
//   ③ 창 확대/축소(`zoomLevel`) — Electron 의 브라우저 줌도 ②의 resolution 쿼리를 흔든다
//   ④ **글꼴 설정**(LIFE-512 K2) — 셀 크기를 바꾸는 값(크기·글꼴군·줄높이, `cellMetricKey`)이 바뀌면 다시 잰다.
//      첫 측정부터 저장값으로 잰다(`settings-store` 가 동기로 읽는다) — 시작 때 기본값 셀로 한 번 잰 뒤 다시 재는 2단이 없다(K2ⓔ).
//      굵기·테마·커서는 열쇠에 없다 — 바뀌어도 다시 재지 않고, 격자 요청도 나가지 않는다(K2ⓕ).
//
// 값이 바뀌면 이 훅을 쓰는 쪽이 **전 연결의 격자를 한 번씩** 다시 요청한다. 틀리면 전 pane 이
// 한꺼번에 어긋나므로 측정 실패는 폴백(목업 상수)으로 버티되 화면을 멈추지는 않는다.

import { useEffect, useRef, useState } from 'react'
import { cellMetricKey, terminalFontOptions } from '../../../shared/terminal-settings.js'
import { useSettings } from '../settings-store.js'
import { FALLBACK_CELL, measureCellSize, type CellSize } from '../term-metrics.js'

export function useCellMetrics(): CellSize {
  const settings = useSettings()
  const font = terminalFontOptions(settings)
  const fontRef = useRef(font)
  fontRef.current = font
  const metricKey = cellMetricKey(settings)
  const [cell, setCell] = useState<CellSize>(() => measureCellSize(font) ?? FALLBACK_CELL)

  // ④ 글꼴 설정 — 열쇠가 바뀐 렌더에서만 다시 잰다. 첫 렌더는 위 초기값이 이미 저장값으로 쟀다.
  const measuredKey = useRef(metricKey)
  useEffect(() => {
    if (measuredKey.current === metricKey) return
    measuredKey.current = metricKey
    const next = measureCellSize(fontRef.current)
    if (next === null) return
    setCell((previous) => (previous.width === next.width && previous.height === next.height ? previous : next))
  }, [metricKey])

  useEffect(() => {
    let disposed = false
    const remeasure = (): void => {
      if (disposed) return
      const next = measureCellSize(fontRef.current)
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
