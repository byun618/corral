// @vitest-environment happy-dom
// 카드 대화·피커 (LIFE-478 r2 R2B-01~08) — 삭제 대화·정보 수정 대화·상위 피커를 실제로 그려 본다.
//   · Esc 는 포커스와 무관하게 닫고(터미널 자리의 입력란이 포커스여도), 그 키는 터미널로 새지 않는다 · IME 조합 중 Esc 는 무시
//   · 첫 포커스: 「삭제」 = 확인 단추, 「강제 삭제」·막힘·읽기 실패 = 취소/닫기
//   · 대화가 뜨면 열려 있던 hover 카드가 닫힌다(K2ⓔ)
//   · 피커 강조 행이 밖으로 가면 스크롤한다 · 정보 수정 대화: 저장 실패·저장 중 닫기·연 순간 값 기준 비교
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeDeletePreview, WorktreeRow } from '../../../shared/types.js'
import { DeleteWorktreeDialog } from './DeleteWorktreeDialog.js'
import { HoverCard } from './HoverCard.js'
import { ParentPicker } from './ParentPicker.js'
import { RevealConfirmDialog } from './RevealConfirmDialog.js'
import { WorktreeMetaDialog } from './WorktreeMetaDialog.js'
import { useWindowEscape } from '../menu-bus.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const row = (input: { path: string; displayName?: string | null; comment?: string | null }): WorktreeRow => ({
  path: input.path, branch: input.path.split('/').at(-1) ?? null, isLinked: true, openWorkspaceId: null,
  gitStatus: { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
  workspace: null, displayName: input.displayName ?? null, comment: input.comment ?? null, parentPath: null,
})
const preview = (input: { dirtyCount?: number; locked?: boolean; isMain?: boolean }): WorktreeDeletePreview => ({
  ok: true, path: '/r-wt/a', branch: 'a', isMain: input.isMain ?? false, locked: input.locked ?? false, dirtyCount: input.dirtyCount ?? 0,
  liveSessions: 0, backendError: null, childPaths: [],
})

let host: HTMLDivElement
let root: Root
/** 터미널 자리 — xterm 의 숨은 입력란처럼 포커스를 쥐고 keydown 을 받는다. */
let terminal: HTMLTextAreaElement
let terminalKeys: string[]

/** 없으면 설명을 붙여 throw 하는 조회 — 비 null 단언 대신 준비 조건을 드러낸다(LIFE-516 fix1 R1-06). */
const buttonOf = (selector: string): HTMLButtonElement => {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`버튼 없음: ${selector}`)
  return found
}
const checkboxOf = (selector: string): HTMLInputElement => {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLInputElement)) throw new Error(`체크박스 없음: ${selector}`)
  return found
}
const render = (element: React.ReactElement): void => act(() => root.render(element))
const escapeFrom = (target: EventTarget, init: { isComposing?: boolean } = {}): void =>
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: init.isComposing ?? false })))

