// LIFE-670 P4 — 상세 배치 판정(밀기/덮기 임계) 순수 시험.
import { describe, expect, it } from 'vitest'
import { detailLayout, pxToken } from './detail-push.js'

const panel = { panelWidth: 560, minBodyWidth: 320 }

describe('detailLayout', () => {
  it('닫혀 있으면 none, 전체 모드면 폭과 무관하게 full', () => {
    expect(detailLayout({ open: false, full: false, mainWidth: 1280, ...panel })).toBe('none')
    expect(detailLayout({ open: true, full: true, mainWidth: 1280, ...panel })).toBe('full')
    expect(detailLayout({ open: true, full: true, mainWidth: 600, ...panel })).toBe('full')
  })
  it('가용 폭(main − 560) ≥ 320 이면 밀기, 미만이면 덮기 — 경계 880 은 밀기', () => {
    expect(detailLayout({ open: true, full: false, mainWidth: 1280, ...panel })).toBe('push')
    expect(detailLayout({ open: true, full: false, mainWidth: 880, ...panel })).toBe('push')
    expect(detailLayout({ open: true, full: false, mainWidth: 879.5, ...panel })).toBe('overlay')
    expect(detailLayout({ open: true, full: false, mainWidth: 620, ...panel })).toBe('overlay')
  })
  it('같은 폭이면 같은 답 — 입력(테두리 상자 폭)이 상태에 따라 바뀌지 않으므로 번갈아 뛰지 않는다', () => {
    const widths = [879, 880, 881, 879, 880]
    expect(widths.map((mainWidth) => detailLayout({ open: true, full: false, mainWidth, ...panel }))).toEqual(['overlay', 'push', 'push', 'overlay', 'push'])
  })
  it('토큰을 못 읽으면 덮기(LIFE-602 동작)', () => {
    expect(detailLayout({ open: true, full: false, mainWidth: 1280, panelWidth: null, minBodyWidth: 320 })).toBe('overlay')
    expect(detailLayout({ open: true, full: false, mainWidth: 1280, panelWidth: 560, minBodyWidth: null })).toBe('overlay')
  })
})

describe('pxToken', () => {
  it('px 길이만 읽는다', () => {
    expect(pxToken(' 560px')).toBe(560)
    expect(pxToken('320px ')).toBe(320)
    expect(pxToken('')).toBeNull()
    expect(pxToken('40rem')).toBeNull()
  })
})
