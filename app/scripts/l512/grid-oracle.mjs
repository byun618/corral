// 격리 드라이버의 기대 격자 (LIFE-512 fix2 R2-02) — 제품과 같은 산식이어야 한다.
// 제품: useCellMetrics 의 셀 = measureCellSize(오프스크린 측정 = probe 의 `measured`), 격자 = gridForBox({ box: contentBoxOf(상자), cell }).
// fix1 까지는 live 셀(xterm DOM 렌더 폭)로 나눠 typing 장면에서 제품보다 1열 많은 90 을 기대했다(제품 89 가 맞다 — codex r2).
export function expectedGridFor({ box, cell }) {
  if (!box || !cell) return null
  const width = Math.max(0, Number.parseInt(box.width, 10))
  const height = Math.max(0, Number.parseInt(box.height, 10))
  return { cols: Math.max(2, Math.floor(width / cell.width)), rows: Math.max(1, Math.floor(height / cell.height)) }
}

/** 관측 한 점의 기대 격자 — 상자 content px ÷ measured 셀. */
export function expectedGridOf(entry) {
  return expectedGridFor({ box: entry?.box ?? null, cell: entry?.probeCell?.measured ?? null })
}

/** 선언 한 줄(`g1:w1:t2:89x33 g2:…`)의 영역이 전부 기대 격자인가. */
export function declarationMatches({ declaration, expected }) {
  if (!expected || typeof declaration !== 'string' || declaration.trim() === '') return false
  return declaration.split(' ').filter(Boolean).every((group) => group.endsWith(`:${expected.cols}x${expected.rows}`))
}

/** herdr 분배 — pane cols 합 + 틈 = 기대 cols(틈은 기준 장면에서 잰 값), rows 는 전부 기대 rows. */
export function distributionMatches({ panes, expected, baseGap }) {
  if (!expected || !Array.isArray(panes) || panes.length === 0 || typeof baseGap !== 'number') return false
  const gap = expected.cols - panes.reduce((sum, pane) => sum + pane.cols, 0)
  return gap === baseGap && panes.every((pane) => pane.rows === expected.rows)
}

export function gapOf({ panes, expected }) {
  if (!expected || !Array.isArray(panes)) return null
  return expected.cols - panes.reduce((sum, pane) => sum + pane.cols, 0)
}
