// @vitest-environment happy-dom
// LIFE-823 C1·C2·C3 — 탐색기 쪽 진입 경로: ⌥클릭·⌃Enter·메뉴 「옆으로 열기」, 트리 밖 끌기 알림(`onFileDrag`).
// 회귀 0(00-analysis §3 진입 경로 base): 클릭 = 미리보기, Enter = 열기, 트리 안 폴더에 놓기 = 이동.
// 레이아웃이 없으니 `elementFromPoint` 를 가짜로 — 포인터 x < 0 이면 트리 밖(탭 영역 자리), 아니면 놓을 폴더 행(`dropAt`).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExplorerEntry } from '../../../shared/explorer.js'
import type { ExplorerApi, ExplorerRootState } from '../hooks/useExplorer.js'
import type { ExplorerDragEvent } from '../hooks/useFileDrag.js'
import { Explorer, openMenuEntries, rowMenuEntries, type ExplorerFileOps } from './Explorer.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let selected: string | null
const calls: { open: { rel: string; preview: boolean }[]; side: string[]; drag: ExplorerDragEvent[]; move: { from: string; toDir: string }[] } = { open: [], side: [], drag: [], move: [] }
/** 트리 안 포인터가 가리킬 폴더 행 rel. */
let dropAt = 'src'

const entry = (name: string, kind: 'dir' | 'file'): ExplorerEntry => ({ name, kind, link: 'none' })

function state(): ExplorerRootState {
  return {
    listings: new Map([
      ['', [entry('src', 'dir'), entry('lib', 'dir'), entry('a.ts', 'file')]],
      ['src', []],
      ['lib', []],
    ]),
    real: new Map(),
    ids: new Map(),
    invalid: new Set(),
    errors: new Map(),
    expanded: new Set(),
    selected,
    scrollTop: 0,
    git: null,
  }
}

function api(): ExplorerApi {
  const noop = (): void => {}
  return {
    root: '/wt',
    state: state(),
    filter: { showDotfiles: true, showIgnored: true },
    version: 0,
    toggle: noop,
    expand: noop,
    collapse: noop,
    select: (rel) => {
      selected = rel
      render()
    },
    reveal: () => false,
    setScrollTop: noop,
    collapseAll: noop,
    refresh: noop,
    setFilter: noop,
    reloadDirs: noop,
    remap: noop,
  }
}

const ops: ExplorerFileOps = {
  create: async () => null,
  rename: async () => null,
  move: async (input) => {
    calls.move.push(input)
  },
  trash: async () => {},
  duplicate: async () => {},
}

function render(): void {
  act(() =>
    root.render(
      createElement(Explorer, {
        explorer: api(),
        title: 'wt',
        focusToken: 0,
        revealRequest: null,
        onOpenFile: (input) => calls.open.push(input),
        onOpenToSide: (rel) => calls.side.push(rel),
        onFileDrag: (event) => calls.drag.push(event),
        ops,
        notify: () => {},
      }),
    ),
  )
}

