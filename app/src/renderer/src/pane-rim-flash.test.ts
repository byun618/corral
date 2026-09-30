// 림 플래시의 요청 세대 (LIFE-467 R8) — 연달아 누른 요청이 서로의 타이머를 지우지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flashPaneRim, PANE_RIM_FLASH_MS } from './pane-rim-flash.js'

describe('flashPaneRim', () => {
  let frames: Array<() => void> = []
  const classes = new Set<string>()
  const box = { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } }
  const runFrame = (): void => {
    const pending = frames
    frames = []
    for (const callback of pending) callback()
  }
  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
    classes.clear()
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback))
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    vi.stubGlobal('document', { querySelector: () => box })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('한 번 누르면 1.5s 동안 켜진다', () => {
    flashPaneRim('p1')
    runFrame()
    expect(classes.has('pane-rim-flash')).toBe(true)
    vi.advanceTimersByTime(PANE_RIM_FLASH_MS - 1)
    expect(classes.has('pane-rim-flash')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(classes.has('pane-rim-flash')).toBe(false)
  })

  it('같은 프레임에 두 번, 500ms 에 또 누르면 마지막 요청 기준 2000ms 까지 켜져 있다 (리뷰 재현)', () => {
    flashPaneRim('p9')
    flashPaneRim('p9')
    runFrame()
    vi.advanceTimersByTime(500)
    flashPaneRim('p9')
    runFrame()
    vi.advanceTimersByTime(1000) // t=1500 — 앞 요청의 타이머가 살아 있었다면 여기서 꺼졌다
    expect(classes.has('pane-rim-flash')).toBe(true)
    vi.advanceTimersByTime(500) // t=2000
    expect(classes.has('pane-rim-flash')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
