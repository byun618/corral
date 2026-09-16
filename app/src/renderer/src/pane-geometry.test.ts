// pane 경계 되짚기·드래그 산술 (F2-2). 화면에 그 폭으로 서는지는 하네스가 본다.
//
// 좌표는 **실측값**이다 (`raw/claude/f2-panes.json`, 창 1400×900 · 셀 7.825×15):
// 2분할이면 서피스 135×53, 왼쪽 rect 68칸(내용 65)·오른쪽 67칸(내용 64).

import { describe, expect, it } from 'vitest'
import type { TerminalPaneView } from '../../shared/types.js'
import { firstCellsOf, innerCellsOf, numbersOf, reachOf, seamsOf, snapPaneSeam, type PaneSeam } from './pane-geometry.js'

/** 하나여야 하는 자리 — 없으면 시험이 거기서 죽어야 한다. */
const only = (seams: PaneSeam[]): PaneSeam => {
  if (seams.length !== 1) throw new Error(`경계가 ${seams.length}개다`)
  return seams[0] ?? (() => { throw new Error('경계가 없다') })()
}

const pane = (input: {
  id: string
  rect: [number, number, number, number]
  deco?: { x: number; y: number; w: number; h: number }
}): TerminalPaneView => {
  const [x, y, width, height] = input.rect
  const deco = input.deco ?? { x: 1, y: 1, w: 3, h: 2 }
  return {
    paneId: input.id,
    rect: { x, y, width, height },
    innerRect: { x: x + deco.x, y: y + deco.y, width: width - deco.w, height: height - deco.h },
    focused: false,
    mouseReporting: false,
  }
}

/** 실측 2분할. */
const left = pane({ id: 'p1', rect: [0, 0, 68, 53] })
const right = pane({ id: 'pR', rect: [68, 0, 67, 53] })

describe('경계 되짚기 (F2-1: 트리를 소유하지 않는다)', () => {
  it('맞닿은 두 pane 에서 경계 하나 — span 은 서피스 폭이다', () => {
    const seams = seamsOf([left, right])
    const seam = only(seams)
    expect(seam).toMatchObject({ direction: 'row', first: 'p1', second: 'pR', at: 68, start: 0, span: 135 })
    expect(seam.band).toEqual({ start: 0, end: 53 })
    expect(firstCellsOf(seam)).toBe(68)
  })

  it('한쪽이 또 쪼개져 있으면 span 은 그 **상자** 전체다 — 맞닿은 두 pane 폭 합이 아니다', () => {
    // [P1 | P2] | Q — 경계는 P2|Q 지만 왼쪽 상자는 P1+P2 다.
    const p1 = pane({ id: 'P1', rect: [0, 0, 34, 53] })
    const p2 = pane({ id: 'P2', rect: [34, 0, 34, 53] })
    const q = pane({ id: 'Q', rect: [68, 0, 67, 53] })
    const outer = only(seamsOf([p1, p2, q]).filter((seam) => seam.first === 'P2'))
    expect(outer).toMatchObject({ at: 68, start: 0, span: 135 })
    expect(firstCellsOf(outer)).toBe(68)
  })

  it('세로 분할이 낀 3분할 — 바깥 경계가 쌍 둘로 갈려도 둘 다 같은 분할을 겨눈다', () => {
    const top = pane({ id: 'p1', rect: [0, 0, 68, 27] })
    const bottom = pane({ id: 'pS', rect: [0, 27, 68, 26] })
    const side = pane({ id: 'pR', rect: [68, 0, 67, 53] })
    const seams = seamsOf([top, bottom, side])
    const outer = seams.filter((seam) => seam.direction === 'row')
    expect(outer.map((seam) => seam.first)).toEqual(['p1', 'pS'])
    // 둘 다 바깥 분할의 span·start 를 본다 — 겨누는 곳이 같다.
    for (const seam of outer) expect(seam).toMatchObject({ at: 68, start: 0, span: 135 })
    // 경계선 구간은 서로 다르다 — 위아래로 나눠 선다.
    expect(outer.map((seam) => seam.band)).toEqual([
      { start: 0, end: 27 },
      { start: 27, end: 53 },
    ])
    expect(only(seams.filter((seam) => seam.direction === 'column'))).toMatchObject({ first: 'p1', second: 'pS', at: 27, start: 0, span: 53 })
  })

  it('x 가 우연히 같은 서로 다른 분할 둘을 하나로 합치지 않는다', () => {
    // 위 행 [A|B], 아래 행 [D|E] — 경계 x 가 같지만 분할은 둘이다.
    const a = pane({ id: 'A', rect: [0, 0, 68, 27] })
    const b = pane({ id: 'B', rect: [68, 0, 67, 27] })
    const d = pane({ id: 'D', rect: [0, 27, 68, 26] })
    const e = pane({ id: 'E', rect: [68, 27, 67, 26] })
    const rows = seamsOf([a, b, d, e]).filter((seam) => seam.direction === 'row')
    expect(rows.map((seam) => [seam.first, seam.second])).toEqual([
      ['A', 'B'],
      ['D', 'E'],
    ])
    expect(rows.map((seam) => seam.band)).toEqual([
      { start: 0, end: 27 },
      { start: 27, end: 53 },
    ])
  })

  it('pane 하나면 경계가 없다', () => {
    expect(seamsOf([pane({ id: 'only', rect: [0, 0, 135, 53] })])).toEqual([])
  })
})