beforeEach(() => {
  host = document.createElement('div')
  terminal = document.createElement('textarea')
  terminal.className = 'xterm-helper-textarea'
  terminalKeys = []
  terminal.addEventListener('keydown', (event) => terminalKeys.push(event.key))
  document.body.append(terminal, host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  terminal.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('삭제 대화 — Esc·첫 포커스 (R2B-01·08)', () => {
  const states: Array<{ id: string; preview: WorktreeDeletePreview | null; focus: string | null }> = [
    { id: '읽는 중', preview: null, focus: null },
    { id: '읽기 실패', preview: { ok: false, code: 'x', error: 'y' }, focus: '[data-delete-cancel]' },
    { id: '막힘(잠김)', preview: preview({ locked: true }), focus: '[data-delete-cancel]' },
    { id: '막힘(주 체크아웃)', preview: preview({ isMain: true }), focus: '[data-delete-cancel]' },
    { id: '강제', preview: preview({ dirtyCount: 2 }), focus: '[data-delete-cancel]' },
    { id: '삭제', preview: preview({}), focus: '[data-delete-confirm="delete"]' },
  ]
  // 「터미널로 가지 않는다」 단언이 판별력을 갖는 것은 **읽는 중 상태 한정**이다(r3 L-04) — 첫 포커스가 없어 터미널이
  // 포커스를 쥔 채 Esc 가 터미널에서 출발한다. 다른 상태는 대화가 첫 포커스를 가져가 Esc 가 대화 안에서 출발하므로
  // 터미널에 닿을 경로가 없다 — 거기서는 「포커스와 무관하게 닫힘」·첫 포커스만 판별한다.
  for (const state of states) {
    it(`${state.id}: 터미널이 포커스여도 Esc 로 닫히고 그 Esc 는 터미널로 가지 않는다${state.focus === null ? '(누출 판별 — 읽는 중 상태 한정)' : '(첫 포커스가 대화 안 — 누출 판별 아님)'}`, () => {
      const onClose = vi.fn()
      terminal.focus()
      render(createElement(DeleteWorktreeDialog, { name: 'a', path: '/r-wt/a', preview: state.preview, onConfirm: () => {}, onClose }))
      if (state.focus === null) expect(document.activeElement).toBe(terminal)
      else expect(document.activeElement).toBe(document.querySelector(state.focus))
      escapeFrom(document.activeElement ?? document.body)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(terminalKeys).toEqual([])
    })
  }
  // LIFE-516 K5ⓐ·D4 — 「다시 묻지 않음」 은 「삭제」 판정에만. 체크박스가 생겨도 첫 포커스는 위 표 그대로(확인 단추).
  for (const state of states) {
    it(`${state.id}: 「깨끗한 워크트리는 다시 묻지 않기」 체크박스 ${state.id === '삭제' ? '있음' : '없음'}`, () => {
      render(createElement(DeleteWorktreeDialog, { name: 'a', path: '/r-wt/a', preview: state.preview, onConfirm: () => {}, onClose: () => {} }))
      const box = document.querySelector('[data-dont-ask-again]')
      if (state.id === '삭제') expect(box?.textContent).toBe('깨끗한 워크트리는 다시 묻지 않기')
      else expect(box).toBeNull()
    })
  }
  it('「삭제」 판정: 체크 + 「삭제」 → onConfirm({ force:false, dontAskAgain:true }) · 체크 없이 → dontAskAgain:false', () => {
    const onConfirm = vi.fn()
    render(createElement(DeleteWorktreeDialog, { name: 'a', path: '/r-wt/a', preview: preview({}), onConfirm, onClose: () => {} }))
    act(() => buttonOf('[data-delete-confirm="delete"]').click())
    act(() => checkboxOf('[data-dont-ask-again-input]').click())
    act(() => buttonOf('[data-delete-confirm="delete"]').click())
    expect(onConfirm.mock.calls).toEqual([[{ force: false, dontAskAgain: false }], [{ force: false, dontAskAgain: true }]])
  })
  it('「강제」 판정의 「강제 삭제」 는 dontAskAgain 을 싣지 않는다', () => {
    const onConfirm = vi.fn()
    render(createElement(DeleteWorktreeDialog, { name: 'a', path: '/r-wt/a', preview: preview({ dirtyCount: 1 }), onConfirm, onClose: () => {} }))
    act(() => buttonOf('[data-delete-confirm="force"]').click())
    expect(onConfirm.mock.calls).toEqual([[{ force: true, dontAskAgain: false }]])
  })
  it('막힘이면 취소 단추 글자가 「닫기」', () => {
    render(createElement(DeleteWorktreeDialog, { name: 'a', path: '/r-wt/a', preview: preview({ locked: true }), onConfirm: () => {}, onClose: () => {} }))
    expect(document.querySelector('[data-delete-cancel]')?.textContent).toBe('닫기')
  })
  it('IME 조합 중 Esc 는 닫지 않는다', () => {
    const onClose = vi.fn()
    render(createElement(DeleteWorktreeDialog, { name: 'a', path: '/r-wt/a', preview: null, onConfirm: () => {}, onClose }))
    escapeFrom(document.body, { isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('대화가 뜨면 열린 hover 카드가 닫힌다 (R2B-02 · K2ⓔ)', () => {
  const openCard = (): void => {
    vi.useFakeTimers()
    render(
      createElement('div', null, [
        createElement(HoverCard, {
          key: 'card',
          content: createElement('div', null, '메모'),
          suppressed: false,
          testId: 't',
          render: (trigger) => createElement('span', { ...trigger, id: 'trigger' }, 'title'),
        }),
      ]),
    )
    act(() => void document.querySelector('#trigger')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => void vi.advanceTimersByTime(150))
    expect(document.querySelector('[data-hover-card]')).not.toBeNull()
  }
  const withDialog = (dialog: React.ReactElement): void =>
    render(
      createElement('div', null, [
        createElement(HoverCard, {
          key: 'card',
          content: createElement('div', null, '메모'),
          suppressed: false,
          testId: 't',
          render: (trigger) => createElement('span', { ...trigger, id: 'trigger' }, 'title'),
        }),
        createElement('div', { key: 'dialog' }, dialog),
      ]),
    )
  it('삭제 대화(⌘⇧⌫·휴지통 경로)', () => {
    openCard()
    withDialog(createElement(DeleteWorktreeDialog, { name: 'a', path: '/r-wt/a', preview: null, onConfirm: () => {}, onClose: () => {} }))
    expect(document.querySelector('[data-hover-card]')).toBeNull()
  })
  it('정보 수정 대화(제목 밖 더블클릭 경로)', () => {
    openCard()
    withDialog(createElement(WorktreeMetaDialog, { worktree: row({ path: '/r-wt/a' }), onSave: () => Promise.resolve(null), onClose: () => {} }))
    expect(document.querySelector('[data-hover-card]')).toBeNull()
  })
  it('숨겨진 워크스페이스 확인 대화(Reveal 경로 — r3 L-01)', () => {
    openCard()
    withDialog(createElement(RevealConfirmDialog, { path: '/r-wt/a', onKeep: () => {}, onClear: () => {} }))
    expect(document.querySelector('[data-hover-card]')).toBeNull()
  })
})

describe('상위 피커 (R2B-01·03)', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => row({ path: `/r-wt/c${String(index).padStart(2, '0')}` }))
  const mount = (onClose: () => void): void =>
    render(createElement(ParentPicker, { child: row({ path: '/r-wt/child' }), candidates, anchor: { left: 0, right: 100, top: 10 }, activePath: null, onPick: () => {}, onClose }))
  it('End → 마지막 행이 강조되고 그 행을 보이는 영역으로 스크롤한다', () => {
    const scrolled: string[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this.getAttribute('data-parent-candidate') ?? '')
    })
    mount(() => {})
    const input = document.querySelector('[data-parent-picker-search]')
    if (input === null) throw new Error('검색 입력 없음')
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(document.querySelector('[aria-selected="true"]')?.getAttribute('data-parent-candidate')).toBe('/r-wt/c19')
    expect(scrolled.at(-1)).toBe('/r-wt/c19')
  })
  it('안쪽 빈 곳을 눌러 포커스가 body 로 가도 Esc 로 닫힌다 · 조합 중 Esc 는 무시', () => {
    const onClose = vi.fn()
    mount(onClose)
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    escapeFrom(document.body, { isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    escapeFrom(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('정보 수정 대화 (R2B-01·04·05·06·07)', () => {
  it('포커스가 body 여도 Esc 로 닫힌다 · 조합 중 Esc 는 무시', () => {
    const onClose = vi.fn()
    render(createElement(WorktreeMetaDialog, { worktree: row({ path: '/r-wt/a' }), onSave: () => Promise.resolve(null), onClose }))
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    escapeFrom(document.body, { isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    escapeFrom(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  const typeName = (value: string): void => {
    const input = document.querySelector<HTMLInputElement>('[data-meta-display-name]')
    if (input === null) throw new Error('이름 입력 없음')
    act(() => {
      Reflect.get(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? {}, 'set')?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const save = (): void => act(() => void document.querySelector<HTMLButtonElement>('[data-meta-save]')?.click())
  it('저장이 던지면 「저장 중…」 에 갇히지 않고 오류를 대화 안에 보인다', async () => {
    render(createElement(WorktreeMetaDialog, { worktree: row({ path: '/r-wt/a' }), onSave: () => Promise.reject(new Error('ipc down')), onClose: () => {} }))
    typeName('새 이름')
    await act(async () => save())
    expect(document.querySelector('[data-meta-error]')?.textContent).toContain('ipc down')
    expect(document.querySelector<HTMLButtonElement>('[data-meta-save]')?.disabled).toBe(false)
  })
  it('저장 중에는 Esc·scrim·✕·취소로 닫히지 않고, 뒤이은 실패가 대화 안에 보인다', async () => {
    let finish: (failure: string | null) => void = () => {}
    const onClose = vi.fn()
    render(createElement(WorktreeMetaDialog, { worktree: row({ path: '/r-wt/a' }), onSave: () => new Promise<string | null>((resolve) => (finish = resolve)), onClose }))
    typeName('새 이름')
    save()
    escapeFrom(document.body)
    act(() => void document.querySelector('[data-modal-scrim]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    act(() => void document.querySelector<HTMLButtonElement>('.modal-close')?.click())
    act(() => void document.querySelector<HTMLButtonElement>('[data-meta-cancel]')?.click())
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish('Registry busy'))
    expect(document.querySelector('[data-meta-error]')?.textContent).toContain('Registry busy')
  })
  it('연 동안 바뀐 칸(코멘트)은 건드리지 않았으면 보내지 않는다 — 비교 기준 = 연 순간의 값', async () => {
    const onSave = vi.fn<(patch: { displayName?: string | null; comment?: string | null }) => Promise<string | null>>(() => Promise.resolve(null))
    render(createElement(WorktreeMetaDialog, { worktree: row({ path: '/r-wt/a', comment: '처음' }), onSave, onClose: () => {} }))
    render(createElement(WorktreeMetaDialog, { worktree: row({ path: '/r-wt/a', comment: 'CLI 가 바꾼 값' }), onSave, onClose: () => {} }))
    typeName('새 이름')
    await act(async () => save())
    expect(onSave).toHaveBeenCalledWith({ displayName: '새 이름' })
  })
})

describe('숨겨진 워크스페이스 확인 대화 (r3 L-01)', () => {
  it('body 포커스에서 Esc 로 「필터 유지」(닫힘) · 조합 중 Esc 무시', () => {
    const onKeep = vi.fn()
    render(createElement(RevealConfirmDialog, { path: '/r-wt/a', onKeep, onClear: () => {} }))
    escapeFrom(document.body, { isComposing: true })
    expect(onKeep).not.toHaveBeenCalled()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    escapeFrom(document.body)
    expect(onKeep).toHaveBeenCalledTimes(1)
    expect(terminalKeys).toEqual([])
  })
})

describe('useWindowEscape 정리 (r3 L-02)', () => {
  it('언마운트 뒤 Esc 는 onEscape 를 부르지 않는다', () => {
    const onEscape = vi.fn()
    const Probe = (): null => {
      useWindowEscape({ onEscape })
      return null
    }
    render(createElement(Probe))
    escapeFrom(document.body)
    expect(onEscape).toHaveBeenCalledTimes(1)
    render(createElement('div'))
    escapeFrom(document.body)
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
})
