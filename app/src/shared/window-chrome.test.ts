import { describe, expect, it } from 'vitest'
import { showsTrafficLightPad, trafficLightPosition } from './window-chrome.js'

describe('trafficLightPosition (LIFE-527 K1ⓐⓒ)', () => {
  it('줌 1 = Orca 창 옵션 {16, 12}', () => {
    expect(trafficLightPosition(1)).toEqual({ x: 16, y: 12 })
  })
  it('줌마다 y = floor(18×줌 − 6), x 는 그대로', () => {
    // Electron ⌘+ ⌘− 1단계 = 1.2^±0.5 (OS 캡처에서 잰 값 1.0954 · 0.9129)
    expect(trafficLightPosition(1.0954451150103321)).toEqual({ x: 16, y: 13 })
    expect(trafficLightPosition(0.9128709291752769)).toEqual({ x: 16, y: 10 })
    expect(trafficLightPosition(1.2)).toEqual({ x: 16, y: 15 })
    expect(trafficLightPosition(1.5)).toEqual({ x: 16, y: 21 })
    expect(trafficLightPosition(0.5)).toEqual({ x: 16, y: 3 })
  })
  it('신호등 버튼 틀(14pt) 중심이 띠 중심(18×줌)과 ±1 안 — K1ⓒ', () => {
    for (let level = -6; level <= 9; level += 0.5) {
      const zoom = 1.2 ** level
      const center = trafficLightPosition(zoom).y + 7
      expect(Math.abs(center - 18 * zoom)).toBeLessThanOrEqual(1)
    }
  })
  it('비정상 줌은 1 로 읽는다', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(trafficLightPosition(bad)).toEqual({ x: 16, y: 12 })
  })
})

describe('showsTrafficLightPad (LIFE-527 K1ⓓ)', () => {
  it('mac 이고 전체화면이 아닐 때만', () => {
    expect(showsTrafficLightPad({ mac: true, fullScreen: false, zoomFactor: 1 })).toBe(true)
    expect(showsTrafficLightPad({ mac: true, fullScreen: true, zoomFactor: 1 })).toBe(false)
    expect(showsTrafficLightPad({ mac: false, fullScreen: false, zoomFactor: 1 })).toBe(false)
  })
})
