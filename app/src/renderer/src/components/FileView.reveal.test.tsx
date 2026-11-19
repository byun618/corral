// @vitest-environment happy-dom
// LIFE-803 C5ⓐⓑⓒⓔ — 검색 결과의 줄 열기가 편집기에 언제 적용되나. Monaco 는 가짜 편집기(호출 기록)로 대신한다.
// · 첫 마운트: 저장된 보기 상태 복원 **다음**에 커서·보이기·포커스(복원이 위치를 덮지 않는다).
// · 이미 붙은 편집기: `revealInLiveEditor` 가 바로. · 요청이 다른 탭 것이면 적용 0.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView, revealInLiveEditor, type ViewStateStore } from './FileView.js'
import { revealSlot } from '../file-reveal.js'
import { disposeDoc, docKey } from '../file-docs.js'

const log: string[] = []
vi.mock('../editor/monaco.js', () => {
  const fakeModel = (text: string) => ({
    getValue: () => text,
    getLinesContent: () => text.split('\n'),
    getValueLength: () => text.length,
    getAlternativeVersionId: () => 1,
    onDidChangeContent: () => ({ dispose: () => undefined }),
    getEOL: () => '\n',
    getLanguageId: () => 'plaintext',
    isDisposed: () => false,
    dispose: () => undefined,
  })
  return {
    languageFor: async () => 'plaintext',
    liveModel: (model: unknown) => model,
    setModelLanguage: () => undefined,
    createModel: (input: { text: string }) => fakeModel(input.text),
    createEditor: () => ({
      setModel: () => log.push('setModel'),
      restoreViewState: () => log.push('restoreViewState'),
      saveViewState: () => ({ saved: true }),
      onDidCompositionStart: () => ({ dispose: () => undefined }),
      onDidCompositionEnd: () => ({ dispose: () => undefined }),
      updateOptions: () => undefined,
      dispose: () => log.push('dispose'),
      focus: () => log.push('focus'),
      setPosition: (position: { lineNumber: number; column: number }) => log.push(`setPosition ${position.lineNumber}:${position.column}`),
      revealPositionInCenterIfOutsideViewport: (position: { lineNumber: number; column: number }) => log.push(`reveal ${position.lineNumber}:${position.column}`),
    }),
  }
})

vi.mock('../editor/markdown.js', () => ({ renderMarkdown: () => '<p>미리보기</p>', slugOf: () => '', resolveMarkdownTarget: () => null }))

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const TEXT = 'line1\nhello 한글 Foo foo\n'

beforeEach(() => {
  log.length = 0
  Reflect.set(window, 'corral', {
    readFile: async () => ({ ok: true, kind: 'text', text: TEXT, bom: false, utf8: true, nlink: 1, size: TEXT.length, bytesRead: TEXT.length, stamp: 's1', hash: 'h1' }),
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  disposeDoc(docKey('/w', 'a.ts'))
  disposeDoc(docKey('/w', 'a.md'))
  revealSlot.activated({ store: null, tabId: null })
})

const mount = async (viewStates: ViewStateStore, rel = 'a.ts', markdownModes: Map<string, 'source' | 'preview'> = new Map()): Promise<void> => {
  await act(async () => {
    root.render(<FileView root="/w" rel={rel} tabId={`file:${rel}`} groupId="g1" viewStates={viewStates} markdownModes={markdownModes} watched={null} onActivate={() => {}} onOpenFile={() => {}} />)
    await pause(30)
  })
}

describe('첫 마운트 (C5ⓐⓒ)', () => {
  it('저장된 보기 상태가 있어도 복원 다음에 위치를 적용한다(한글 뒤 UTF-16 열 그대로)', async () => {
    const viewStates: ViewStateStore = new Map()
    viewStates.set('file:a.ts', { cursorState: [], viewState: { scrollLeft: 0, firstPosition: { lineNumber: 40, column: 1 }, firstPositionDeltaTop: 0 }, contributionsState: {} })
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 10 }, mayFocus: () => true })
    await mount(viewStates)
    expect(log).toEqual(['setModel', 'restoreViewState', 'setPosition 2:10', 'reveal 2:10', 'focus'])
    expect(revealSlot.current).toBeNull()
  })
  it('보기 상태가 없어도 적용', async () => {
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 10 }, mayFocus: () => true })
    await mount(viewStates)
    expect(log).toEqual(['setModel', 'setPosition 2:10', 'reveal 2:10', 'focus'])
  })
  it('마지막 요청이 다른 탭 것이면 적용 0(C5ⓔ)', async () => {
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 10 }, mayFocus: () => true })
    revealSlot.request({ store: viewStates, tabId: 'file:b.ts', target: { line: 1, column: 1 }, mayFocus: () => true })
    await mount(viewStates)
    expect(log).toEqual(['setModel'])
    expect(revealSlot.current?.tabId).toBe('file:b.ts')
  })
  it('요청이 없으면 기존 열기 그대로(위치 적용 0 — C5ⓖ)', async () => {
    await mount(new Map())
    expect(log).toEqual(['setModel'])
  })
})

