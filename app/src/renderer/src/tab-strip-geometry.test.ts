// @vitest-environment happy-dom
// LIFE-494 K1 — dock 쪽·reveal·스크롤 앵커. happy-dom 에는 레이아웃이 없어 작은 가짜 레이아웃을 씌운다:
// 탭은 폭대로 왼쪽부터 늘어서고(스트립 x = 0), `[data-active-tab-dock]` 탭은 sticky 처럼 뷰포트 안으로 잘려 그려진다.
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureTabStripScrollAnchor,
  findOffscreenOpenedSlot,
  isLastTabStripSlot,
  readTabStripSlotIds,
  restoreTabStripScrollAnchor,
  revealTabStripSlot,
  tabStripDockSide,
} from './tab-strip-geometry.js'

const rect = (left: number, width: number): DOMRect => DOMRect.fromRect({ x: left, y: 0, width, height: 32 })

function fakeStrip(input: { widths: number[]; viewWidth: number; dockIndex?: number; scrollLeft?: number }): HTMLElement {
  const strip = document.createElement('div')
  let scrollLeft = input.scrollLeft ?? 0
  const total = input.widths.reduce((sum, width) => sum + width, 0)
  const maxScroll = Math.max(0, total - input.viewWidth)
  Object.defineProperty(strip, 'clientWidth', { get: () => input.viewWidth })
  Object.defineProperty(strip, 'clientLeft', { get: () => 0 })
  Object.defineProperty(strip, 'scrollWidth', { get: () => Math.max(total, input.viewWidth) })
  Object.defineProperty(strip, 'scrollLeft', {
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = Math.max(0, Math.min(maxScroll, value))
    },
  })
  strip.getBoundingClientRect = () => rect(0, input.viewWidth)
  let offset = 0
  input.widths.forEach((width, index) => {
    const tab = document.createElement('div')
    tab.dataset.mainTab = `t${index}`
    if (index === input.dockIndex) tab.setAttribute('data-active-tab-dock', '')
    const naturalLeft = offset
    tab.getBoundingClientRect = () => {
      const left = naturalLeft - scrollLeft
      if (!tab.hasAttribute('data-active-tab-dock')) return rect(left, width)
      // sticky left:0 right:0 — 뷰포트 안으로 잘려 붙는다.
      return rect(Math.min(Math.max(left, 0), input.viewWidth - width), width)
    }
    strip.append(tab)
    offset += width
  })
  document.body.append(strip)
  return strip
}

const slot = (strip: HTMLElement, index: number): HTMLElement => {
  const node = strip.querySelector<HTMLElement>(`[data-main-tab="t${index}"]`)
  if (node === null) throw new Error(`no t${index}`)
  return node
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('dock 쪽', () => {
  it('활성 탭 자리가 화면 안이면 null', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 1 })
    expect(tabStripDockSide(strip)).toBeNull()
  })

  it('지나간 쪽 — 앞으로 스크롤되어 사라지면 start, 뒤쪽이면 end', () => {
    expect(tabStripDockSide(fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 0, scrollLeft: 200 }))).toBe('start')
    expect(tabStripDockSide(fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 4, scrollLeft: 0 }))).toBe('end')
  })

  it('dock 표식이 없으면(드래그 중) null', () => {
    expect(tabStripDockSide(fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, scrollLeft: 200 }))).toBeNull()
  })
})

