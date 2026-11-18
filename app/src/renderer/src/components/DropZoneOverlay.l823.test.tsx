// @vitest-environment happy-dom
// LIFE-823 C2·C4 — 오버레이: 폴더(blocked)는 존 강조 없이 고스트만, 고스트 글자는 받은 그대로(파일 이름·diff 제목 — B4).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('DropZoneOverlay', () => {
  it('blocked(폴더) — 존 강조 0, 고스트에 이름', () => {
    act(() => root.render(createElement(DropZoneOverlay, { state: { point: { x: 10, y: 10 }, visual: { kind: 'blocked' } }, tabLabel: 'src' })))
    expect(host.querySelector('[data-dropzone-fill], [data-dropzone-tabbar-marker]')).toBeNull()
    expect(host.querySelector('[data-tab-drag-ghost]')?.textContent).toBe('src')
  })
  it('merge — 존 강조 있음, 고스트에 파일 이름(색 점 없음)', () => {
    const bodyRect = DOMRect.fromRect({ x: 0, y: 40, width: 400, height: 400 })
    act(() => root.render(createElement(DropZoneOverlay, { state: { point: { x: 200, y: 240 }, visual: { kind: 'merge', groupId: 'g1', bodyRect, empty: false } }, tabLabel: 'a.ts' })))
    expect(host.querySelector('[data-dropzone-fill]')).not.toBeNull()
    expect(host.querySelector('[data-tab-drag-ghost]')?.textContent).toBe('a.ts')
    expect(host.querySelector('[data-tab-drag-ghost-color]')).toBeNull()
  })
})
