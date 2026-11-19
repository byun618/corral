// LIFE-803 C5·C6 — 줄 열기 요청 상태 표(결과 행 클릭·편집기 준비·다른 탭 활성화). 가짜 편집기 객체로 적용을 본다.
import { describe, expect, it } from 'vitest'
import { applyReveal, RevealSlot } from './file-reveal.js'

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
    slot.request({ store, tabId: 'file:a.ts', target: { line: 12, column: 9 } })
    expect(slot.take({ store, tabId: 'file:b.ts' })).toBeNull()
    expect(slot.take({ store: new Map(), tabId: 'file:a.ts' })).toBeNull()
    expect(slot.take({ store, tabId: 'file:a.ts' })).toEqual({ line: 12, column: 9 })
    expect(slot.take({ store, tabId: 'file:a.ts' })).toBeNull()
  })
  it('첫 마운트 전에 다른 결과를 누르면 마지막 요청만 산다(C5ⓔ)', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 1, column: 1 } })
    slot.request({ store, tabId: 'file:b.ts', target: { line: 5, column: 3 } })
    expect(slot.take({ store, tabId: 'file:a.ts' })).toBeNull()
    expect(slot.take({ store, tabId: 'file:b.ts' })).toEqual({ line: 5, column: 3 })
  })
  it('같은 탭의 다른 줄을 다시 누르면 새 위치', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 1, column: 1 } })
    slot.request({ store, tabId: 'file:a.ts', target: { line: 40, column: 2 } })
    expect(slot.take({ store, tabId: 'file:a.ts' })).toEqual({ line: 40, column: 2 })
  })
})

describe('사용자가 다른 탭·다른 그룹·worktree 를 활성화', () => {
  it('대기 요청의 탭이 아니면 적용 권리를 지운다', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 3, column: 1 } })
    slot.activated({ store, tabId: 'file:a.ts' })
    expect(slot.current?.tabId).toBe('file:a.ts')
    slot.activated({ store, tabId: 'term:1' })
    expect(slot.take({ store, tabId: 'file:a.ts' })).toBeNull()
  })
  it('다른 worktree(저장소)로 가도 지운다', () => {
    const slot = new RevealSlot()
    const store = new Map()
    slot.request({ store, tabId: 'file:a.ts', target: { line: 3, column: 1 } })
    slot.activated({ store: new Map(), tabId: 'file:a.ts' })
    expect(slot.current).toBeNull()
  })
})

describe('적용 — 커서·보이기·포커스', () => {
  it('Monaco 위치(1부터 줄·UTF-16 열)로 커서를 두고 뷰 밖이면 가운데로, 포커스', () => {
    const { editor, log } = fakeEditor()
    applyReveal(editor, { line: 1, column: 10 })
    expect(log).toEqual(['pos 1:10', 'reveal 1:10', 'focus'])
  })
})
