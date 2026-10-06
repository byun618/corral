import { describe, expect, it } from 'vitest'
import { showsTrafficLightPad, trafficLightPosition } from './window-chrome.js'

describe('trafficLightPosition (LIFE-527 K1ⓐⓒ)', () => {
  it('줌 1 = Orca 창 옵션 {16, 12}', () => {
    expect(trafficLightPosition(1)).toEqual({ x: 16, y: 12 })
  })
  it('줌 단계마다 y = round(18×줌 − 6), x 는 그대로', () => {
    // Chromium 줌 단계(⌘+ ⌘−): 0.9 · 1.1 · 1.25 · 1.5
    expect(trafficLightPosition(1.1)).toEqual({ x: 16, y: 14 })
    expect(trafficLightPosition(1.25)).toEqual({ x: 16, y: 17 })
    expect(trafficLightPosition(1.5)).toEqual({ x: 16, y: 21 })
    expect(trafficLightPosition(0.9)).toEqual({ x: 16, y: 10 })
    expect(trafficLightPosition(0.5)).toEqual({ x: 16, y: 3 })
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
