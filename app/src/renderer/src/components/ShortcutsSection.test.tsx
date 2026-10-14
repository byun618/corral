// @vitest-environment happy-dom
// LIFE-511 K6ⓕ — 설정 › 단축키. 옛 `ShortcutSettings.test.tsx` 의 2건(LIFE-495 fix2 R2-01 양보 null 저장)을 그대로 옮기고
// 기록·저장 전 충돌·기본값·끄기·기록 중 Esc·blur·필터를 더했다. 저장 경계에는 실제 `validateOverrides`(main `keybindings.save` 와 같은 검증).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { matchBinding, validateOverrides, type Keybindings } from '../../../shared/keybindings.js'
import { ShortcutsSection } from './ShortcutsSection.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function mount(overrides: Keybindings): { onChange: ReturnType<typeof vi.fn>; submitted: unknown[]; recording: boolean[]; view: HTMLDivElement } {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onChange = vi.fn()
  const submitted: unknown[] = []
  const recording: boolean[] = []
  Reflect.set(window, 'corral', {
    setShortcutRecording: async (active: boolean) => { recording.push(active) },
    saveKeybindings: async (next: unknown) => {
      submitted.push(next)
      try { return { ok: true, overrides: validateOverrides(next) } } catch (error) { return { ok: false, error: String(error instanceof Error ? error.message : error) } }
    },
  })
  act(() => root.render(createElement(ShortcutsSection, { overrides, onChange })))
  return { onChange, submitted, recording, view: host }
}
// 문서 안 요소에서 쏜다 — 창 캡처(기록기) → 문서 캡처(앱 단축키 useKeybindings) → … 실제 전파 경로를 그대로 탄다.
const press = (init: KeyboardEventInit): void => { act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })) }) }
async function record(view: HTMLElement, action: string, variant: number, init: KeyboardEventInit): Promise<void> {
  await act(async () => view.querySelector<HTMLButtonElement>(`[data-record="${action}"][data-variant="${variant}"]`)!.click())
  press(init)
}
const status = (view: HTMLElement): string => view.querySelector('[role="status"]')?.textContent ?? ''

async function recordAndSave(input: { overrides: Keybindings; action: string; variant: number }): Promise<{ onChange: ReturnType<typeof vi.fn>; submitted: unknown[]; status: string }> {
  const { onChange, submitted, view } = mount(input.overrides)
  await record(view, input.action, input.variant, { key: 'g', code: 'KeyG', ctrlKey: true })
  await act(async () => view.querySelector<HTMLButtonElement>('[data-save-binding]')!.click())
  return { onChange, submitted, status: status(view) }
}

it('fix2 R2-01 비켜 선 ⌃1 칸은 둔 채 ⌃2 칸을 바꿔 저장 — 빈 칸이 기본값으로 되살아나 충돌하지 않는다', async () => {
  const overrides = validateOverrides({ 'sidebar.toggle': ['Control+1'] })
  const { onChange, submitted, status } = await recordAndSave({ overrides, action: 'tab.selectByIndex', variant: 1 })
  expect(status).not.toMatch(/충돌/)
  expect(submitted).toHaveLength(1)
  expect(onChange).toHaveBeenCalledTimes(1)
  const saved: Keybindings = onChange.mock.calls[0]![0]
  // 첫 칸은 여전히 빈 칸 — ⌃1 은 사이드바, ⌃G 는 2번째 탭, ⌃3 은 3번째 탭.
  expect(saved['tab.selectByIndex']?.[0]).toBeNull()
  expect(matchBinding('Control+1', saved)).toEqual({ id: 'sidebar.toggle', variant: 0 })
  expect(matchBinding('Control+G', saved)).toEqual({ id: 'tab.selectByIndex', variant: 1 })
  expect(matchBinding('Control+3', saved)).toEqual({ id: 'tab.selectByIndex', variant: 2 })
})

