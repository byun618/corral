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
// 갱신 트리거 (R13-c): 폰트 로딩 완료 · DPR 변경 · 창 확대/축소 · **글꼴 설정 변경**(LIFE-512 K2). 갱신되면 전 연결이
// 격자를 한 번씩 다시 요청한다 — 여기서 틀리면 전 pane 이 한꺼번에 어긋난다.
//
// 글꼴 값은 이 파일에 없다(LIFE-512 K2ⓑ) — 렌더 xterm 과 측정이 같은 `terminalFontOptions(설정)` 을 받는다. 예전에는 여기 상수와
// `TerminalPane` 리터럴이 따로 있어(서로 import 없음) 하나만 고치면 측정 셀과 렌더 셀이 어긋났다.

import { Terminal } from '@xterm/xterm'
import type { TerminalFontOptions } from '../../shared/terminal-settings.js'

export type CellSize = { width: number; height: number }
export type Grid = { cols: number; rows: number }

/** 목업 상수 (`corral-pane-split.dc.html` CW·CH). 측정 전 첫 프레임에만 쓰인다. */
export const FALLBACK_CELL: CellSize = { width: 7.2, height: 20.4 }

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
export function measureCellSize(font: TerminalFontOptions): CellSize | null {
  if (typeof document === 'undefined') return null
  const host = document.createElement('div')
  host.setAttribute('data-term-measure', '')
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:800px;height:400px;visibility:hidden'
  document.body.appendChild(host)
  const term = new Terminal({
    scrollback: 0,
    ...font,
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

/**
 * 영역 경계 드래그를 **셀에 붙인다** (F1-2 "셀 최소치 우선" · 핸드오프 §1-3 "고스트 + 셀 스냅 + 배지").
 *
 * 경계는 아무 px 에나 설 수 있지만 터미널은 셀 단위로만 자란다 — 셀 경계가 아닌 자리에 세우면
 * 남는 px 이 그냥 버려지고, 같은 드래그를 두 번 해도 같은 격자가 안 나온다. 그래서 커서 위치를
 * 받아 **첫 쪽 터미널이 정확히 몇 칸인가**로 바꾸고, 그 칸 수가 만드는 px 을 되돌려 준다.
 *
 * `overhead` 는 그 쪽 상자에서 터미널이 아닌 부분이다(세로 분할의 헤더 등). 실제 DOM 에서 재서
 * 넣는다 — 상수로 적으면 헤더 높이 토큰이 바뀔 때 조용히 어긋난다.
 *
 * 최소치: 격자 산식(`gridForBox`)이 보장하는 바닥과 같다 — 가로 2칸, 세로 1칸. 비율 클램프
 * (.15~.85)보다 **이쪽이 우선**이라, 클램프 안이어도 한 쪽이 바닥 밑으로 내려가면 한 칸 물린다.
 *
 * ⚠ 셀 **경계 위**가 아니라 **칸 한가운데**에 세운다 (`+ unit / 2`). 경계에 딱 세우면 한 칸을
 * 잃는다 — `contentBoxOf` 가 FitAddon 과 같은 `parseInt(getComputedStyle().width)` 라 소수점을
 * 버리기 때문이다. 실측(raw/claude/f1-groups.json 경계드래그): 54칸을 겨냥해 422.547px 에 세웠더니
 * `parseInt` 가 422 로 깎아 `floor(422 / 7.825) = 53` 이 요청됐다. 배지는 54, 화면은 53.
 * 산식을 고칠 수도 있지만 그건 C2(전환 전후 같은 격자)를 건드리는 길이라 **여기서 반 칸 비켜선다**.
 * 반 칸은 3~4px, 눈에 안 보이고, 그 대신 끄는 칸 수와 실제 격자가 늘 같아진다.
 */
export function snapSplitRatio(input: {
  /** 분할 상자의 축 길이 px (경계선은 음수 마진이라 자리를 안 먹는다). */
  total: number
  /** 커서가 가리키는 첫 쪽 길이 px. */
  wanted: number
  /** 첫 쪽·둘째 쪽에서 터미널이 아닌 부분 px. */
  overhead: { first: number; second: number }
  /** 셀 한 칸 px — 가로 분할이면 `cell.width`, 세로면 `cell.height`. */
  unit: number
  /** 이 축의 셀 바닥 (가로 2 · 세로 1). */
  minCells: number
  clamp: { min: number; max: number }
}): { ratio: number; first: number; second: number } {
  // 화면이 실제로 세는 방식과 **같은 손실**을 먹인다 — 상자 px 은 `parseInt` 로 깎여서 들어온다.
  const cellsIn = (span: number): number => Math.floor(Math.floor(Math.max(0, span)) / input.unit)
  const cellsAt = (first: number): number => cellsIn(first - input.overhead.first)
  const secondCellsAt = (first: number): number => cellsIn(input.total - first - input.overhead.second)
  const pxFor = (cells: number): number => input.overhead.first + cells * input.unit + input.unit / 2

  const lowPx = input.total * input.clamp.min
  const highPx = input.total * input.clamp.max
  let cells = cellsAt(Math.min(Math.max(input.wanted, lowPx), highPx))
  // 바닥 먼저 — 비율 클램프 안이어도 한 쪽이 최소 칸을 못 채우면 밀어낸다.
  const maxCells = cellsAt(input.total - input.overhead.second - input.minCells * input.unit)
  cells = Math.max(input.minCells, Math.min(cells, Math.max(input.minCells, maxCells)))
  // 반 칸 비켜선 자리가 클램프를 넘을 수 있다 — 넘으면 한 칸 물린다. 클램프가 얼어 있는 수다.
  while (cells > input.minCells && pxFor(cells) > highPx) cells -= 1
  while (pxFor(cells) < lowPx && cells < maxCells) cells += 1
  const first = pxFor(cells)
  return {
    ratio: input.total <= 0 ? input.clamp.min : Math.min(Math.max(first / input.total, 0), 1),
    first: cells,
    second: Math.max(0, secondCellsAt(first)),
  }
}
