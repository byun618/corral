// @vitest-environment happy-dom
// 우클릭 메뉴 부품 (LIFE-478 K2ⓑⓒⓓ) — 실제 컴포넌트를 DOM 에 그리고 키보드·hover·닫힘·메뉴 하나 규칙을 본다.
// 강조는 포커스가 아니라 상태다(#14545) — 시험은 포커스를 한 번도 주지 않고 hover·키를 보낸다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, type MenuEntry } from './ContextMenu.js'
import { announceMenuOpen } from '../menu-bus.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

type Action = 'a' | 'b' | 'open' | 'f' | 'v' | 'off'
const ENTRIES: MenuEntry<Action>[] = [
  { kind: 'label', key: 'l', label: '워크스페이스' },
  { kind: 'item', action: 'a', label: 'A' },
  { kind: 'item', action: 'off', label: 'Off', disabled: true },
  { kind: 'sep', key: 's' },
  { kind: 'item', action: 'open', label: '열기', submenu: [{ kind: 'item', action: 'f', label: 'Finder' }, { kind: 'item', action: 'v', label: 'VS Code' }] },
  { kind: 'item', action: 'b', label: 'B' },
]

let host: HTMLDivElement
let root: Root
let onAction: ReturnType<typeof vi.fn<(action: Action) => void>>
let onClose: ReturnType<typeof vi.fn<() => void>>

function mount(): void {
  act(() => {
    root.render(createElement(ContextMenu<Action>, { x: 10, y: 20, entries: ENTRIES, onAction, onClose, attrs: { 'data-card-menu': '/r/a' } }))
  })
}
const key = (name: string): void => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })))
// 서브메뉴가 열려 있으면 그 안의 강조(부모 항목은 열린 표시로 강조가 남는다).
const active = (): string | null =>
  (document.querySelector('[data-context-submenu] [data-menu-active]') ?? document.querySelector('[data-menu-active]'))?.getAttribute('data-menu-action') ?? null
const item = (action: Action): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-menu-action="${action}"]`)
  if (element === null) throw new Error(`항목 없음: ${action}`)
  return element
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  onAction = vi.fn<(action: Action) => void>()
  onClose = vi.fn<() => void>()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ContextMenu 키보드 (K2ⓒ)', () => {
  it('↓ 는 disabled·구분선·라벨을 건너뛰고 끝에서 감긴다 · ↑ 는 거꾸로', () => {
    mount()
    expect(active()).toBeNull()
    key('ArrowDown')
    expect(active()).toBe('a')
    key('ArrowDown')
    expect(active()).toBe('open')
    key('ArrowDown')
    expect(active()).toBe('b')
    key('ArrowDown')
    expect(active()).toBe('a')
    key('ArrowUp')
    expect(active()).toBe('b')
  })
  it('Enter 는 선택 — 메뉴를 닫고 동작을 부른다', () => {
    mount()
    key('ArrowDown')
    key('Enter')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('a')
  })
  it('→ 서브메뉴 열기(첫 항목 강조) · ↓ 이동 · ← 닫기 · 서브메뉴 Enter', () => {
    mount()
    key('ArrowDown')
    key('ArrowDown')
    key('ArrowRight')
    expect(document.querySelector('[data-context-submenu="open"]')).not.toBeNull()
    expect(active()).toBe('f')
    key('ArrowDown')
    expect(active()).toBe('v')
    key('ArrowLeft')
    expect(document.querySelector('[data-context-submenu]')).toBeNull()
    expect(active()).toBe('open')
    key('ArrowRight')
    key('ArrowDown')
    key('Enter')
    expect(onAction).toHaveBeenCalledWith('v')
  })
  it('Esc 는 닫는다(키는 메뉴가 먹는다 — 기본 동작 막음)', () => {
    mount()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void window.dispatchEvent(event))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('ContextMenu 마우스·닫힘 (K2ⓑⓓ · #14545)', () => {
  it('hover 가 포커스 없이 강조를 옮긴다 · disabled 는 강조하지 않고 눌러도 아무 일 없다', () => {
    mount()
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true)
    act(() => void item('b').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
    expect(active()).toBe('b')
    act(() => void item('off').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
    expect(active()).toBeNull()
    act(() => item('off').click())
    expect(onAction).not.toHaveBeenCalled()
    act(() => item('b').click())
    expect(onAction).toHaveBeenCalledWith('b')
  })
  it('hover 로 서브메뉴가 열리고 그 항목 클릭이 동작을 부른다', () => {
    mount()
    act(() => void item('open').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
    act(() => item('f').click())
    expect(onAction).toHaveBeenCalledWith('f')
  })
  it('바깥 mousedown · 창 blur · 스크롤 · resize 에 닫힌다, 메뉴 안 mousedown 은 아니다', () => {
    mount()
    act(() => void item('a').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(onClose).not.toHaveBeenCalled()
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
    for (const type of ['blur', 'resize']) act(() => void window.dispatchEvent(new Event(type)))
    act(() => void document.body.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(4)
  })
  it('메뉴는 한 번에 하나 — 다른 메뉴가 열렸다고 알리면 닫힌다', () => {
    mount()
    expect(onClose).not.toHaveBeenCalled()
    act(() => announceMenuOpen('another-menu'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('포인터 위치에 연다(창 안이면 그대로)', () => {
    mount()
    const menu = document.querySelector<HTMLElement>('[data-card-menu="/r/a"]')
    expect(menu?.style.left).toBe('10px')
    expect(menu?.style.top).toBe('20px')
  })
})
