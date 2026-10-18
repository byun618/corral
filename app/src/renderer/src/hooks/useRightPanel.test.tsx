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
  const panel = useRightPanel(ref)
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
  const prefs = new Promise<{ rightPanelOpen: boolean; rightPanelWidth: number | null }>((resolve) => {
    resolvePrefs = () => resolve({ rightPanelOpen: true, rightPanelWidth: 420 })
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
