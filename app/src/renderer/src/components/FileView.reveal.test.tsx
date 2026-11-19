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
  revealSlot.activated({ store: null, tabId: null })
})

const mount = async (viewStates: ViewStateStore): Promise<void> => {
  await act(async () => {
    root.render(<FileView root="/w" rel="a.ts" tabId="file:a.ts" groupId="g1" viewStates={viewStates} markdownModes={new Map()} watched={null} onActivate={() => {}} onOpenFile={() => {}} />)
    await pause(30)
  })
}

describe('첫 마운트 (C5ⓐⓒ)', () => {
  it('저장된 보기 상태가 있어도 복원 다음에 위치를 적용한다(한글 뒤 UTF-16 열 그대로)', async () => {
    const viewStates: ViewStateStore = new Map()
    viewStates.set('file:a.ts', { cursorState: [], viewState: { scrollLeft: 0, firstPosition: { lineNumber: 40, column: 1 }, firstPositionDeltaTop: 0 }, contributionsState: {} })
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 10 } })
    await mount(viewStates)
    expect(log).toEqual(['setModel', 'restoreViewState', 'setPosition 2:10', 'reveal 2:10', 'focus'])
    expect(revealSlot.current).toBeNull()
  })
  it('보기 상태가 없어도 적용', async () => {
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 10 } })
    await mount(viewStates)
    expect(log).toEqual(['setModel', 'setPosition 2:10', 'reveal 2:10', 'focus'])
  })
  it('마지막 요청이 다른 탭 것이면 적용 0(C5ⓔ)', async () => {
    const viewStates: ViewStateStore = new Map()
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 10 } })
    revealSlot.request({ store: viewStates, tabId: 'file:b.ts', target: { line: 1, column: 1 } })
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
    revealSlot.request({ store: viewStates, tabId: 'file:a.ts', target: { line: 2, column: 7 } })
    expect(revealInLiveEditor({ store: viewStates, tabId: 'file:a.ts' })).toBe(true)
    expect(log).toEqual(['setPosition 2:7', 'reveal 2:7', 'focus'])
    expect(revealSlot.current).toBeNull()
  })
  it('붙은 편집기가 없는 탭이면 거짓(첫 마운트가 맡는다)', () => {
    expect(revealInLiveEditor({ store: new Map(), tabId: 'file:zz.ts' })).toBe(false)
  })
})
