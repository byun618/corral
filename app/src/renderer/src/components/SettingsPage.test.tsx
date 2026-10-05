// @vitest-environment happy-dom
// LIFE-511 K2ⓑ·K3ⓑⓒ·K5ⓑⓒ·K6ⓓ — 설정 페이지: 내비(섹션 있는 그룹만) · 한 번에 섹션 하나 · 돌아가기 · ⌘F · 결과 없음 · Esc 2단계(2.2초).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SETTINGS_ESCAPE_CONFIRM_MS, SettingsNavItem, SettingsPage } from './SettingsPage.js'
import { SETTINGS_SECTIONS } from '../settings-registry.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Reflect.set(window, 'corral', { setShortcutRecording: async () => {}, saveKeybindings: async () => ({ ok: true, overrides: {} }) })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function mount(): { view: HTMLDivElement; onClose: ReturnType<typeof vi.fn>; onSelect: ReturnType<typeof vi.fn> } {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onClose = vi.fn()
  const onSelect = vi.fn()
  act(() => root.render(createElement(SettingsPage, { section: 'shortcuts', onSelectSection: onSelect, onClose, overrides: {}, onChangeOverrides: () => {} })))
  return { view: host, onClose, onSelect }
}
const key = (init: KeyboardEventInit, target: EventTarget = document.body): void => { act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) }
const type = (input: HTMLInputElement, value: string): void => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setValue.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

it('내비 — 돌아가기 · 검색 · 「인터페이스」 그룹 하나 · 「단축키」 활성(aria-current) · 섹션 하나만 마운트', () => {
  const { view } = mount()
  expect(view.querySelector('[data-settings-back]')?.textContent).toBe('앱으로 돌아가기')
  expect([...view.querySelectorAll('[data-settings-group-title]')].map((el) => el.textContent)).toEqual(['인터페이스'])
  const item = view.querySelector('[data-settings-nav-item="shortcuts"]')!
  expect(item.getAttribute('aria-current')).toBe('page')
  expect(view.querySelectorAll('[data-settings-section]')).toHaveLength(1)
  expect(view.querySelector('[data-settings-section] h2')?.textContent).toBe('단축키')
  // 들어오면 검색창이 포커스(198 searchAutoFocus).
  expect(document.activeElement?.hasAttribute('data-settings-search')).toBe(true)
  // 모달이 아니다 — dialog 역할이 없다(K6ⓐ).
  expect(view.querySelector('[role="dialog"]')).toBeNull()
})

it('「앱으로 돌아가기」 = onClose · 내비 행 = onSelectSection', () => {
  const { view, onClose, onSelect } = mount()
  act(() => view.querySelector<HTMLButtonElement>('[data-settings-nav-item="shortcuts"]')!.click())
  expect(onSelect).toHaveBeenCalledWith('shortcuts')
  act(() => view.querySelector<HTMLButtonElement>('[data-settings-back]')!.click())
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('⌘F — 검색창에 포커스하고 전체 선택한다', () => {
  const { view } = mount()
  const search = view.querySelector<HTMLInputElement>('[data-settings-search]')!
  type(search, '단축')
  view.querySelector<HTMLButtonElement>('[data-settings-back]')!.focus()
  key({ key: 'f', code: 'KeyF', metaKey: true })
  expect(document.activeElement).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 2])
  // ⌘⇧F 는 다른 키다.
  view.querySelector<HTMLButtonElement>('[data-settings-back]')!.focus()
  key({ key: 'f', code: 'KeyF', metaKey: true, shiftKey: true })
  expect(document.activeElement).not.toBe(search)
})

it('검색 — 결과 없음 상태 · 지우면 섹션이 돌아온다 · 한·영 질의', () => {
  const { view } = mount()
  const search = view.querySelector<HTMLInputElement>('[data-settings-search]')!
  type(search, '없는 설정')
  expect(view.querySelectorAll('[data-settings-group]')).toHaveLength(0)
  expect(view.querySelector('[data-settings-section]')).toBeNull()
  expect(view.querySelector('[data-settings-empty]')?.textContent).toBe('「없는 설정」 에 맞는 설정이 없습니다')
  type(search, 'keybinding')
  expect(view.querySelector('[data-settings-section="shortcuts"]')).not.toBeNull()
  type(search, '단축키')
  expect(view.querySelector('[data-settings-nav-item="shortcuts"]')).not.toBeNull()
  // 검색창의 ⌘F 힌트는 질의가 없을 때만.
  expect(view.querySelector('.settings-search-hint')).toBeNull()
})

it('Esc 2단계 — 첫 Esc 는 확인 창, 2.2초 안의 두 번째 Esc 에서만 닫힌다', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'))
  const { view, onClose } = mount()
  key({ key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  expect(view.querySelector('[data-settings-escape-confirm]')?.textContent).toBe('Esc 를 한 번 더 누르면 설정을 닫습니다')
  vi.setSystemTime(new Date(Date.now() + SETTINGS_ESCAPE_CONFIRM_MS - 100))
  key({ key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('Esc 2단계 — 확인 창이 지나면(2.2초) 다시 첫 Esc 가 된다 · 확인 표시도 사라진다', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'))
  const { view, onClose } = mount()
  key({ key: 'Escape' })
  act(() => { vi.advanceTimersByTime(SETTINGS_ESCAPE_CONFIRM_MS + 1) })
  expect(view.querySelector('[data-settings-escape-confirm]')).toBeNull()
  key({ key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  expect(view.querySelector('[data-settings-escape-confirm]')).not.toBeNull()
})

it('Esc — 검색창에 포커스가 있어도 같은 2단계 · 조합 중(IME)·이미 처리된 Esc 는 무시', () => {
  const { view, onClose } = mount()
  const search = view.querySelector<HTMLInputElement>('[data-settings-search]')!
  key({ key: 'Escape', isComposing: true }, search)
  expect(view.querySelector('[data-settings-escape-confirm]')).toBeNull()
  const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  handled.preventDefault()
  act(() => { search.dispatchEvent(handled) })
  expect(view.querySelector('[data-settings-escape-confirm]')).toBeNull()
  key({ key: 'Escape' }, search)
  key({ key: 'Escape' }, search)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('내비 행 배지 자리(K3ⓐ) — badge 가 있으면 행 오른쪽에 그리고, 없으면 그리지 않는다', () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onSelect = vi.fn()
  act(() => root.render(createElement('div', null,
    createElement(SettingsNavItem, { section: { ...SETTINGS_SECTIONS[0], badge: '베타' }, active: false, onSelect }),
    createElement(SettingsNavItem, { section: SETTINGS_SECTIONS[0], active: true, onSelect }))))
  const [withBadge, plain] = [...host.querySelectorAll<HTMLButtonElement>('[data-settings-nav-item]')]
  expect(withBadge!.querySelector('[data-settings-nav-badge]')?.textContent).toBe('베타')
  expect(withBadge!.getAttribute('aria-current')).toBeNull()
  expect(plain!.querySelector('[data-settings-nav-badge]')).toBeNull()
  expect(plain!.getAttribute('aria-current')).toBe('page')
  act(() => withBadge!.click())
  expect(onSelect).toHaveBeenCalledWith('shortcuts')
})
