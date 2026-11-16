// @vitest-environment happy-dom
// LIFE-823 C1·C2·C4(B5) — 탐색기 파일 끌기 판정(`useFileDrag`)과 공유 판정(`resolveDropTarget`)의 본문 셀렉터.
// happy-dom 에는 레이아웃이 없어 사각형·`elementsFromPoint` 를 가짜로 씌운다: 영역 g1 — 헤더 y 0~32(탭 100px 둘), 본문 y 40~440 · x 0~400.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DropTarget } from '../tab-drag.js'
import { useFileDrag, type ExplorerDragEvent, type FileDragState } from './useFileDrag.js'
import { DROP_BODY_SELECTOR, resolveDropTarget, type DragSource } from './useTabDrag.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let group: HTMLDivElement | undefined
const probe: { state: FileDragState | null; onExplorerDrag: ((event: ExplorerDragEvent) => void) | null } = { state: null, onExplorerDrag: null }
const drops: { rel: string; target: DropTarget }[] = []

const rect = (input: { left: number; top: number; width: number; height: number }): DOMRect => DOMRect.fromRect({ x: input.left, y: input.top, width: input.width, height: input.height })

/** 본문 종류 — 터미널·빈 영역·파일·diff(B5). */
function buildGroup(bodyAttr: 'data-term-group' | 'data-empty-group' | 'data-file-group' | 'data-diff-group'): void {
  const container = document.createElement('div')
  group = container
  container.setAttribute('data-tab-group', 'g1')
  const header = document.createElement('div')
  header.setAttribute('data-group-header', '')
  header.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 400, height: 32 })
  for (let index = 0; index < 2; index++) {
    const tab = document.createElement('div')
    tab.dataset.mainTab = `t${index}`
    tab.getBoundingClientRect = () => rect({ left: index * 100, top: 0, width: 100, height: 32 })
    header.append(tab)
  }
  const body = document.createElement('div')
  body.setAttribute(bodyAttr, 'g1')
  body.getBoundingClientRect = () => rect({ left: 0, top: 40, width: 400, height: 400 })
  container.append(header, body)
  document.body.append(container)
}

function Probe(): null {
  const api = useFileDrag({ onDrop: (drop) => drops.push(drop) })
  probe.state = api.dragState
  probe.onExplorerDrag = api.onExplorerDrag
  return null
}

const send = (event: ExplorerDragEvent): void => act(() => probe.onExplorerDrag?.(event))
const move = (input: { rel?: string; isDir?: boolean; x: number; y: number }): void =>
  send({ kind: 'move', rel: input.rel ?? 'src/a.ts', isDir: input.isDir ?? false, point: { x: input.x, y: input.y } })

beforeEach(() => {
  drops.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // 영역 사각형(0~400 × 0~440) 안이면 그 영역 요소, 밖이면 없음.
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: (x: number, y: number) => (x >= 0 && x <= 400 && y >= 0 && y <= 440 && group !== undefined ? [group] : []) })
  act(() => root.render(createElement(Probe)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  group?.remove()
  group = undefined
  document.body.className = ''
})