it('fix2 R2-01 대조 — 빈 칸 자체를 바꾸면 그 칸에 저장된다', async () => {
  const overrides = validateOverrides({ 'sidebar.toggle': ['Control+1'] })
  const { onChange } = await recordAndSave({ overrides, action: 'tab.selectByIndex', variant: 0 })
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(matchBinding('Control+G', onChange.mock.calls[0]![0])).toEqual({ id: 'tab.selectByIndex', variant: 0 })
})

it('기록 — 기록 중 키는 앱 단축키 경로(문서 캡처)로 가지 않고 후보로만 잡힌다 · 기록 IPC 를 켰다 끈다', async () => {
  const { view, recording } = mount({})
  const appListener = vi.fn()
  document.addEventListener('keydown', appListener, true)
  // 양성 대조 — 기록 전에는 같은 키가 문서 캡처까지 간다(이 관측점이 「안 간다」 를 볼 수 있다).
  press({ key: 't', code: 'KeyT', metaKey: true })
  expect(appListener).toHaveBeenCalledTimes(1)
  appListener.mockClear()
  await act(async () => view.querySelector<HTMLButtonElement>('[data-record="sidebar.toggle"][data-variant="0"]')!.click())
  expect(view.querySelector('[data-record="sidebar.toggle"]')?.textContent).toBe('키 입력… (Esc 취소)')
  press({ key: 't', code: 'KeyT', metaKey: true })
  document.removeEventListener('keydown', appListener, true)
  expect(appListener).not.toHaveBeenCalled()
  // ⌘T 는 「새 탭」 기본값 — 저장 전에 충돌로 보이고 저장 버튼이 막힌다.
  expect(view.querySelector('[data-record="sidebar.toggle"]')?.textContent).toBe('⌘T')
  expect(recording).toEqual([true, false])
})

it('저장 전 충돌 — 어느 액션과 겹치는지 보이고 그 상태로는 저장되지 않는다', async () => {
  const { view, submitted, onChange } = mount({})
  await record(view, 'sidebar.toggle', 0, { key: 'k', code: 'KeyK', metaKey: true })
  const pending = view.querySelector('[data-shortcut-pending]')!
  expect(pending.getAttribute('data-shortcut-pending')).toBe('conflict')
  expect(pending.textContent).toMatch(/커맨드 팔레트/)
  const save = view.querySelector<HTMLButtonElement>('[data-save-binding]')!
  expect(save.disabled).toBe(true)
  await act(async () => save.click())
  expect(submitted).toHaveLength(0)
  expect(onChange).not.toHaveBeenCalled()
  // 취소하면 후보가 사라진다.
  act(() => view.querySelector<HTMLButtonElement>('[data-cancel-binding]')!.click())
  expect(view.querySelector('[data-shortcut-pending]')).toBeNull()
  expect(view.querySelector('[data-record="sidebar.toggle"]')?.textContent).toBe('⌘B')
})

it('양보 기본값을 비키게 하는 조합 — 알리고 저장은 된다', async () => {
  const { view, onChange } = mount({})
  await record(view, 'sidebar.toggle', 0, { key: 'j', code: 'KeyJ', metaKey: true })
  expect(view.querySelector('[data-shortcut-pending]')?.getAttribute('data-shortcut-pending')).toBe('displaces')
  expect(view.querySelector('[data-shortcut-pending]')?.textContent).toMatch(/검색 \(팔레트\)/)
  await act(async () => view.querySelector<HTMLButtonElement>('[data-save-binding]')!.click())
  expect(onChange).toHaveBeenCalledWith({ 'sidebar.toggle': ['Mod+J'] })
})

it('기록 중 Esc = 기록 취소 — 후보 없음, 이벤트는 문서로 안 간다(설정 닫기 2단계와 섞이지 않는다)', async () => {
  const { view, recording } = mount({})
  const docListener = vi.fn()
  document.addEventListener('keydown', docListener)
  press({ key: 'Escape', code: 'Escape' })
  expect(docListener).toHaveBeenCalledTimes(1) // 양성 대조 — 기록 전 Esc 는 문서까지 간다
  docListener.mockClear()
  await record(view, 'sidebar.toggle', 0, { key: 'Escape', code: 'Escape' })
  document.removeEventListener('keydown', docListener)
  expect(docListener).not.toHaveBeenCalled()
  expect(view.querySelector('[data-shortcut-pending]')).toBeNull()
  expect(view.querySelector('[data-record="sidebar.toggle"]')?.textContent).toBe('⌘B')
  expect(recording).toEqual([true, false])
})

