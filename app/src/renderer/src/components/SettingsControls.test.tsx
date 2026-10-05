// @vitest-environment happy-dom
// LIFE-511 K4ⓒ — 행 그래마 컴포넌트: 접근성 역할·키보드 조작.
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { SettingsRow, SettingsSection, SettingsSegmented, SettingsSubsectionHeader, SettingsSwitch } from './SettingsControls.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
function render(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(node))
  return host
}
const key = (target: Element, name: string): void => {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })
}

it('SettingsSection — h2 + 설명 + 카드, section 은 제목으로 이름이 붙는다', () => {
  const view = render(createElement(SettingsSection, { id: 'shortcuts', title: '단축키', description: '설명' }, createElement('span', null, '본문')))
  const section = view.querySelector('section[data-settings-section="shortcuts"]')!
  expect(section.getAttribute('aria-labelledby')).toBe('settings-section-shortcuts')
  expect(view.querySelector('#settings-section-shortcuts')?.tagName).toBe('H2')
  expect(view.querySelector('[data-settings-section-header] p')?.textContent).toBe('설명')
  expect(view.querySelector('[data-settings-card]')?.textContent).toBe('본문')
})

it('SettingsRow — 설명이 있으면 has-description, 컨트롤 칸이 따로 선다', () => {
  const view = render(createElement('div', null,
    createElement(SettingsRow, { label: '탭 순서', control: createElement('button', null, 'x') }),
    createElement(SettingsRow, { label: '확인', description: '고정 탭', control: createElement('button', null, 'y'), labelId: 'row-l' })))
  const rows = view.querySelectorAll('[data-settings-row]')
  expect(rows[0]!.className).toBe('settings-row')
  expect(rows[1]!.className).toBe('settings-row has-description')
  expect(rows[1]!.querySelector('#row-l')?.textContent).toBe('확인')
  expect(rows[1]!.querySelector('.settings-row-control button')?.textContent).toBe('y')
})

it('SettingsSubsectionHeader — h3 + 설명 + 액션 자리', () => {
  const view = render(createElement(SettingsSubsectionHeader, { title: '키보드 단축키', description: 'd', action: createElement('button', null, 'a') }))
  expect(view.querySelector('h3')?.textContent).toBe('키보드 단축키')
  expect(view.querySelector('.settings-subsection-action button')?.textContent).toBe('a')
})

it('SettingsSwitch — role=switch · aria-checked · 클릭/Space 로 바뀐다 · disabled 면 안 바뀐다', () => {
  function Harness({ disabled }: { disabled?: boolean }): React.JSX.Element {
    const [on, setOn] = useState(false)
    return createElement(SettingsSwitch, { checked: on, onChange: setOn, label: '확인', disabled })
  }
  const view = render(createElement(Harness))
  const toggle = view.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-label')).toBe('확인')
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  act(() => toggle.click())
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  // native button — Space/Enter 는 브라우저가 click 으로 바꾼다. happy-dom 은 바꾸지 않으므로 click 으로 같은 경로를 본다.
  act(() => toggle.click())
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  act(() => root.render(createElement(Harness, { disabled: true })))
  const off = view.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(off.disabled).toBe(true)
  act(() => off.click())
  expect(off.getAttribute('aria-checked')).toBe('false')
})

it('SettingsSegmented — radiogroup · 선택 칸만 Tab 정지 · ←→ 로 비활성 칸을 건너뛰며 고른다', () => {
  function Harness(): React.JSX.Element {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
    return createElement(SettingsSegmented<'a' | 'b' | 'c'>, { value, onChange: setValue, label: '테마', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }] })
  }
  const view = render(createElement(Harness))
  const group = view.querySelector('[role="radiogroup"]')!
  expect(group.getAttribute('aria-label')).toBe('테마')
  const radios = (): HTMLButtonElement[] => [...view.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
  expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1])
  expect(radios()[1]!.getAttribute('aria-disabled')).toBe('true')
  key(radios()[0]!, 'ArrowRight')
  expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
  expect(document.activeElement).toBe(radios()[2])
  key(radios()[2]!, 'ArrowRight')
  expect(radios()[0]!.getAttribute('aria-checked')).toBe('true')
  key(radios()[0]!, 'ArrowLeft')
  expect(radios()[2]!.getAttribute('aria-checked')).toBe('true')
  // 비활성 칸 클릭은 아무 일 없다.
  act(() => radios()[1]!.click())
  expect(radios()[2]!.getAttribute('aria-checked')).toBe('true')
})