describe('탐색기 파일 끌기 판정(C1)', () => {
  it('탭바 — 삽입 index, 오버레이 tabbar, 몸에 is-tab-drag', () => {
    buildGroup('data-term-group')
    move({ x: 120, y: 10 })
    expect(probe.state?.target).toEqual({ kind: 'tabbar', groupId: 'g1', index: 1 })
    expect(probe.state?.visual.kind).toBe('tabbar')
    expect(document.body.classList.contains('is-tab-drag')).toBe(true)
  })
  it('본문 가장자리 4방향 = 분할, 가운데 = 열기(merge)', () => {
    buildGroup('data-file-group')
    move({ x: 10, y: 240 })
    expect(probe.state?.target).toEqual({ kind: 'split', groupId: 'g1', direction: 'row', edge: 'before' })
    move({ x: 390, y: 240 })
    expect(probe.state?.target).toEqual({ kind: 'split', groupId: 'g1', direction: 'row', edge: 'after' })
    move({ x: 200, y: 50 })
    expect(probe.state?.target).toEqual({ kind: 'split', groupId: 'g1', direction: 'column', edge: 'before' })
    move({ x: 200, y: 430 })
    expect(probe.state?.target).toEqual({ kind: 'split', groupId: 'g1', direction: 'column', edge: 'after' })
    expect(probe.state?.visual).toMatchObject({ kind: 'split', zone: 'down' })
    move({ x: 200, y: 240 })
    expect(probe.state?.target).toEqual({ kind: 'merge', groupId: 'g1' })
  })
  it('빈 영역도 가장자리는 분할(탭 끌기와 다르다), 가운데는 열기', () => {
    buildGroup('data-empty-group')
    move({ x: 390, y: 240 })
    expect(probe.state?.target).toEqual({ kind: 'split', groupId: 'g1', direction: 'row', edge: 'after' })
    move({ x: 200, y: 240 })
    expect(probe.state?.visual).toMatchObject({ kind: 'merge', empty: true })
  })
  it('diff 본문(B5)도 같은 판정', () => {
    buildGroup('data-diff-group')
    move({ x: 10, y: 240 })
    expect(probe.state?.target).toEqual({ kind: 'split', groupId: 'g1', direction: 'row', edge: 'before' })
  })
  it('영역 밖이면 invalid', () => {
    buildGroup('data-term-group')
    move({ x: 900, y: 240 })
    expect(probe.state?.target).toEqual({ kind: 'invalid' })
  })
  it('놓으면 그 판정으로 1회 커밋하고 상태·몸 표지를 걷는다', () => {
    buildGroup('data-term-group')
    move({ x: 200, y: 240 })
    send({ kind: 'drop', rel: 'src/a.ts', isDir: false, point: { x: 390, y: 240 } })
    expect(drops).toEqual([{ rel: 'src/a.ts', target: { kind: 'split', groupId: 'g1', direction: 'row', edge: 'after' } }])
    expect(probe.state).toBeNull()
    expect(document.body.classList.contains('is-tab-drag')).toBe(false)
  })
  it('ⓕ 끝(Esc·blur·트리 안으로) — 커밋 0, 상태 걷힘', () => {
    buildGroup('data-term-group')
    move({ x: 200, y: 240 })
    send({ kind: 'end' })
    expect(drops).toEqual([])
    expect(probe.state).toBeNull()
    expect(document.body.classList.contains('is-tab-drag')).toBe(false)
  })
})

describe('폴더(C2) — 무효 표시', () => {
  it('탭 영역 위에서도 존 강조 없음(blocked) · not-allowed 표지 · 놓아도 커밋 0', () => {
    buildGroup('data-term-group')
    move({ rel: 'src', isDir: true, x: 200, y: 240 })
    expect(probe.state).toMatchObject({ rel: 'src', isDir: true, target: { kind: 'invalid' }, visual: { kind: 'blocked' } })
    expect(document.body.classList.contains('is-file-drag-blocked')).toBe(true)
    send({ kind: 'drop', rel: 'src', isDir: true, point: { x: 200, y: 240 } })
    expect(drops).toEqual([])
    expect(document.body.classList.contains('is-file-drag-blocked')).toBe(false)
  })
  it('파일로 바뀌면 blocked 표지가 내려간다', () => {
    buildGroup('data-term-group')
    move({ rel: 'src', isDir: true, x: 200, y: 240 })
    move({ x: 200, y: 240 })
    expect(document.body.classList.contains('is-file-drag-blocked')).toBe(false)
  })
})

describe('탭 끌기 공유 판정 — diff 본문(B5)', () => {
  it('본문 셀렉터에 diff 가 들어 있다', () => {
    expect(DROP_BODY_SELECTOR).toContain('[data-diff-group]')
  })
  it('다른 영역 탭을 diff 본문 가장자리에 놓으면 분할, 가운데는 병합', () => {
    buildGroup('data-diff-group')
    const source: DragSource = { kind: 'tab', fromGroupId: 'g2', ownTabCountOf: () => 2 }
    expect(resolveDropTarget({ point: { x: 10, y: 240 }, source }).target).toEqual({ kind: 'split', groupId: 'g1', direction: 'row', edge: 'before' })
    expect(resolveDropTarget({ point: { x: 200, y: 240 }, source }).target).toEqual({ kind: 'merge', groupId: 'g1' })
  })
  it('제 영역 diff 본문 — 탭 1개 가장자리 invalid, 가운데 self-noop(파일 본문과 같은 규칙)', () => {
    buildGroup('data-diff-group')
    const source: DragSource = { kind: 'tab', fromGroupId: 'g1', ownTabCountOf: () => 1 }
    expect(resolveDropTarget({ point: { x: 10, y: 240 }, source }).target).toEqual({ kind: 'invalid' })
    expect(resolveDropTarget({ point: { x: 200, y: 240 }, source }).target).toEqual({ kind: 'self-noop' })
  })
})
