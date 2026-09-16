// pane 상자 산술만 여기서 잰다 (LIFE-373 ②). 화면에 그 자리에 서는지는 F2 하네스가 본다.
//
// 지키려는 것:
//   ① 원점은 **내용의 왼쪽 위**다 — 서피스 (0,0) 이 아니다. herdr 서피스는 가장자리 장식만큼
//      상자보다 크고, main 이 그만큼 격자를 늘려 요청해 둔다
//   ② 이웃한 두 pane 은 같은 경계 값을 쓴다 (틈·겹침 0)
//   ③ 안쪽 상자는 **바깥 상자 기준**이다

import { describe, expect, it } from 'vitest'
import { __test } from './components/PaneLayout.js'
import { kindLabel } from './components/TerminalChrome.js'

const cell = { width: 7.825, height: 15 }
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const seat = (paneId: string, outer: ReturnType<typeof rect>, inner: ReturnType<typeof rect>) => ({
  view: { paneId, rect: outer, innerRect: inner, focused: false, mouseReporting: false },
  row: null,
  number: 1,
})

describe('pane 상자 (②)', () => {
  it('원점은 안쪽 사각형들의 왼쪽 위다 — 서피스 원점이 아니다', () => {
    const seats = [seat('p1', rect(0, 0, 68, 53), rect(1, 1, 65, 51)), seat('p2', rect(68, 0, 67, 53), rect(69, 1, 64, 51))]
    expect(__test.originOf(seats)).toEqual({ x: 1, y: 1 })
  })

  it('원점보다 앞선 장식 칸은 음수 — 잘려 나갈 자리다', () => {
    const place = __test.placeOf({ rect: rect(0, 0, 68, 53), cell, origin: { x: 1, y: 1 } })
    expect(place.left).toBe(`${-7.825}px`)
    expect(place.top).toBe('-15px')
    expect(place.width).toBe(`${68 * 7.825}px`)
  })

  it('이웃은 같은 경계 값을 쓴다 (틈·겹침 0)', () => {
    const origin = { x: 1, y: 1 }
    const first = __test.placeOf({ rect: rect(0, 0, 68, 53), cell, origin })
    const second = __test.placeOf({ rect: rect(68, 0, 67, 53), cell, origin })
    const rightEdge = Number.parseFloat(first.left) + Number.parseFloat(first.width)
    expect(Number.parseFloat(second.left)).toBeCloseTo(rightEdge, 9)
  })

  it('안쪽 상자는 바깥 상자 기준이다 — 격자 원점 기준으로 두면 형제 폭만큼 밀린다', () => {
    const view = seat('p2', rect(68, 0, 67, 53), rect(69, 1, 64, 51)).view
    const { outer, inner } = __test.geometryOf({ view, cell, origin: { x: 1, y: 1 }, zoomed: false })
    expect(outer.left).toBe(`${67 * 7.825}px`)
    // 격자 원점 기준이면 68 × 7.825 이 되는데 그건 바깥 상자 밖이다.
    expect(inner.left).toBe('7.825px')
    expect(inner.top).toBe('15px')
    // 장식은 좌우 3칸(67−64)·상하 2행(53−51).
    expect(inner.width).toBe(`calc(100% - ${3 * 7.825}px)`)
    expect(inner.height).toBe('calc(100% - 30px)')
  })

  it('줌 중인 pane 은 상자를 통째로 먹되 장식 띠는 남긴다', () => {
    const view = seat('p1', rect(0, 0, 50, 40), rect(1, 1, 47, 38)).view
    const { outer, inner } = __test.geometryOf({ view, cell, origin: { x: 1, y: 1 }, zoomed: true })
    expect(outer).toEqual({ left: '0px', top: '0px', width: '100%', height: '100%' })
    expect(inner.left).toBe('7.825px')
    expect(inner.width).toBe(`calc(100% - ${3 * 7.825}px)`)
    expect(inner.height).toBe('calc(100% - 30px)')
  })

  it('종류 라벨은 탭바와 같은 표에서 나온다 — 모르는 값은 셸 (스트립이 쓴다)', () => {
    expect(kindLabel('claude')).toBe('claude')
    expect(kindLabel(null)).toBe('셸')
    expect(kindLabel('듣도보도못한것')).toBe('셸')
  })
})
