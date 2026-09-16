// pane 경계(F2-2)의 **산술**. 화면도 DOM 도 모르고 셀 사각형만 본다.
//
// corral 은 pane 트리를 소유하지 않는다 (F2-1). 그래서 경계를 트리에서 읽지 않고 **그려진
// 사각형의 맞닿음**에서 되짚는다 — 두 pane 의 rect 가 딱 붙어 있으면 거기 경계가 하나 있다.
// 이건 트리를 짓는 게 아니라 herdr 가 그려 준 배치를 읽는 것이다.
//
// 서버 산술은 실측해서 안다 (`raw/claude/f2-resize-semantics.json`, 기준서 §10-R20-4):
//   - 부호는 `amount` 가 아니라 `direction` 이 준다 — `right -0.05` 도 +0.05 로 민다
//   - 한 번에 미는 양은 **0.5 상한** (0.9 에서 `left 0.7` → 0.4, 0.2 가 아니다)
//   - 비율 자체는 **[0.1, 0.9] 클램프**
//   - `rect = round(ratio × span)`
//
// 그래서 **셀 수로 계산하고 셀 수로 보낸다**: `amount = |목표칸 − 지금칸| / span`.
// 지금 비율을 픽셀에서 되짚지 않아도 되는 이유가 여기 있다 — 서버의 실제 비율 r 은
// `round(r × span) = 지금칸` 이므로 `r × span ∈ [지금칸 − .5, 지금칸 + .5)` 이고,
// 거기에 `(목표칸 − 지금칸)/span` 을 더하면 `round` 뒤에 정확히 목표칸이 된다. 오차가 상쇄된다.

import type { PaneDirection, TerminalCellRect, TerminalPaneView } from '../../shared/types.js'

/** 서버가 비율에 거는 클램프·상한 (실측값 — 위 주석). */
export const PANE_RATIO_MIN = 0.1
export const PANE_RATIO_MAX = 0.9
export const PANE_RESIZE_CAP = 0.5

/** 경계 하나. `direction` 은 ① 과 같은 어휘다 — `row` 는 좌우로 붙은 쌍(세로선). */
export type PaneSeam = {
  id: string
  direction: 'row' | 'column'
  /** 왼/위 pane — `pane.resize` 의 대상이다. */
  first: string
  second: string
  /** 경계의 셀 좌표 (서피스 기준). */
  at: number
  /** 분할 상자의 시작 셀 — `at - start` 가 첫 쪽 칸 수다. */
  start: number
  /** 분할 상자의 셀 수. `rect = round(ratio × span)` 의 그 span. */
  span: number
  /** 경계선이 서는 구간 (수직 축, 셀). */
  band: { start: number; end: number }
}

type Span = { start: number; end: number }

const along = (rect: TerminalCellRect, direction: 'row' | 'column'): Span =>
  direction === 'row' ? { start: rect.x, end: rect.x + rect.width } : { start: rect.y, end: rect.y + rect.height }

const across = (rect: TerminalCellRect, direction: 'row' | 'column'): Span =>
  direction === 'row' ? { start: rect.y, end: rect.y + rect.height } : { start: rect.x, end: rect.x + rect.width }

const overlap = (a: Span, b: Span): Span => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) })

/**
 * 분할 상자의 넓이 — 경계에서 **양쪽으로 번져 나가며** 잰다.
 *
 * `span` 은 맞닿은 두 pane 의 폭 합이 아니다. 한쪽이 또 쪼개져 있으면(`[P1|P2] | Q`) 그 쪽의
 * 상자는 `P2` 가 아니라 `P1+P2` 다. 그래서 경계에서 왼쪽으로, 오른쪽으로, 더 붙을 게 없을
 * 때까지 번진다. 번지는 대상은 **경계선 구간과 겹치는** pane 뿐이다 — 겹치지 않는 것은 다른
 * 분할의 식구라 이 상자에 안 든다.
 */
function extentOf(input: { panes: TerminalCellRect[]; direction: 'row' | 'column'; at: number; band: Span }): Span {
  const { panes, direction, at, band } = input
  const near = panes
    .filter((rect) => {
      const cross = overlap(across(rect, direction), band)
      return cross.end > cross.start
    })
    .map((rect) => along(rect, direction))
  const extent = { start: at, end: at }
  for (;;) {
    const before = near.filter((s) => s.end === extent.start).map((s) => s.start)
    const after = near.filter((s) => s.start === extent.end).map((s) => s.end)
    const start = before.length === 0 ? extent.start : Math.min(...before)
    const end = after.length === 0 ? extent.end : Math.max(...after)
    // 더 안 자라면 끝. 값이 안 바뀌는데 계속 돌면 무한 루프다.
    if (start === extent.start && end === extent.end) return extent
    extent.start = start
    extent.end = end
  }
}

/**
 * 맞닿은 pane 쌍마다 경계 하나.
 *
 * **쌍을 합치지 않는다.** 한 분할의 경계가 쌍 둘로 갈려 나오는 일은 있지만(왼쪽이 위아래로
 * 또 쪼개져 있으면 `(위,오)` 와 `(아래,오)`), 둘 다 같은 분할을 겨누므로 끌면 같은 결과가 된다.
 * 반대로 합쳐 버리면 **x 가 우연히 같은 서로 다른 분할 둘**(위 행과 아래 행이 같은 자리에서
 * 갈린 경우)이 경계 하나로 붙어, 끌면 한쪽만 움직이는 거짓말이 된다.
 */