describe('reveal — 실제 순서 위치 기준', () => {
  it('뒤에 숨은 탭은 오른쪽 끝에 맞도록 최소만 민다', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250 })
    revealTabStripSlot({ strip, slot: slot(strip, 3) })
    expect(strip.scrollLeft).toBe(150)
  })

  it('앞에 숨은 탭은 왼쪽 끝에 맞춘다', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, scrollLeft: 250 })
    revealTabStripSlot({ strip, slot: slot(strip, 1) })
    expect(strip.scrollLeft).toBe(100)
  })

  it('붙은 활성 탭 자신도 화면에 "보이는 것" 으로 치지 않고 제자리로 데려온다', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 0, scrollLeft: 250 })
    expect(slot(strip, 0).getBoundingClientRect().left).toBe(0) // 붙어서 보인다
    revealTabStripSlot({ strip, slot: slot(strip, 0) })
    expect(strip.scrollLeft).toBe(0)
  })

  it('붙은 활성 탭과 같이 들어가면 둘 다 보이게', () => {
    // 활성 t1(자리 100..200), 대상 t2(200..300), 폭 250 → 100..300 이 들어가게 최소 이동 = scrollLeft 100
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 1, scrollLeft: 300 })
    revealTabStripSlot({ strip, slot: slot(strip, 2) })
    expect(strip.scrollLeft).toBe(100)
    expect(tabStripDockSide(strip)).toBeNull()
  })

  it('같이 안 들어가면 활성 탭이 붙을 자리를 남긴다(덮지 않게)', () => {
    // 활성 t0, 대상 t4(400..500), 폭 250 — 둘 다는 안 들어간다. t0 가 왼쪽에 붙을 100px 를 남겨 t4 는 300..? → 끝에 맞추되 왼쪽 여유
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 0 })
    revealTabStripSlot({ strip, slot: slot(strip, 4) })
    const target = slot(strip, 4).getBoundingClientRect()
    expect(target.right).toBeLessThanOrEqual(250)
    expect(target.left).toBeGreaterThanOrEqual(100) // 붙은 t0(0..100) 와 겹치지 않는다
  })
})

describe('새로 열린 화면 밖 탭', () => {
  it('알던 id 를 빼고 화면 밖인 첫 탭', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250 })
    expect(findOffscreenOpenedSlot({ strip, knownIds: new Set(['t0', 't1', 't2']) })?.dataset.mainTab).toBe('t3')
    expect(findOffscreenOpenedSlot({ strip, knownIds: new Set(['t0', 't2', 't3', 't4']) })).toBeUndefined() // t1 은 화면 안
  })

  it('id 집합·마지막 탭', () => {
    const strip = fakeStrip({ widths: [100, 100, 100], viewWidth: 250 })
    expect([...readTabStripSlotIds(strip)]).toEqual(['t0', 't1', 't2'])
    expect(isLastTabStripSlot({ strip, tabId: 't2' })).toBe(true)
    expect(isLastTabStripSlot({ strip, tabId: 't1' })).toBe(false)
    expect(isLastTabStripSlot({ strip, tabId: null })).toBe(false)
  })
})

describe('스크롤 앵커 (#23462)', () => {
  it('보이는 활성 탭을 잡는다', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 2, scrollLeft: 100 })
    expect(captureTabStripScrollAnchor({ strip, activeTabId: 't2' })).toEqual({ tabId: 't2', offset: 100 })
  })

  it('활성 탭이 붙어 있으면 세지 않고 보이는 첫 탭을 잡는다', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, dockIndex: 0, scrollLeft: 150 })
    expect(captureTabStripScrollAnchor({ strip, activeTabId: 't0' })).toEqual({ tabId: 't1', offset: -50 })
  })

  it('앞에 탭이 끼어들어도 앵커 탭의 화면 x 를 되돌린다', () => {
    const strip = fakeStrip({ widths: [100, 100, 100, 100, 100], viewWidth: 250, scrollLeft: 100 })
    const anchor = captureTabStripScrollAnchor({ strip, activeTabId: 't2' })
    if (anchor === null) throw new Error('no anchor')
    // t2 앞에 100px 탭이 끼어든 것과 같은 효과 — 스크롤을 100 앞으로 돌려놓은 상태에서 복원하면 다시 100 뒤로
    strip.scrollLeft = 0
    expect(restoreTabStripScrollAnchor({ strip, anchor })).toBe(true)
    expect(strip.scrollLeft).toBe(100)
    expect(restoreTabStripScrollAnchor({ strip, anchor: { tabId: 'gone', offset: 0 } })).toBe(false)
  })
})