describe('드래그 산술 (실측 서버 규칙)', () => {
  const seam = only(seamsOf([left, right]))

  it('겨눈 칸 수가 그대로 배지가 되고, amount 는 칸 차이 / span 이다', () => {
    const snapped = snapPaneSeam({ seam, wantedFirstCells: 80 })
    expect(snapped.firstCells).toBe(80)
    expect(snapped.secondCells).toBe(55)
    expect(snapped.commit).toEqual({ direction: 'right', amount: 12 / 135 })
    // 서버 비율 r 이 얼마든 round(r × 135) = 68 이면 커밋 뒤 정확히 80 이 된다.
    for (const r of [67.5 / 135, 68 / 135, 68.49 / 135]) expect(Math.round((r + 12 / 135) * 135)).toBe(80)
  })

  it('부호는 direction 이 준다 — 줄일 때도 amount 는 양수다', () => {
    expect(snapPaneSeam({ seam, wantedFirstCells: 40 }).commit).toEqual({ direction: 'left', amount: 28 / 135 })
  })

  it('세로 경계는 down/up 이다', () => {
    const top = pane({ id: 't', rect: [0, 0, 135, 27] })
    const bottom = pane({ id: 'b', rect: [0, 27, 135, 26] })
    const column = only(seamsOf([top, bottom]))
    expect(snapPaneSeam({ seam: column, wantedFirstCells: 30 }).commit).toEqual({ direction: 'down', amount: 3 / 53 })
    expect(snapPaneSeam({ seam: column, wantedFirstCells: 20 }).commit).toEqual({ direction: 'up', amount: 7 / 53 })
  })

  it('제자리면 안 보낸다', () => {
    expect(snapPaneSeam({ seam, wantedFirstCells: 68 }).commit).toBeNull()
  })

  it('도달 구간 — [.1, .9] 클램프와 한 번에 0.5 상한의 교집합', () => {
    // span 135 · 지금 68 → 클램프 [14, 121], 상한 [68−67, 68+67] = [1, 135] → 클램프가 이긴다.
    expect(reachOf(seam)).toEqual({ min: 14, max: 121 })
    expect(snapPaneSeam({ seam, wantedFirstCells: 500 }).firstCells).toBe(121)
    expect(snapPaneSeam({ seam, wantedFirstCells: -20 }).firstCells).toBe(14)
  })

  it('한쪽으로 치우쳐 있으면 0.5 상한이 이긴다 — 한 번에 반대쪽 끝까지 못 간다', () => {
    // 실측: 0.9 에서 left 0.7 을 보내면 0.2 가 아니라 0.4 로 간다.
    const wide = pane({ id: 'w', rect: [0, 0, 122, 53] })
    const thin = pane({ id: 't', rect: [122, 0, 13, 53] })
    const tilted = only(seamsOf([wide, thin]))
    expect(firstCellsOf(tilted)).toBe(122)
    expect(reachOf(tilted)).toEqual({ min: 55, max: 121 })
    expect(snapPaneSeam({ seam: tilted, wantedFirstCells: 14 }).firstCells).toBe(55)
  })
})

describe('배지가 말하는 내용 칸 수', () => {
  const seam = only(seamsOf([left, right]))

  it('장식을 뺀 수다 — 상자가 커져도 장식 칸 수는 그대로다', () => {
    expect(innerCellsOf({ pane: left, direction: 'row', blockNow: 68, cells: 80 })).toBe(77)
    expect(innerCellsOf({ pane: right, direction: 'row', blockNow: 67, cells: 55 })).toBe(52)
    // 안 끌었을 때는 지금 내용 칸 수 그대로여야 한다.
    expect(innerCellsOf({ pane: left, direction: 'row', blockNow: 68, cells: firstCellsOf(seam) })).toBe(65)
  })

  it('그 쪽 상자를 pane 이 통째로 쓰지 않으면 숫자를 지어내지 않는다', () => {
    const half = pane({ id: 'P2', rect: [34, 0, 34, 53] })
    expect(innerCellsOf({ pane: half, direction: 'row', blockNow: 68, cells: 80 })).toBeNull()
  })
})

describe('pane 번호 (화면 읽는 순서)', () => {
  it('위에서 아래로, 같은 줄이면 왼쪽부터 — 목록 순서가 아니다', () => {
    // 실측에서 나온 모양: 왼쪽이 위아래로 갈리고 오른쪽이 통짜. id 는 뒤죽박죽이다.
    const right = pane({ id: 'w2:p0', rect: [83, 0, 52, 53] })
    const topLeft = pane({ id: 'w2:p1', rect: [0, 0, 83, 27] })
    const bottomLeft = pane({ id: 'w2:p11', rect: [0, 27, 83, 26] })
    const numbers = numbersOf([right, topLeft, bottomLeft])
    expect(numbers.get('w2:p1')).toBe(1)
    expect(numbers.get('w2:p0')).toBe(2)
    expect(numbers.get('w2:p11')).toBe(3)
  })

  it('입력 순서가 바뀌어도 번호는 그대로다', () => {
    const a = pane({ id: 'a', rect: [0, 0, 68, 53] })
    const b = pane({ id: 'b', rect: [68, 0, 67, 53] })
    expect([...numbersOf([a, b])]).toEqual([...numbersOf([b, a])])
  })
})
