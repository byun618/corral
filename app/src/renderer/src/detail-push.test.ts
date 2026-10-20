// LIFE-670 P4 — 상세 배치 판정(밀기/덮기 임계) 순수 시험.
import { describe, expect, it } from 'vitest'
import { detailLayout, pushFits, pxToken } from './detail-push.js'

const tokens = { panelWidth: 560, minBodyWidth: 400 }

describe('pushFits', () => {
  it('가용 폭(main − 560) ≥ 400 이면 true — 경계 960 은 밀기, 959.5 는 덮기', () => {
    expect(pushFits({ mainWidth: 1280, ...tokens })).toBe(true)
    expect(pushFits({ mainWidth: 960, ...tokens })).toBe(true)
    expect(pushFits({ mainWidth: 959.5, ...tokens })).toBe(false)
    expect(pushFits({ mainWidth: 620, ...tokens })).toBe(false)
  })
  it('같은 쪽 폭 변화는 같은 값 — 상태가 바뀌지 않아 재렌더하지 않는다(r1 L1)', () => {
    expect(new Set([1000, 1100, 1280, 1920].map((mainWidth) => pushFits({ mainWidth, ...tokens }))).size).toBe(1)
    expect(new Set([700, 800, 959].map((mainWidth) => pushFits({ mainWidth, ...tokens }))).size).toBe(1)
  })
  it('같은 폭이면 같은 답 — 입력(테두리 상자 폭)이 상태에 따라 바뀌지 않으므로 번갈아 뛰지 않는다', () => {
    expect([959, 960, 961, 959, 960].map((mainWidth) => pushFits({ mainWidth, ...tokens }))).toEqual([false, true, true, false, true])
  })
  it('토큰을 못 읽으면 null', () => {
    expect(pushFits({ mainWidth: 1280, panelWidth: null, minBodyWidth: 400 })).toBeNull()
    expect(pushFits({ mainWidth: 1280, panelWidth: 560, minBodyWidth: null })).toBeNull()
  })
})

describe('detailLayout', () => {
  it('닫혀 있으면 none, 전체 모드면 폭과 무관하게 full', () => {
    expect(detailLayout({ open: false, full: false, fits: true })).toBe('none')
    expect(detailLayout({ open: true, full: true, fits: true })).toBe('full')
    expect(detailLayout({ open: true, full: true, fits: false })).toBe('full')
  })
  it('들어가면 밀기, 안 들어가거나 모르면 덮기(LIFE-602 동작)', () => {
    expect(detailLayout({ open: true, full: false, fits: true })).toBe('push')
    expect(detailLayout({ open: true, full: false, fits: false })).toBe('overlay')
    expect(detailLayout({ open: true, full: false, fits: null })).toBe('overlay')
  })
})

describe('pxToken', () => {
  it('px 길이만 읽는다', () => {
    expect(pxToken(' 560px')).toBe(560)
    expect(pxToken('400px ')).toBe(400)
    expect(pxToken('')).toBeNull()
    expect(pxToken('40rem')).toBeNull()
  })
})
