// @vitest-environment happy-dom
// hover 카드 타이머 (LIFE-477 r1 R1) — 실제 컴포넌트를 DOM 에 그리고 가짜 타이머로 열림 대기(100ms)·열린 뒤를 각각 본다.
// 대기 중 blur·scroll·resize 는 예약을 취소해야 한다(수정 전에는 열린 뒤 리스너만 있어 지나간 뒤 카드가 떴다).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverCard } from './HoverCard.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root

function mount(input: { suppressed: boolean }): void {
  act(() => {
    root.render(
      createElement(HoverCard, {
        content: createElement('div', null, 'git status'),
        suppressed: input.suppressed,
        testId: 'test',
        render: (trigger) => createElement('span', { ...trigger, id: 'trigger' }, 'branch'),
      }),
    )
  })
}
const trigger = (): HTMLElement => {
  const element = host.querySelector<HTMLElement>('#trigger')
  if (element === null) throw new Error('트리거 없음')
  return element
}
const cardOpen = (): boolean => document.querySelector('[data-hover-card]') !== null
const enter = (): void => act(() => void trigger().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
const elapse = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))
const fire = (type: 'blur' | 'resize' | 'scroll'): void => act(() => void window.dispatchEvent(new Event(type)))

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('HoverCard 타이머', () => {
  it('양성 대조 — hover 100ms 뒤 열리고 aria-describedby 가 카드를 가리킨다', () => {
    mount({ suppressed: false })
    enter()
    elapse(99)
    expect(cardOpen()).toBe(false)
    elapse(1)
    expect(cardOpen()).toBe(true)
    expect(trigger().getAttribute('aria-describedby')).toBe(document.querySelector('[data-hover-card]')?.id)
  })

  for (const type of ['blur', 'resize', 'scroll'] as const) {
    it(`열림 대기 중 ${type} → 예약 취소, 지나가도 열리지 않는다`, () => {
      mount({ suppressed: false })
      enter()
      elapse(50)
      fire(type)
      elapse(500)
      expect(cardOpen()).toBe(false)
    })

    it(`열린 뒤 ${type} → 바로 닫힌다`, () => {
      mount({ suppressed: false })
      enter()
      elapse(100)
      expect(cardOpen()).toBe(true)
      fire(type)
      expect(cardOpen()).toBe(false)
    })
  }

  it('열림 대기 중 suppressed(드래그 시작) → 열리지 않는다', () => {
    mount({ suppressed: false })
    enter()
    elapse(50)
    mount({ suppressed: true })
    elapse(500)
    expect(cardOpen()).toBe(false)
  })

  it('열림 대기 중 언마운트 → 예약이 남지 않는다', () => {
    mount({ suppressed: false })
    enter()
    act(() => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(host)
  })

  it('취소된 대기의 리스너는 남지 않는다 — 다시 hover 하면 정상으로 열린다', () => {
    mount({ suppressed: false })
    enter()
    fire('blur')
    enter()
    elapse(100)
    expect(cardOpen()).toBe(true)
  })
})
