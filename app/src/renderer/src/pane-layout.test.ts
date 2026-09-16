// pane 상자 산술만 여기서 잰다 (LIFE-373 ②). 화면에 그 자리에 서는지는 F2 하네스가 본다.
//
// 지키려는 것 두 가지:
//   ① 이웃한 두 pane 은 **같은 경계 값**을 쓴다 — 폭을 따로 반올림하면 셀이 7.825px 일 때 샌다
//   ② 격자 끝에 닿는 모서리는 `100%` — 셀 배수는 상자보다 최대 한 칸 짧다(격자가 floor 라서)

import { describe, expect, it } from 'vitest'
import { __test } from './components/PaneLayout.js'

const cell = { width: 7.825, height: 15 }
const grid = { cols: 100, rows: 40 }
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('pane 상자 (②)', () => {
  it('안쪽 경계는 셀 배수 px, 바깥 모서리는 상자 끝', () => {
    const left = __test.placeOf({ rect: rect(0, 0, 50, 40), cell, grid })
    expect(left).toEqual({ left: '0px', top: '0px', width: '391.25px', height: 'calc(100% - 0px)' })
    const right = __test.placeOf({ rect: rect(50, 0, 50, 40), cell, grid })
    expect(right.left).toBe('391.25px')
    // 오른쪽 끝은 셀 배수(782.5px)가 아니라 100% — 격자가 floor 라 상자가 그보다 넓다.
    expect(right.width).toBe('calc(100% - 391.25px)')
  })

  it('이웃은 같은 경계 값을 쓴다 (틈·겹침 0)', () => {
    const first = __test.placeOf({ rect: rect(0, 0, 33, 40), cell, grid })
    const second = __test.placeOf({ rect: rect(33, 0, 67, 40), cell, grid })
    // 첫 쪽의 오른쪽 끝 = 둘째 쪽의 왼쪽 시작. 각자 반올림하면 여기가 갈린다.
    expect(first.width).toBe(second.left)
  })

  it('세로 분할도 같다', () => {
    const top = __test.placeOf({ rect: rect(0, 0, 100, 20), cell, grid })
    expect(top).toMatchObject({ top: '0px', height: '300px', width: 'calc(100% - 0px)' })
    const bottom = __test.placeOf({ rect: rect(0, 20, 100, 20), cell, grid })
    expect(bottom.top).toBe('300px')
    expect(bottom.height).toBe('calc(100% - 300px)')
  })

  it('줌 중인 pane 은 상자를 통째로 먹되 장식 띠는 남긴다', () => {
    const view = {
      paneId: 'p1',
      rect: rect(0, 0, 50, 40),
      innerRect: rect(1, 1, 47, 38),
      focused: true,
      mouseReporting: false,
    }
    const { outer, inner } = __test.geometryOf({ view, cell, grid, zoomed: true })
    expect(outer).toEqual({ left: '0px', top: '0px', width: '100%', height: '100%' })
    // 장식은 좌우 3칸(50−47)·상하 2행(40−38). 안쪽 상자는 그만큼 깎인다.
    expect(inner.left).toBe('7.825px')
    expect(inner.top).toBe('15px')
    expect(inner.width).toBe('calc(100% - 23.475px)')
    expect(inner.height).toBe('calc(100% - 30px)')
  })

  it('종류 라벨은 탭바와 같은 표에서 나온다 — 모르는 값은 셸', () => {
    expect(__test.kindLabel({ agent: 'claude' })).toBe('claude')
    expect(__test.kindLabel({ agent: null })).toBe('셸')
    expect(__test.kindLabel(null)).toBe('셸')
    expect(__test.kindLabel({ agent: '듣도보도못한것' })).toBe('셸')
  })
})