it('창 blur = 기록 취소', async () => {
  const { view, recording } = mount({})
  await act(async () => view.querySelector<HTMLButtonElement>('[data-record="sidebar.toggle"][data-variant="0"]')!.click())
  act(() => { window.dispatchEvent(new Event('blur')) })
  expect(view.querySelector('[data-record="sidebar.toggle"]')?.textContent).toBe('⌘B')
  expect(recording).toEqual([true, false])
  // 취소 뒤 키는 기록으로 가지 않는다.
  press({ key: 'g', code: 'KeyG', ctrlKey: true })
  expect(view.querySelector('[data-shortcut-pending]')).toBeNull()
})

it('기본값(Reset) — 재정의가 있을 때만 눌리고, 누르면 그 액션 재정의를 지워 저장한다', async () => {
  const { view, onChange } = mount(validateOverrides({ 'sidebar.toggle': ['Control+G'], 'palette.open': ['Mod+Shift+K'] }))
  expect(view.querySelector<HTMLButtonElement>('[data-reset="terminal.new"]')!.disabled).toBe(true)
  const reset = view.querySelector<HTMLButtonElement>('[data-reset="sidebar.toggle"]')!
  expect(reset.disabled).toBe(false)
  await act(async () => reset.click())
  expect(onChange).toHaveBeenCalledWith({ 'palette.open': ['Mod+Shift+K'] })
})

it('끄기(Disable) — 모든 칸을 「없음」 으로 저장한다', async () => {
  const { view, onChange } = mount({})
  await act(async () => view.querySelector<HTMLButtonElement>('[data-disable="terminal.zoom"]')!.click())
  expect(onChange).toHaveBeenCalledWith({ 'terminal.zoom': [null, null] })
})

it('저장이 main 에서 거절되면 그 문구를 status 에 보인다', async () => {
  const { view } = mount({})
  Reflect.set(window, 'corral', { setShortcutRecording: async () => {}, saveKeybindings: async () => ({ ok: false, error: '디스크 오류' }) })
  await record(view, 'sidebar.toggle', 0, { key: 'g', code: 'KeyG', ctrlKey: true })
  await act(async () => view.querySelector<HTMLButtonElement>('[data-save-binding]')!.click())
  expect(status(view)).toBe('디스크 오류')
})

it('필터 레일 — 카운트와 필터 · 섹션 안 검색 · 결과 없음', async () => {
  const { view } = mount(validateOverrides({ 'terminal.zoom': [null, null] }))
  const count = (id: string): string => view.querySelector(`[data-shortcuts-filter-count="${id}"]`)?.textContent ?? ''
  expect([count('all'), count('modified'), count('unassigned'), count('conflicts')]).toEqual(['22', '1', '1', '0'])
  act(() => view.querySelector<HTMLButtonElement>('[data-shortcuts-filter="unassigned"]')!.click())
  expect(view.querySelector('[data-shortcuts-filter="unassigned"]')?.getAttribute('aria-pressed')).toBe('true')
  expect([...view.querySelectorAll('[data-shortcut-action]')].map((row) => row.getAttribute('data-shortcut-action'))).toEqual(['terminal.zoom'])
  act(() => view.querySelector<HTMLButtonElement>('[data-shortcuts-filter="conflicts"]')!.click())
  expect(view.querySelector('[data-shortcuts-empty]')).not.toBeNull()
  act(() => view.querySelector<HTMLButtonElement>('[data-shortcuts-filter="all"]')!.click())
  const input = view.querySelector<HTMLInputElement>('[data-shortcuts-search]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setValue.call(input, '설정'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  expect([...view.querySelectorAll('[data-shortcut-action]')].map((row) => row.getAttribute('data-shortcut-action'))).toEqual(['settings.open'])
  expect(view.querySelector('[data-shortcuts-visible-count]')?.textContent).toBe('1/22')
})
