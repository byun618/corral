// @vitest-environment happy-dom
// LIFE-589 최종 관문 수정 1 — E1ⓑ 재시작 뒤 폭: App 은 부트 화면 동안 패널을 그리지 않는다(`App.tsx` 부트스트랩 분기).
// 저장된 폭(ui-prefs)이 부트 중에 와도 패널이 마운트되는 커밋에서 그 폭이 DOM 에 적용돼야 한다.
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRightPanel } from './useRightPanel.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let setBooted: ((next: boolean) => void) | null = null
let resolvePrefs: (() => void) | null = null

function Probe(): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const panel = useRightPanel({ panelRef: ref, sidebarWidth: 0 })
  const [booted, setBootedState] = useState(false)
  setBooted = setBootedState
  if (!booted) return createElement('div', { className: 'boot' })
  return createElement('div', { 'data-right-panel': panel.open ? 'open' : 'closed' }, createElement('div', { className: 'right-panel', ref }))
}
const panelWidth = (): string | null => host.querySelector<HTMLDivElement>('.right-panel')?.style.width ?? null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const prefs = new Promise<{ rightPanelOpen: boolean; rightPanelWidth: number | null; rightPanelView: 'explorer'; rightPanelDetailWidth: number | null }>((resolve) => {
    resolvePrefs = () => resolve({ rightPanelOpen: true, rightPanelWidth: 420, rightPanelView: 'explorer', rightPanelDetailWidth: null })
  })
  Reflect.set(window, 'corral', { getUiPrefs: () => prefs, setUiPrefs: () => undefined })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useRightPanel — 부트 화면 뒤 마운트되는 패널에 저장된 폭 적용 (최종 관문 E1ⓑ)', () => {
  it('prefs 가 부트 중에 오고 패널이 나중에 마운트돼도 420px', async () => {
    act(() => root.render(createElement(Probe)))
    await act(async () => {
      resolvePrefs?.()
      await Promise.resolve()
    })
    expect(host.querySelector('.right-panel')).toBeNull()
    act(() => setBooted?.(true))
    expect(panelWidth()).toBe('420px')
  })
  it('패널이 사라졌다 다시 마운트돼도 저장된 폭', async () => {
    act(() => root.render(createElement(Probe)))
    act(() => setBooted?.(true))
    await act(async () => {
      resolvePrefs?.()
      await Promise.resolve()
    })
    expect(panelWidth()).toBe('420px')
    act(() => setBooted?.(false))
    act(() => setBooted?.(true))
    expect(panelWidth()).toBe('420px')
  })
})

// LIFE-682 A3·A10 — 보기·보기별 폭. 탐색기 폭 = 옛 `rightPanelWidth` 칸, 상세 폭 = `rightPanelDetailWidth`.
describe('useRightPanel — 보기별 폭·활성 보기 (LIFE-682 A3·A10)', () => {
  let api: ReturnType<typeof useRightPanel> | null = null
  let writes: unknown[] = []
  function ViewProbe(): React.JSX.Element {
    const ref = useRef<HTMLDivElement | null>(null)
    const panel = useRightPanel({ panelRef: ref, sidebarWidth: 280 })
    api = panel
    return createElement('div', null, createElement('div', { className: 'handle', onMouseDown: panel.onHandleMouseDown }), createElement('div', { className: 'right-panel', ref }))
  }
  async function mount(prefs: Record<string, unknown>): Promise<void> {
    writes = []
    Reflect.set(window, 'corral', { getUiPrefs: async () => ({ rightPanelOpen: true, rightPanelWidth: null, rightPanelView: 'explorer', rightPanelDetailWidth: null, ...prefs }), setUiPrefs: (patch: unknown) => { writes.push(patch) } })
    act(() => root.render(createElement(ViewProbe)))
    await act(async () => { await Promise.resolve() })
  }
  const setWindow = (width: number): void => {
    Reflect.set(window, 'innerWidth', width)
    act(() => { window.dispatchEvent(new Event('resize')) })
  }
  beforeEach(() => setWindow(1600))

  it('재시작 복원 — 활성 보기·두 폭이 따로, 보기를 바꾸면 그 보기의 폭', async () => {
    await mount({ rightPanelView: 'detail', rightPanelWidth: 330, rightPanelDetailWidth: 600 })
    expect(api?.view).toBe('detail')
    expect(panelWidth()).toBe('600px')
    act(() => api?.select('explorer'))
    expect(panelWidth()).toBe('330px')
    expect(api?.open).toBe(true)
    expect(writes).toEqual([{ rightPanelView: 'explorer' }])
  })
  it('기본 — 옛 파일(보기·상세 폭 없음): 탐색기 보기, 탐색기 폭은 옛 rightPanelWidth, 상세는 560', async () => {
    await mount({ rightPanelWidth: 412 })
    expect(api?.view).toBe('explorer')
    expect(panelWidth()).toBe('412px')
    act(() => api?.show('detail'))
    expect(panelWidth()).toBe('560px')
  })
  it('깨진·범위 밖 값은 최소~상한 clamp(220~640)', async () => {
    await mount({ rightPanelView: 'detail', rightPanelWidth: 10, rightPanelDetailWidth: 9999 })
    expect(panelWidth()).toBe('640px')
    act(() => api?.select('explorer'))
    expect(panelWidth()).toBe('220px')
  })
  it('끌기는 지금 보기의 폭만 저장한다 — 탐색기 폭을 바꿔도 상세 폭 불변', async () => {
    await mount({ rightPanelView: 'explorer', rightPanelWidth: 300, rightPanelDetailWidth: 560 })
    const handle = host.querySelector('.handle')
    act(() => { handle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1000 })) })
    act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 950 })) })
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', {})) })
    expect(writes).toEqual([{ rightPanelWidth: 350 }])
    act(() => api?.select('detail'))
    expect(panelWidth()).toBe('560px')
  })
  it('좁은 창(A10) — 렌더 폭은 창에 맞춰 깎이고 기억값은 쓰지 않는다, 넓히면 기억한 폭으로', async () => {
    await mount({ rightPanelView: 'detail', rightPanelDetailWidth: 600 })
    setWindow(1100)
    expect(panelWidth()).toBe('420px')
    setWindow(800)
    expect(panelWidth()).toBe('220px')
    setWindow(1600)
    expect(panelWidth()).toBe('600px')
    expect(writes).toEqual([])
  })
  it('끌기 상한 = 창에서 남는 폭 — 가운데 영역을 400 아래로 누르지 않는다', async () => {
    await mount({ rightPanelView: 'detail', rightPanelDetailWidth: 400 })
    setWindow(1200)
    const handle = host.querySelector('.handle')
    act(() => { handle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 })) })
    act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 })) })
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', {})) })
    expect(writes).toEqual([{ rightPanelDetailWidth: 520 }])
  })
})
