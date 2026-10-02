// @vitest-environment happy-dom
// 인라인 rename 의 blur (LIFE-478 K3ⓐ) — 제목 더블클릭의 첫 클릭이 카드를 활성화하면 뒤늦게 터미널이 포커스를 가져간다.
// 그 blur 로 rename 이 바로 닫히면 안 된다(격리 run4 에서 실제로 닫혔다). 바깥을 누르거나 Tab 으로 떠나면 198 처럼 확정.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationLineage, WorktreeRow } from '../../../shared/types.js'
import { NO_CARD_ACTIONS, WorktreeBlock } from './WorktreeBlock.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const READY_EMPTY: OrchestrationLineage = { state: 'ready', entries: [] }
const worktree: WorktreeRow = {
  path: '/repo/wt', branch: 'feat', isLinked: true, openWorkspaceId: null,
  gitStatus: { branch: 'feat', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
  workspace: null, displayName: null, comment: null, parentPath: null,
}

let host: HTMLDivElement
let other: HTMLButtonElement
let root: Root
let onRenameCommit: ReturnType<typeof vi.fn<(name: string) => void>>
let onRenameCancel: ReturnType<typeof vi.fn<() => void>>

function mount(): HTMLInputElement {
  const noop = (): void => {}
  act(() => {
    root.render(createElement(WorktreeBlock, {
      worktree, reordering: false, dragging: false, onCardMouseDown: noop, selected: false, selectedPane: null, groupGlyph: null, integrations: [],
      home: '/home', now: 0, retained: [], lineage: READY_EMPTY, livePaneIds: new Set<string>(), groupExpanded: false, onToggleGroup: noop,
      onSelectBlock: noop, onSelectSession: noop, onCloseSession: noop, onCloseWorktree: noop, onCreateShell: noop, onCreateAgent: noop,
      card: { ...NO_CARD_ACTIONS, renaming: true, onRenameCommit, onRenameCancel },
    }))
  })
  const input = document.querySelector<HTMLInputElement>('[data-inline-rename]')
  if (input === null) throw new Error('rename 입력 없음')
  return input
}
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const type = (input: HTMLInputElement, value: string): void => {
  act(() => {
    Reflect.get(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? {}, 'set')?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  other = document.createElement('button')
  document.body.append(host, other)
  root = createRoot(host)
  onRenameCommit = vi.fn<(name: string) => void>()
  onRenameCancel = vi.fn<() => void>()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  other.remove()
  vi.restoreAllMocks()
})

describe('InlineRename blur', () => {
  it('프로그램이 포커스를 가져가면(터미널 활성화) 입력으로 되돌리고 확정·취소하지 않는다', async () => {
    const input = mount()
    expect(document.activeElement).toBe(input)
    type(input, '새 이름')
    act(() => other.focus())
    await act(nextFrame)
    expect(document.activeElement).toBe(input)
    expect(onRenameCommit).not.toHaveBeenCalled()
    expect(onRenameCancel).not.toHaveBeenCalled()
  })
  it('바깥을 누르고 떠나면 확정', () => {
    const input = mount()
    type(input, '새 이름')
    act(() => {
      other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      other.focus()
    })
    expect(onRenameCommit).toHaveBeenCalledWith('새 이름')
  })
  it('입력 안 포인터는 떠남이 아니다 · Tab 은 떠남', async () => {
    const input = mount()
    type(input, '탭 이름')
    act(() => void input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    act(() => other.focus())
    await act(nextFrame)
    expect(onRenameCommit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      other.focus()
    })
    expect(onRenameCommit).toHaveBeenCalledWith('탭 이름')
  })
  it('창이 포커스를 잃어 생긴 blur 는 확정(198)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const input = mount()
    type(input, '창 전환')
    act(() => other.focus())
    expect(onRenameCommit).toHaveBeenCalledWith('창 전환')
  })
})
