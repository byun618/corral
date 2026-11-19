// @vitest-environment happy-dom
// LIFE-803 C5·C6 — 줄 열기 요청 상태 표(결과 행 클릭·편집기 준비·다른 탭 활성화). 가짜 편집기 객체로 적용을 본다.
import { describe, expect, it } from 'vitest'
import { applyReveal, focusMovedAway, RevealSlot } from './file-reveal.js'

const yes = (): boolean => true

const fakeEditor = () => {
  const log: string[] = []
  return {
    log,
    editor: {
      setPosition: (position: { lineNumber: number; column: number }) => log.push(`pos ${position.lineNumber}:${position.column}`),
      revealPositionInCenterIfOutsideViewport: (position: { lineNumber: number; column: number }) => log.push(`reveal ${position.lineNumber}:${position.column}`),
      focus: () => log.push('focus'),
    },
  }
}

describe('결과 행 클릭 → 편집기 준비', () => {
  it('그 저장소·탭의 편집기가 준비되면 한 번만 꺼낸다', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 12, column: 9 }, mayFocus: yes })
    expect(slot.take({ store, tabId: 'file:b.ts' })).toBeNull()
    expect(slot.take({ store: new Map(), tabId: 'file:a.ts' })).toBeNull()
    expect(slot.take({ store, tabId: 'file:a.ts' })?.target).toEqual({ line: 12, column: 9 })
    expect(slot.take({ store, tabId: 'file:a.ts' })).toBeNull()
  })
  it('첫 마운트 전에 다른 결과를 누르면 마지막 요청만 산다(C5ⓔ)', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 1, column: 1 }, mayFocus: yes })
    slot.request({ store, tabId: 'file:b.ts', target: { line: 5, column: 3 }, mayFocus: yes })
    expect(slot.take({ store, tabId: 'file:a.ts' })).toBeNull()
    expect(slot.take({ store, tabId: 'file:b.ts' })?.target).toEqual({ line: 5, column: 3 })
  })
  it('같은 탭의 다른 줄을 다시 누르면 새 위치', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 1, column: 1 }, mayFocus: yes })
    slot.request({ store, tabId: 'file:a.ts', target: { line: 40, column: 2 }, mayFocus: yes })
    expect(slot.take({ store, tabId: 'file:a.ts' })?.target).toEqual({ line: 40, column: 2 })
  })
})

describe('사용자가 다른 탭·다른 그룹·worktree 를 활성화', () => {
  it('대기 요청의 탭이 아니면 적용 권리를 지운다', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 3, column: 1 }, mayFocus: yes })
    slot.activated({ store, tabId: 'file:a.ts' })
    expect(slot.current?.tabId).toBe('file:a.ts')
    slot.activated({ store, tabId: 'term:1' })
    expect(slot.take({ store, tabId: 'file:a.ts' })).toBeNull()
  })
  it('다른 worktree(저장소)로 가도 지운다', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 3, column: 1 }, mayFocus: yes })
    slot.activated({ store: new Map(), tabId: 'file:a.ts' })
    expect(slot.current).toBeNull()
  })
})

describe('적용 — 커서·보이기·포커스', () => {
  it('Monaco 위치(1부터 줄·UTF-16 열)로 커서를 두고 뷰 밖이면 가운데로, 포커스', () => {
    const { editor, log } = fakeEditor()
    applyReveal(editor, { target: { line: 1, column: 10 }, mayFocus: yes })
    expect(log).toEqual(['pos 1:10', 'reveal 1:10', 'focus'])
  })
  it('r1 보강 — 요청 뒤 포커스가 옮겨 갔으면(mayFocus 거짓) 커서·보이기만', () => {
    const { editor, log } = fakeEditor()
    applyReveal(editor, { target: { line: 3, column: 2 }, mayFocus: () => false })
    expect(log).toEqual(['pos 3:2', 'reveal 3:2'])
  })
})

describe('r1 보강 — 편집기를 붙이지 않는 탭', () => {
  it('discard — 그 탭의 요청만 버린다', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.md', target: { line: 3, column: 1 }, mayFocus: yes })
    slot.discard({ store, tabId: 'file:b.md' })
    expect(slot.current?.tabId).toBe('file:a.md')
    slot.discard({ store, tabId: 'file:a.md' })
    expect(slot.current).toBeNull()
  })
})

describe('r1 보강 — focusMovedAway(요청 뒤 포커스가 옮겨 갔는가)', () => {
  const box = (attr?: string): Element => {
    const element = document.createElement('div')
    if (attr !== undefined) element.setAttribute(attr, '')
    const child = document.createElement('input')
    element.append(child)
    return child
  }
  it('그대로·body·null·편집기 안이면 거짓, 다른 곳(검색 입력칸 등)이면 참', () => {
    const from = box()
    const body = document.createElement('body')
    expect(focusMovedAway({ from, now: from, body })).toBe(false)
    expect(focusMovedAway({ from, now: body, body })).toBe(false)
    expect(focusMovedAway({ from, now: null, body })).toBe(false)
    expect(focusMovedAway({ from, now: box('data-file-editor'), body })).toBe(false)
    expect(focusMovedAway({ from, now: box('data-search-view'), body })).toBe(true)
  })
})

describe('r3 R3-03 — 편집기를 붙이지 않는 동안은 다시 온 요청도 받지 않는다', () => {
  it('refuse 동안 그 탭 요청은 남지 않고(앞 요청은 대체), 풀면 다시 받는다', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:b.ts', target: { line: 1, column: 1 }, mayFocus: yes })
    const release = slot.refuse({ store, tabId: 'file:a.ts' })
    expect(slot.current?.tabId).toBe('file:b.ts')
    slot.request({ store, tabId: 'file:a.ts', target: { line: 2, column: 1 }, mayFocus: yes })
    expect(slot.current).toBeNull()
    release()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 3, column: 1 }, mayFocus: yes })
    expect(slot.current?.target).toEqual({ line: 3, column: 1 })
  })
})
