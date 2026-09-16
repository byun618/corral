// 바닥 셀 크기 측정 + 상자 px → 격자 셀 (LIFE-373 §10-R13).
//
// 새 렌더 파이프라인은 `영역 상자 px → 격자 셀 → 연결당 client.resize 1회 → 서피스 rect(셀) →
// pane DOM 상자`다. `fit()`→`termResize` 왕복 루프는 없앴지만 **바닥 셀 크기 측정은 남는다**
// (R13-c) — 여기가 그 자리다.
//
// 격자 산식은 FitAddon 의 `proposeDimensions` 를 그대로 옮긴 것이다. 옮긴 이유는 R13-a:
// *같은 창 크기에서 corral 이 요청하는 격자가 전환 전후 동일해야 한다*. 다른 산식을 쓰면
// 한 셀씩 어긋나고 그게 곧 C2 회귀다. 옮기면서 확인한 것:
//   · `scrollback: 0` 이면 FitAddon 의 오버뷰 룰러 폭 보정이 **0** 이다 (corral 이 그 설정이다)
//   · 보는 상자는 xterm 부모(여기서는 영역 상자)의 **content box**, 빼는 것은 `.xterm` 자신의 패딩
//
// 갱신 트리거 (R13-c): 폰트 로딩 완료 · DPR 변경 · 창 확대/축소. 갱신되면 전 연결이 격자를
// 한 번씩 다시 요청한다 — 여기서 틀리면 전 pane 이 한꺼번에 어긋난다.

import { Terminal } from '@xterm/xterm'

export type CellSize = { width: number; height: number }
export type Grid = { cols: number; rows: number }

/** 목업 상수 (`corral-pane-split.dc.html` CW·CH). 측정 전 첫 프레임에만 쓰인다. */
export const FALLBACK_CELL: CellSize = { width: 7.2, height: 20.4 }

export const TERM_FONT_SIZE = 13
export const TERM_FONT_FAMILY = 'SF Mono, Menlo, Monaco, monospace'

/**
 * xterm 이 **실제 렌더에 쓰는** 셀 크기. 공개 API 에 없어 비공개 코어를 읽는다 —
 * `TerminalPane.readCursorHidden` 과 같은 6.0.0 고정 전제이고, 이 함수 하나로 가둔다.
 * (FitAddon 도 같은 필드를 읽는다. 우리가 그 addon 을 안 쓸 뿐 숫자의 출처는 같다.)
 */
export function readCellSize(term: Terminal): CellSize | null {
  const core: unknown = Reflect.get(term, '_core')
  if (core === null || typeof core !== 'object') return null
  const renderService: unknown = Reflect.get(core, '_renderService')
  if (renderService === null || typeof renderService !== 'object') return null
  const dimensions: unknown = Reflect.get(renderService, 'dimensions')
  if (dimensions === null || typeof dimensions !== 'object') return null
  const css: unknown = Reflect.get(dimensions, 'css')
  if (css === null || typeof css !== 'object') return null
  const cell: unknown = Reflect.get(css, 'cell')
  if (cell === null || typeof cell !== 'object') return null
  const width: unknown = Reflect.get(cell, 'width')
  const height: unknown = Reflect.get(cell, 'height')
  if (typeof width !== 'number' || typeof height !== 'number') return null
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * 화면 밖에 xterm 하나를 잠깐 띄워 셀 크기를 잰다.
 *
 * pane 이 하나도 없을 때(부팅 직후)도 영역이 격자를 요청해야 하므로 **pane 과 무관한** 측정이
 * 필요하다. 만든 즉시 버린다 — 살아 있는 인스턴스를 남기면 그게 또 하나의 진실이 된다.
 */
export function measureCellSize(): CellSize | null {
  if (typeof document === 'undefined') return null
  const host = document.createElement('div')
  host.setAttribute('data-term-measure', '')
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:800px;height:400px;visibility:hidden'
  document.body.appendChild(host)
  const term = new Terminal({
    scrollback: 0,
    fontSize: TERM_FONT_SIZE,
    fontFamily: TERM_FONT_FAMILY,
    allowProposedApi: true,
  })
  try {
    term.open(host)
    return readCellSize(term)
  } finally {
    term.dispose()
    host.remove()
  }
}

/**
 * 상자 하나가 담을 수 있는 격자 (FitAddon `proposeDimensions` 이식).
 *
 * `elementPadding` 은 그 상자 안에 들어갈 `.xterm` 의 패딩이다 — corral 은 0 이지만 산식을
 * 옮겨 온 이상 자리를 남겨 둔다(토큰이 바뀌면 여기로 들어온다).
 */
export function gridForBox(input: { box: { width: number; height: number }; cell: CellSize; padding?: { x: number; y: number } }): Grid {
  const padding = input.padding ?? { x: 0, y: 0 }
  const availableWidth = Math.max(0, input.box.width - padding.x)
  const availableHeight = Math.max(0, input.box.height - padding.y)
  return {
    cols: Math.max(2, Math.floor(availableWidth / input.cell.width)),
    rows: Math.max(1, Math.floor(availableHeight / input.cell.height)),
  }
}

/** 요소의 **content box** 크기 — FitAddon 이 보던 `getComputedStyle(parent).width/height` 와 같다. */
export function contentBoxOf(element: HTMLElement): { width: number; height: number } {
  const style = window.getComputedStyle(element)
  const width = Math.max(0, Number.parseInt(style.getPropertyValue('width'), 10))
  const height = Math.max(0, Number.parseInt(style.getPropertyValue('height'), 10))
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  }
}
