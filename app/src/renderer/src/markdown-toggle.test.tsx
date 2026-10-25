// @vitest-environment happy-dom
// LIFE-692 수정 f1 F2 — ⇧⌘V 처리기(`runMarkdownToggle`)의 대상: 포커스가 있는 Markdown 보기의 탭 → 그 영역 활성, 다른 영역 탭 모드 불변(K3 ⓕ).
// 포커스가 보기 밖(팔레트 경로)이면 활성 탭. 실제 FileView 두 개(영역 둘)를 그리고 실제 전환기 등록을 거친다 — Monaco 는 싣지 않는다(가짜).
// App 처리기 본문은 `createMarkdownToggleHandler` 다(수정 f2 N-2) — 아래 마지막 단락이 그 함수를 실제로 불러 행동으로 잠근다(App 은 의존성만 넘기는 한 줄 위임).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView, type MarkdownModeStore, type ViewStateStore } from './components/FileView.js'
import { createMarkdownToggleHandler, focusedMarkdownView, markdownToggleTarget, runMarkdownToggle } from './markdown-toggle.js'

vi.mock('./editor/monaco.js', () => ({ languageFor: () => new Promise(() => {}) }))
vi.mock('./editor/markdown.js', () => ({ renderMarkdown: () => '<p>미리보기</p>', slugOf: () => '', resolveMarkdownTarget: () => null }))

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let markdownModes: MarkdownModeStore
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  Reflect.set(window, 'corral', {
    readFile: async () => ({ ok: true, kind: 'text', text: '# 제목\n', bom: false, utf8: true, nlink: 1, size: 7, bytesRead: 7, stamp: 's1', hash: 'h1' }),
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // 영역 g1 = A.md(활성 영역) · g2 = B.md · g3 = main.ts. 셋 다 미리보기에서 시작(Monaco 없이 그린다).
  markdownModes = new Map([['file:A.md', 'preview'], ['file:B.md', 'preview']])
  const viewStates: ViewStateStore = new Map()
  await act(async () => {
    root.render(
      <>
        {[{ rel: 'A.md', groupId: 'g1' }, { rel: 'B.md', groupId: 'g2' }, { rel: 'main.ts', groupId: 'g3' }].map((view) => (
          <FileView key={view.groupId} root="/w" rel={view.rel} tabId={`file:${view.rel}`} groupId={view.groupId} viewStates={viewStates} markdownModes={markdownModes} watched={null} onActivate={() => {}} onOpenFile={() => {}} />
        ))}
      </>,
    )
    await pause(20)
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const group = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-file-group="${id}"]`)!
const run = (focused: Element | null, active: { activeGroupId: string | null; activeTabId: string | null }) => {
  const activated: string[] = []
  const focusedFiles: string[] = []
  let result = false
  act(() => {
    result = runMarkdownToggle({ focused, ...active, store: markdownModes, activateGroup: (groupId) => activated.push(groupId), focusFile: (rel) => focusedFiles.push(rel) })
  })
  return { result, activated, focusedFiles }
}

describe('⇧⌘V 대상 = 포커스가 있는 Markdown 보기 (f1 F1 · K3 ⓕ)', () => {
  it('비활성 영역 g2 의 툴바 버튼에 포커스 → B.md 만 바뀌고 g2 가 활성, A.md 불변', () => {
    const button = group('g2').querySelector('[data-markdown-toggle]')!
    const out = run(button, { activeGroupId: 'g1', activeTabId: 'file:A.md' })
    expect(out).toEqual({ result: true, activated: ['g2'], focusedFiles: ['B.md'] })
    expect(markdownModes.get('file:B.md')).toBe('source')
    expect(markdownModes.get('file:A.md')).toBe('preview')
    expect(group('g2').getAttribute('data-markdown-view')).toBe('source')
    expect(group('g1').getAttribute('data-markdown-view')).toBe('preview')
  })
  it('활성 영역 보기 자체에 포커스 → 그 탭만, 영역 활성화 호출 없음', () => {
    const out = run(group('g1'), { activeGroupId: 'g1', activeTabId: 'file:A.md' })
    expect(out).toEqual({ result: true, activated: [], focusedFiles: ['A.md'] })
    expect(markdownModes.get('file:A.md')).toBe('source')
    expect(markdownModes.get('file:B.md')).toBe('preview')
  })
  it('팔레트 경로(포커스가 보기 밖) → 활성 영역의 활성 탭', () => {
    const out = run(document.body, { activeGroupId: 'g2', activeTabId: 'file:B.md' })
    expect(out).toEqual({ result: true, activated: [], focusedFiles: ['B.md'] })
    expect(markdownModes.get('file:B.md')).toBe('source')
  })
  it('대상 없음 — 활성 탭이 Markdown 아님 · 터미널 탭 · 활성 없음 → 거짓, 아무 호출·변화 없음', () => {
    for (const active of [{ activeGroupId: 'g3', activeTabId: 'file:main.ts' }, { activeGroupId: 'g1', activeTabId: 'term-1' }, { activeGroupId: null, activeTabId: null }]) {
      expect(run(document.body, active)).toEqual({ result: false, activated: [], focusedFiles: [] })
    }
    // .ts 보기 안 포커스도 Markdown 보기가 아니다
    expect(run(group('g3'), { activeGroupId: 'g3', activeTabId: 'file:main.ts' })).toEqual({ result: false, activated: [], focusedFiles: [] })
    expect([...markdownModes]).toEqual([['file:A.md', 'preview'], ['file:B.md', 'preview']])
  })
  it('순수 판정 — focusedMarkdownView · markdownToggleTarget', () => {
    expect(focusedMarkdownView(group('g2').querySelector('[data-markdown-toggle]'))).toEqual({ groupId: 'g2', rel: 'B.md' })
    expect(focusedMarkdownView(group('g3'))).toBeNull()
    expect(focusedMarkdownView(null)).toBeNull()
    expect(markdownToggleTarget({ focused: { groupId: 'g2', rel: 'B.md' }, activeGroupId: 'g1', activeTabId: 'file:A.md' })).toEqual({ groupId: 'g2', tabId: 'file:B.md', rel: 'B.md' })
    expect(markdownToggleTarget({ focused: null, activeGroupId: 'g1', activeTabId: 'file:A.md' })).toEqual({ groupId: 'g1', tabId: 'file:A.md', rel: 'A.md' })
  })
})

describe('App 처리기 createMarkdownToggleHandler (f2 N-2 — 처리기 무동작 변이 M3·M3b·void 0 을 잡는다)', () => {
  const handler = (input: { root: string | null; activeGroupId: string | null; activeTabId: string | null; focused: Element | null }) => {
    const calls: { activated: string[]; opened: { worktreePath: string; rel: string }[]; stores: string[] } = { activated: [], opened: [], stores: [] }
    const run = createMarkdownToggleHandler({
      root: () => input.root,
      layout: () => ({ activeGroupId: input.activeGroupId, activeTabId: input.activeTabId }),
      focused: () => input.focused,
      markdownModesOf: (worktree) => {
        calls.stores.push(worktree)
        return markdownModes
      },
      activateGroup: (groupId) => calls.activated.push(groupId),
      focusOpenedFile: (target) => calls.opened.push(target),
    })
    return { run, calls }
  }
  it('비활성 영역 g2 보기 포커스 → B.md 전환 · g2 활성 · 그 worktree 의 B.md 로 포커스 이동, A.md 불변', () => {
    const { run, calls } = handler({ root: '/w', activeGroupId: 'g1', activeTabId: 'file:A.md', focused: group('g2').querySelector('[data-markdown-toggle]') })
    act(() => run())
    expect(markdownModes.get('file:B.md')).toBe('source')
    expect(markdownModes.get('file:A.md')).toBe('preview')
    expect(calls).toEqual({ activated: ['g2'], opened: [{ worktreePath: '/w', rel: 'B.md' }], stores: ['/w'] })
    // 다시 부르면 되돌아간다(같은 처리기 — 부를 때마다 지금 상태를 읽는다)
    act(() => run())
    expect(markdownModes.get('file:B.md')).toBe('preview')
  })
  it('팔레트 경로(포커스 = 문서 본문) → 활성 탭 A.md 전환 · 영역 활성화 없음', () => {
    const { run, calls } = handler({ root: '/w', activeGroupId: 'g1', activeTabId: 'file:A.md', focused: document.body })
    act(() => run())
    expect(markdownModes.get('file:A.md')).toBe('source')
    expect(calls).toEqual({ activated: [], opened: [{ worktreePath: '/w', rel: 'A.md' }], stores: ['/w'] })
  })
  it('worktree 없음 → 아무것도 안 함 · 활성 탭이 터미널 → 무변화', () => {
    const none = handler({ root: null, activeGroupId: 'g1', activeTabId: 'file:A.md', focused: group('g1') })
    act(() => none.run())
    expect(none.calls).toEqual({ activated: [], opened: [], stores: [] })
    const terminal = handler({ root: '/w', activeGroupId: 'g1', activeTabId: 'term-1', focused: document.body })
    act(() => terminal.run())
    expect(terminal.calls.opened).toEqual([])
    expect([...markdownModes]).toEqual([['file:A.md', 'preview'], ['file:B.md', 'preview']])
  })
})