describe('이미 붙은 편집기 (C5ⓑ)', () => {
  it('다른 위치를 보던 탭 — revealInLiveEditor 가 바로 적용하고 요청을 지운다', async () => {
    const viewStates: ViewStateStore = new Map()
    await mount(viewStates)
    log.length = 0
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 7 }, mayFocus: () => true })
    expect(revealInLiveEditor({ store: viewStates, tabId: 'file:a.ts' })).toBe(true)
    expect(log).toEqual(['setPosition 2:7', 'reveal 2:7', 'focus'])
    expect(revealSlot.current).toBeNull()
  })
  it('붙은 편집기가 없는 탭이면 거짓(첫 마운트가 맡는다)', () => {
    expect(revealInLiveEditor({ store: new Map(), tabId: 'file:zz.ts' })).toBe(false)
  })
})

describe('r1 보강 — 포커스는 요청이 허락할 때만', () => {
  it('첫 마운트 — mayFocus 거짓이면 커서·보이기만(요청 뒤 포커스가 옮겨 감)', async () => {
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 10 }, mayFocus: () => false })
    await mount(viewStates)
    expect(log).toEqual(['setModel', 'setPosition 2:10', 'reveal 2:10'])
  })
})

describe('r1 보강 C5ⓗ — 편집기를 붙이지 않는 탭은 요청을 남기지 않는다', () => {
  it('마크다운 미리보기 모드 — 요청을 버리고 편집기 적용 0', async () => {
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:a.md', target: { line: 2, column: 1 }, mayFocus: () => true })
    await mount(viewStates, 'a.md', new Map([['file:a.md', 'preview']]))
    expect(revealSlot.current).toBeNull()
    expect(log).toEqual([])
  })
  it('읽기 실패 — 요청을 버린다', async () => {
    Reflect.set(window, 'corral', { readFile: async () => ({ ok: false, code: 'not_found', error: '없음' }) })
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 1 }, mayFocus: () => true })
    await mount(viewStates)
    expect(revealSlot.current).toBeNull()
    expect(host.querySelector('[data-file-notice="not_found"]')).not.toBeNull()
  })
  it('r3 R3-03 — 이미 읽기 실패로 열린 탭의 결과를 다시 눌러도 요청이 남지 않는다', async () => {
    Reflect.set(window, 'corral', { readFile: async () => ({ ok: false, code: 'not_found', error: '없음' }) })
    const viewStates: ViewStateStore = new Map()
    await mount(viewStates)
    expect(host.querySelector('[data-file-notice="not_found"]')).not.toBeNull()
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 1 }, mayFocus: () => true })
    expect(revealSlot.current).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 1 }, mayFocus: () => true })
    expect(revealSlot.current?.tabId).toBe('file:a.ts')
  })
  it('다른 탭의 요청은 건드리지 않는다', async () => {
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:b.ts', target: { line: 2, column: 1 }, mayFocus: () => true })
    await mount(viewStates, 'a.md', new Map([['file:a.md', 'preview']]))
    expect(revealSlot.current?.tabId).toBe('file:b.ts')
  })
})