const row = (rel: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-explorer-row="${rel}"]`)
  if (element === null) throw new Error(`row ${rel} 없음`)
  return element
}
const pointer = (input: { type: 'pointerdown' | 'pointermove' | 'pointerup'; target: EventTarget; x: number; y: number }): void =>
  act(() => void input.target.dispatchEvent(new PointerEvent(input.type, { bubbles: true, cancelable: true, button: 0, clientX: input.x, clientY: input.y })))
const key = (input: { key: string; ctrlKey?: boolean; metaKey?: boolean }): void =>
  act(
    () =>
      void document
        .querySelector('[data-explorer-tree]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: input.key, ctrlKey: input.ctrlKey ?? false, metaKey: input.metaKey ?? false, bubbles: true, cancelable: true })),
  )

beforeEach(() => {
  calls.open = []
  calls.side = []
  calls.drag = []
  calls.move = []
  selected = null
  dropAt = 'src'
  Reflect.set(window, 'corral', {
    onExplorerEvent: () => () => {},
    explorerFocus: () => {},
    activateWindow: () => {},
    explorerAction: async () => ({ ok: true, value: '' }),
  })
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => (x < 0 ? document.body : document.querySelector(`[data-explorer-row="${dropAt}"]`)),
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  render()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('옆으로 열기 진입(C3)', () => {
  it('⌥클릭 = 옆으로 열기, 그냥 클릭 = 미리보기(회귀 0)', () => {
    act(() => void row('a.ts').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
    expect(calls.side).toEqual(['a.ts'])
    expect(calls.open).toEqual([])
    act(() => void row('a.ts').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(calls.open).toEqual([{ rel: 'a.ts', preview: true }])
    expect(calls.side).toEqual(['a.ts'])
  })
  it('⌃Enter = 옆으로 열기(파일), 폴더는 무동작 — Enter(이름 바꾸기)·⌘↓(고정 열기)는 그대로', () => {
    selected = 'a.ts'
    render()
    key({ key: 'Enter', ctrlKey: true })
    expect(calls.side).toEqual(['a.ts'])
    selected = 'src'
    render()
    key({ key: 'Enter', ctrlKey: true })
    expect(calls.side).toEqual(['a.ts'])
    selected = 'a.ts'
    render()
    key({ key: 'Enter' })
    expect(row('a.ts').classList.contains('is-editing')).toBe(true)
    expect(calls.open).toEqual([])
    act(() => void document.querySelector('[data-explorer-tree]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    key({ key: 'ArrowDown', metaKey: true })
    expect(calls.open).toEqual([{ rel: 'a.ts', preview: false }])
    expect(calls.side).toEqual(['a.ts'])
  })
  it('메뉴 — 파일만 맨 위 「옆으로 열기」, 폴더는 없음, 기존 메뉴 목록 그대로', () => {
    expect(openMenuEntries({ kind: 'file' })).toEqual([{ kind: 'item', action: 'openToSide', label: '옆으로 열기' }, { kind: 'sep', key: 'open' }])
    expect(openMenuEntries({ kind: 'dir' })).toEqual([])
    expect(rowMenuEntries({ kind: 'file', expanded: false })[0]).toMatchObject({ action: 'newFile' })
  })
  it('메뉴 항목을 누르면 옆으로 연다', () => {
    act(() => void row('a.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find((element) => element.textContent?.includes('옆으로 열기'))
    expect(item).toBeDefined()
    act(() => item?.click())
    expect(calls.side).toEqual(['a.ts'])
  })
})

describe('트리 밖 끌기(C1·C2)', () => {
  it('파일을 트리 밖으로 끌면 move, 놓으면 drop — 트리 이동은 없다', () => {
    pointer({ type: 'pointerdown', target: row('a.ts'), x: 10, y: 10 })
    pointer({ type: 'pointermove', target: document, x: -40, y: 10 })
    pointer({ type: 'pointermove', target: document, x: -80, y: 30 })
    expect(calls.drag.at(-1)).toEqual({ kind: 'move', rel: 'a.ts', isDir: false, point: { x: -80, y: 30 } })
    pointer({ type: 'pointerup', target: document, x: -90, y: 40 })
    expect(calls.drag.at(-1)).toEqual({ kind: 'drop', rel: 'a.ts', isDir: false, point: { x: -90, y: 40 } })
    expect(calls.move).toEqual([])
  })
  it('폴더도 알린다(isDir) — 무효 판정은 받는 쪽', () => {
    pointer({ type: 'pointerdown', target: row('lib'), x: 10, y: 10 })
    pointer({ type: 'pointermove', target: document, x: -40, y: 10 })
    expect(calls.drag.at(-1)).toMatchObject({ kind: 'move', rel: 'lib', isDir: true })
  })
  it('ⓕ Esc — end, 놓기·이동 없음', () => {
    pointer({ type: 'pointerdown', target: row('a.ts'), x: 10, y: 10 })
    pointer({ type: 'pointermove', target: document, x: -40, y: 10 })
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(calls.drag.at(-1)).toEqual({ kind: 'end' })
    pointer({ type: 'pointerup', target: document, x: -40, y: 10 })
    expect(calls.drag.filter((event) => event.kind === 'drop')).toEqual([])
    expect(calls.move).toEqual([])
  })
  it('ⓕ 창 blur — end', () => {
    pointer({ type: 'pointerdown', target: row('a.ts'), x: 10, y: 10 })
    pointer({ type: 'pointermove', target: document, x: -40, y: 10 })
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(calls.drag.at(-1)).toEqual({ kind: 'end' })
  })
  it('ⓖ 트리 밖에 나갔다가 트리 안 폴더에 놓으면 end + 기존 이동 그대로', () => {
    pointer({ type: 'pointerdown', target: row('a.ts'), x: 10, y: 10 })
    pointer({ type: 'pointermove', target: document, x: -40, y: 10 })
    pointer({ type: 'pointermove', target: document, x: 10, y: 20 })
    expect(calls.drag.at(-1)).toEqual({ kind: 'end' })
    pointer({ type: 'pointerup', target: document, x: 10, y: 20 })
    expect(calls.drag.filter((event) => event.kind === 'drop')).toEqual([])
    expect(calls.move).toEqual([{ from: 'a.ts', toDir: 'src' }])
  })
})
