// @vitest-environment happy-dom
// LIFE-629 — ⇧⌘V 처리기가 부르는 `toggleMarkdownMode` 가 파일 뷰 버튼과 같은 상태 경로(탭별 `MarkdownModeStore`)로 원문 ↔ 미리보기를 바꾸는지,
// Markdown 이 아닌 탭에서는 아무것도 안 하는지 본다. Monaco 는 싣지 않는다(언어 등록이 끝나지 않는 가짜 — 원문 쪽은 편집기 호스트까지만 그린다).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView, toggleMarkdownMode, type MarkdownModeStore, type ViewStateStore } from './FileView.js'

vi.mock('../editor/monaco.js', () => ({ languageFor: () => new Promise(() => {}) }))
vi.mock('../editor/markdown.js', () => ({ renderMarkdown: () => '<p>미리보기</p>', slugOf: () => '', resolveMarkdownTarget: () => null }))

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  Reflect.set(window, 'corral', {
    readFile: async () => ({ ok: true, kind: 'text', text: '# 제목\n', bom: false, utf8: true, nlink: 1, size: 7, bytesRead: 7, stamp: 's1', hash: 'h1' }),
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (input: { rel: string; markdownModes: MarkdownModeStore }): Promise<void> => {
  const viewStates: ViewStateStore = new Map()
  await act(async () => {
    root.render(
      <FileView root="/w" rel={input.rel} tabId={`file:${input.rel}`} groupId="g1" viewStates={viewStates} markdownModes={input.markdownModes} watched={null} onActivate={() => {}} onOpenFile={() => {}} />,
    )
    await pause(20)
  })
}
const view = (): Element | null => host.querySelector('.file-group')

describe('toggleMarkdownMode (LIFE-629 K3)', () => {
  it('Markdown 탭 — 미리보기 ↔ 원문, 저장소(탭을 오가도 유지)와 버튼 표시가 같이 바뀐다', async () => {
    const markdownModes: MarkdownModeStore = new Map([['file:README.md', 'preview']])
    await render({ rel: 'README.md', markdownModes })
    expect(view()?.getAttribute('data-markdown-view')).toBe('preview')
    expect(host.querySelector('[data-markdown-toggle]')?.getAttribute('data-markdown-toggle')).toBe('source')

    act(() => { expect(toggleMarkdownMode({ store: markdownModes, tabId: 'file:README.md' })).toBe(true) })
    expect(markdownModes.get('file:README.md')).toBe('source')
    expect(view()?.getAttribute('data-markdown-view')).toBe('source')
    expect(host.querySelector('[data-file-editor]')).not.toBeNull()
    expect(host.querySelector('[data-markdown-toggle]')?.getAttribute('data-markdown-toggle')).toBe('preview')

    act(() => { expect(toggleMarkdownMode({ store: markdownModes, tabId: 'file:README.md' })).toBe(true) })
    expect(markdownModes.get('file:README.md')).toBe('preview')
    expect(view()?.getAttribute('data-markdown-view')).toBe('preview')
    // 미리보기 = 편집기 없음 → 보기 자리가 포커스를 받는다(tabIndex -1)
    expect(view()?.getAttribute('tabindex')).toBe('-1')
  })
  it('다시 마운트하면(탭 전환 후 복귀) 저장소의 모드로 연다', async () => {
    const markdownModes: MarkdownModeStore = new Map()
    await render({ rel: 'README.md', markdownModes })
    act(() => { toggleMarkdownMode({ store: markdownModes, tabId: 'file:README.md' }) })
    act(() => root.unmount())
    root = createRoot(host)
    await render({ rel: 'README.md', markdownModes })
    expect(view()?.getAttribute('data-markdown-view')).toBe('preview')
  })
  it('Markdown 이 아닌 탭 · 붙지 않은 탭 → 거짓, 저장소 불변', async () => {
    const markdownModes: MarkdownModeStore = new Map()
    await render({ rel: 'main.ts', markdownModes })
    expect(view()?.hasAttribute('data-markdown-view')).toBe(false)
    expect(toggleMarkdownMode({ store: markdownModes, tabId: 'file:main.ts' })).toBe(false)
    expect(toggleMarkdownMode({ store: markdownModes, tabId: 'file:README.md' })).toBe(false)
    expect(markdownModes.size).toBe(0)
  })
})

describe('캡처 조건 = 전환기 등록 조건 (f2 N-1 — 편집 불가 .md 는 키를 가져가지 않는다)', () => {
  const unreadable = [
    { label: '읽기 실패', result: { ok: false, code: 'not_found', error: 'ENOENT' } },
    { label: '바이너리', result: { ok: true, kind: 'binary', size: 9, bytesRead: 9, stamp: 's1' } },
    { label: '상한 초과', result: { ok: true, kind: 'too_large', size: 99, limit: 10, bytesRead: 0, stamp: 's1' } },
  ]
  for (const item of unreadable) {
    it(`${item.label} .md → data-markdown-view 없음 · toggleMarkdownMode 거짓 · 저장소 불변`, async () => {
      Reflect.set(window, 'corral', { readFile: async () => item.result })
      const markdownModes: MarkdownModeStore = new Map()
      await render({ rel: 'BROKEN.md', markdownModes })
      expect(view()?.getAttribute('data-file-view')).toBe('BROKEN.md')
      expect(view()?.hasAttribute('data-markdown-view')).toBe(false)
      expect(toggleMarkdownMode({ store: markdownModes, tabId: 'file:BROKEN.md' })).toBe(false)
      expect(markdownModes.size).toBe(0)
    })
  }
})