export function seamsOf(panes: TerminalPaneView[]): PaneSeam[] {
  const rects = panes.map((pane) => pane.rect)
  const seams: PaneSeam[] = []
  for (const direction of ['row', 'column'] as const) {
    for (const a of panes) {
      for (const b of panes) {
        if (a.paneId === b.paneId) continue
        const one = along(a.rect, direction)
        const two = along(b.rect, direction)
        if (one.end !== two.start) continue
        const band = overlap(across(a.rect, direction), across(b.rect, direction))
        if (band.end <= band.start) continue
        const extent = extentOf({ panes: rects, direction, at: one.end, band })
        seams.push({
          id: `${a.paneId}|${b.paneId}`,
          direction,
          first: a.paneId,
          second: b.paneId,
          at: one.end,
          start: extent.start,
          span: extent.end - extent.start,
          band,
        })
      }
    }
  }
  return seams
}

/** 지금 첫 쪽 칸 수. */
export const firstCellsOf = (seam: PaneSeam): number => seam.at - seam.start

/**
 * **도달 가능한 칸 수 구간** — 이 밖으로는 한 번에 못 간다.
 *
 * 밖을 겨누면 서버가 덜 밀고, 그러면 배지가 말한 수와 커밋 결과가 갈린다 (결함 6 · C5-3 과
 * 같은 부류). 그래서 고스트를 아예 여기 가둔다.
 */
export function reachOf(seam: PaneSeam): { min: number; max: number } {
  const cap = Math.floor(PANE_RESIZE_CAP * seam.span)
  const now = firstCellsOf(seam)
  return {
    min: Math.max(Math.ceil(PANE_RATIO_MIN * seam.span), now - cap),
    max: Math.min(Math.floor(PANE_RATIO_MAX * seam.span), now + cap),
  }
}

export type PaneSnap = {
  /** 커밋 뒤 첫 쪽이 받을 칸 수 — 배지가 말하는 수다. */
  firstCells: number
  secondCells: number
  /** 보낼 것. 칸 수가 그대로면 `null` — 부를 이유가 없다. */
  commit: { direction: PaneDirection; amount: number } | null
}

/** 겨눈 칸 수를 도달 구간에 가두고, 보낼 `direction`·`amount` 까지 만든다. */
export function snapPaneSeam(input: { seam: PaneSeam; wantedFirstCells: number }): PaneSnap {
  const { seam } = input
  const reach = reachOf(seam)
  const first = Math.min(Math.max(input.wantedFirstCells, reach.min), reach.max)
  const now = firstCellsOf(seam)
  const grow = seam.direction === 'row' ? 'right' : 'down'
  const shrink = seam.direction === 'row' ? 'left' : 'up'
  return {
    firstCells: first,
    secondCells: seam.span - first,
    commit: first === now ? null : { direction: first > now ? grow : shrink, amount: Math.abs(first - now) / seam.span },
  }
}

/**
 * 배지에 쓸 **내용 칸 수** — 장식을 뺀 수다 (메타 행이 보이는 것과 같은 수).
 *
 * 그 쪽 상자를 pane 하나가 통째로 쓰고 있을 때만 셀 수가 말이 된다. 그 안이 또 쪼개져 있으면
 * 이 쌍이 겨누는 칸 수가 그 pane 의 것이 아니므로 **지어내지 않고 `null`** 을 준다 (① 의 `—`).
 *
 * 장식 칸 수(`rect − innerRect`)는 드래그 내내 안 변한다 — 테두리·스크롤바는 상자가 커져도
 * 그대로 한 칸이다. 그래서 겨눈 칸 수에서 그만큼만 뺀다.
 */
export function innerCellsOf(input: {
  pane: TerminalPaneView
  direction: 'row' | 'column'
  /** 지금 그 쪽 상자의 칸 수 — pane 이 이만큼이어야 상자를 통째로 쓰는 것이다. */
  blockNow: number
  /** 커밋 뒤 그 쪽 상자가 받을 칸 수. */
  cells: number
}): number | null {
  const { pane, direction, blockNow, cells } = input
  const outer = direction === 'row' ? pane.rect.width : pane.rect.height
  const inner = direction === 'row' ? pane.innerRect.width : pane.innerRect.height
  if (outer !== blockNow) return null
  return cells - (outer - inner)
}

/**
 * pane 번호 — **화면 읽는 순서**다 (위에서 아래로, 같은 줄이면 왼쪽부터).
 *
 * 목록 순서(herdr `pane.list`)를 쓰면 번호가 흔들린다: 실측에서 같은 스크립트를 두 번 돌렸는데
 * 한 번은 왼쪽 pane 이 1, 다음엔 2 였다 — 새 pane 이 받은 id(`w2:p0`)가 원래 pane(`w2:p1`)보다
 * 앞이라 목록에서 앞질렀다(herdr 가 비워진 id 를 재사용한다). 번호는 화면에서 셀 수 있어야
 * 쓸모가 있으므로 **그린 자리**에서 낸다.
 */
export function numbersOf(panes: TerminalPaneView[]): Map<string, number> {
  const order = [...panes].sort((a, b) => (a.rect.y === b.rect.y ? a.rect.x - b.rect.x : a.rect.y - b.rect.y))
  return new Map(order.map((pane, index) => [pane.paneId, index + 1]))
}
