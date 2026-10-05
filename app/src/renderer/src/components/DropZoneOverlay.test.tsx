// @vitest-environment happy-dom
// LIFE-495 fix2 R2-05 — 드래그 고스트의 탭 색 점(K4ⓑ). 실제 `DropZoneOverlay` 를 마운트한다. App 이 넘기는 `tabColor`(탭 마크의 색)는 코드 검사.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { TabDragState } from '../hooks/useTabDrag.js'
import { DropZoneOverlay } from './DropZoneOverlay.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const state: TabDragState = { tabId: 't1', fromGroupId: 'g1', point: { x: 100, y: 40 }, target: { kind: 'self-noop' }, visual: { kind: 'self-noop' } }

it('fix2 R2-05 색이 있는 탭을 끌면 고스트에 그 색 점이 붙는다', () => {
  act(() => root.render(createElement(DropZoneOverlay, { state, tabLabel: 'build', tabColor: '#ef4444' })))
  const ghost = host.querySelector<HTMLElement>('[data-tab-drag-ghost]')
  const dot = ghost?.querySelector<HTMLElement>('[data-tab-drag-ghost-color]')
  expect(ghost?.textContent).toBe('build')
  expect(dot?.dataset.tabDragGhostColor).toBe('#ef4444')
  expect(dot?.classList.contains('main-tab-color-dot')).toBe(true)
  expect(dot?.style.backgroundColor).not.toBe('')
})

it('fix2 R2-05 색이 없는 탭(기본값 포함)은 점이 없다', () => {
  act(() => root.render(createElement(DropZoneOverlay, { state, tabLabel: 'build', tabColor: null })))
  expect(host.querySelector('[data-tab-drag-ghost-color]')).toBeNull()
  act(() => root.render(createElement(DropZoneOverlay, { state, tabLabel: 'build' })))
  expect(host.querySelector('[data-tab-drag-ghost-color]')).toBeNull()
})
