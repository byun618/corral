// @vitest-environment happy-dom
// LIFE-494 r1 R1-01·R1-02 — 탭바 드롭 인덱스가 dock·스크롤과 어긋나지 않는가. happy-dom 에는 레이아웃이 없어 가짜 레이아웃을 씌운다:
// 탭 100px 가 왼쪽부터 늘어서고(스트립 x = 0, 폭 250), `[data-active-tab-dock]` 탭은 sticky 처럼 뷰포트 안으로 잘려 그려진다 —
// 단 `body.is-tab-drag` 가 서 있으면 제자리(styles.css 의 `body.is-tab-drag .main-tab[data-active-tab-dock] { position: relative }` —
// 그 규칙이 실제로 있는지는 `useTabDrag.css.test.mjs`).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DropTarget } from '../tab-drag.js'
import { useTabDrag, type TabDragApi } from './useTabDrag.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const TAB_W = 100
const VIEW_W = 250
const rect = (left: number, width: number): DOMRect => DOMRect.fromRect({ x: left, y: 0, width, height: 32 })

let host: HTMLDivElement
let root: Root
let strip: HTMLDivElement
const probe: { api: TabDragApi | null } = { api: null }
const drops: DropTarget[] = []

function buildTabbar(input: { count: number; dockIndex?: number; scrollLeft: number }): void {
  const group = document.createElement('div')
  group.setAttribute('data-tab-group', 'g1')
  const header = document.createElement('div')
  header.setAttribute('data-group-header', '')
  header.getBoundingClientRect = () => rect(0, VIEW_W)
  strip = document.createElement('div')
  let scrollLeft = input.scrollLeft
  Object.defineProperty(strip, 'scrollLeft', { get: () => scrollLeft, set: (value: number) => { scrollLeft = value } })
  for (let index = 0; index < input.count; index++) {
    const tab = document.createElement('div')
    tab.dataset.mainTab = `t${index}`
    if (index === input.dockIndex) tab.setAttribute('data-active-tab-dock', '')
    tab.getBoundingClientRect = () => {
      const left = index * TAB_W - scrollLeft
      const sticky = tab.hasAttribute('data-active-tab-dock') && !document.body.classList.contains('is-tab-drag')
      return rect(sticky ? Math.min(Math.max(left, 0), VIEW_W - TAB_W) : left, TAB_W)
    }
    strip.append(tab)
  }
  header.append(strip)
  group.append(header)
  host.append(group)
  // 탭바 줄(y 16) 어디를 짚어도 이 그룹 헤더 위다.
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [header] })
}

function Probe(): ReturnType<typeof createElement> {
  const api = useTabDrag({ ownTabCountOf: () => 5, onDrop: ({ target }) => drops.push(target) })
  probe.api = api
  return createElement('button', { 'data-probe': '', onMouseDown: (event: React.MouseEvent) => api.onArm(event, { tabId: 't0', fromGroupId: 'g1' }) })
}

const mouse = (input: { type: 'mousedown' | 'mousemove' | 'mouseup'; x: number; target?: EventTarget }): void => {
  act(() => {
    ;(input.target ?? document).dispatchEvent(new MouseEvent(input.type, { bubbles: true, button: 0, clientX: input.x, clientY: 16 }))
  })
}
const press = (x: number): void => {
  const button = host.querySelector('[data-probe]')
  if (button === null) throw new Error('no probe')
  mouse({ type: 'mousedown', x, target: button })
}
const tabbarIndex = (target: DropTarget | undefined): number | null => (target?.kind === 'tabbar' ? target.index : null)

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  drops.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.classList.remove('is-tab-drag')
  vi.restoreAllMocks()
})

describe('dock 과 드롭 판정 (R1-01)', () => {
  it('문턱을 넘는 첫 mousemove 부터 dock 풀린 제자리 사각형으로 판정한다', () => {
    // 앞으로 250 스크롤 — 활성 t0(제자리 -250..-150)는 앞 가장자리 0..100 에 붙어 있다.
    // dock 켠 채라면 중점 [50, -100, 0, 100, 200] → x 45 는 0번, 끈 제자리 [-200, -100, 0, 100, 200] → 3번.
    buildTabbar({ count: 5, dockIndex: 0, scrollLeft: 250 })
    press(52)
    mouse({ type: 'mousemove', x: 45 })
    expect(document.body.classList.contains('is-tab-drag')).toBe(true)
    expect(tabbarIndex(probe.api?.dragState?.target)).toBe(3)
    mouse({ type: 'mouseup', x: 45 })
    expect(drops).toHaveLength(1)
    expect(tabbarIndex(drops[0])).toBe(3)
    expect(document.body.classList.contains('is-tab-drag')).toBe(false)
  })
})

describe('드래그 중 스트립 스크롤 (R1-02)', () => {
  it('포인터가 멈춘 채 스트립이 스크롤되면 마지막 포인터로 다시 판정해 놓을 때 스크롤 뒤 인덱스로 커밋한다', () => {
    buildTabbar({ count: 5, scrollLeft: 0 })
    press(60)
    mouse({ type: 'mousemove', x: 160 })
    // 중점 [50, 150, 250, 350, 450] → x 160 은 2번.
    expect(tabbarIndex(probe.api?.dragState?.target)).toBe(2)
    // chevron 자동 스크롤처럼 mousemove 없이 200 스크롤 → 중점 [-150, -50, 50, 150, 250] → 4번.
    act(() => {
      strip.scrollLeft = 200
      strip.dispatchEvent(new Event('scroll'))
    })
    expect(tabbarIndex(probe.api?.dragState?.target)).toBe(4)
    mouse({ type: 'mouseup', x: 160 })
    expect(tabbarIndex(drops[0])).toBe(4)
  })

  it('문턱 전(클릭 취급)이나 드래그가 끝난 뒤의 스크롤은 판정하지 않는다', () => {
    buildTabbar({ count: 5, scrollLeft: 0 })
    press(60)
    act(() => {
      strip.scrollLeft = 200
      strip.dispatchEvent(new Event('scroll'))
    })
    expect(probe.api?.dragState).toBeNull()
    mouse({ type: 'mouseup', x: 60 })
    act(() => strip.dispatchEvent(new Event('scroll')))
    expect(probe.api?.dragState).toBeNull()
    expect(drops).toHaveLength(0)
  })
})
