// LIFE-682 A10 — 오른쪽 패널 렌더 폭: min(기억한 폭, 창 − 사이드바 − 가운데 최소), 최소 220. 기억값은 바꾸지 않는다.
import { describe, expect, it } from 'vitest'
import { panelDragMax, panelRenderWidth } from './right-panel-width.js'

const base = { sidebarWidth: 280, mainMin: 400, min: 220 }

describe('panelRenderWidth (A10)', () => {
  it('넓은 창 = 기억한 폭 그대로', () => {
    expect(panelRenderWidth({ ...base, stored: 560, windowWidth: 1280 })).toBe(560)
  })
  it('남는 폭이 모자라면 깎아 가운데 영역이 400 을 지킨다(1100 − 280 − 400 = 420)', () => {
    expect(panelRenderWidth({ ...base, stored: 560, windowWidth: 1100 })).toBe(420)
  })
  it('220 에서 멈춘다 — 그보다 좁은 창은 가운데가 400 아래로 내려간다(극단 폭)', () => {
    expect(panelRenderWidth({ ...base, stored: 560, windowWidth: 800 })).toBe(220)
  })
  it('사이드바를 접으면(0) 그만큼 넓게', () => {
    expect(panelRenderWidth({ ...base, sidebarWidth: 0, stored: 560, windowWidth: 900 })).toBe(500)
  })
  it('창을 다시 넓히면 기억한 폭으로 — 입력이 같으면 결과가 같다(떨림 없음)', () => {
    const narrow = panelRenderWidth({ ...base, stored: 560, windowWidth: 1000 })
    const wide = panelRenderWidth({ ...base, stored: 560, windowWidth: 1600 })
    expect(narrow).toBe(320)
    expect(wide).toBe(560)
    for (let width = 1230; width <= 1250; width += 1) {
      expect(panelRenderWidth({ ...base, stored: 560, windowWidth: width })).toBe(panelRenderWidth({ ...base, stored: 560, windowWidth: width }))
    }
  })
  it('임계 근처 20 샘플 — 단조(창이 1 넓어지면 폭은 줄지 않는다)이고 가운데 = 창 − 사이드바 − 패널 ≥ 400', () => {
    let previous = 0
    for (let width = 1230; width < 1250; width += 1) {
      const panel = panelRenderWidth({ ...base, stored: 560, windowWidth: width })
      expect(panel).toBeGreaterThanOrEqual(previous)
      expect(width - base.sidebarWidth - panel).toBeGreaterThanOrEqual(400)
      previous = panel
    }
  })
})

describe('panelDragMax (A10 — 끌기 상한)', () => {
  it('토큰 상한과 남는 폭 중 작은 쪽, 220 아래로는 안 내린다', () => {
    expect(panelDragMax({ ...base, max: 640, windowWidth: 1600 })).toBe(640)
    expect(panelDragMax({ ...base, max: 640, windowWidth: 1100 })).toBe(420)
    expect(panelDragMax({ ...base, max: 640, windowWidth: 700 })).toBe(220)
  })
})
