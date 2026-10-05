// @vitest-environment happy-dom
// LIFE-495 fix2 R2-01 — 비켜 선 빈 칸이 있는 다중 칸 액션(N번째 탭)의 **다른 칸**을 바꿔 저장한다. 실제 `ShortcutSettings` +
// 저장 경계에 실제 `validateOverrides`(main `keybindings.save` 와 같은 검증)를 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { matchBinding, validateOverrides, type Keybindings } from '../../../shared/keybindings.js'
import { ShortcutSettings } from './ShortcutSettings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function recordAndSave(input: { overrides: Keybindings; action: string; variant: number }): Promise<{ onChange: ReturnType<typeof vi.fn>; submitted: unknown[]; status: string }> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onChange = vi.fn()
  const submitted: unknown[] = []
  Reflect.set(window, 'corral', {
    setShortcutRecording: async () => {},
    saveKeybindings: async (next: unknown) => {
      submitted.push(next)
      try { return { ok: true, overrides: validateOverrides(next) } } catch (error) { return { ok: false, error: String(error instanceof Error ? error.message : error) } }
    },
  })
  act(() => root.render(createElement(ShortcutSettings, { overrides: input.overrides, onChange, onClose: () => {} })))
  const button = host.querySelector<HTMLButtonElement>(`[data-record="${input.action}"][data-variant="${input.variant}"]`)!
  await act(async () => button.click())
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true })) })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-save-binding]')!.click())
  return { onChange, submitted, status: host.querySelector('[role="status"]')?.textContent ?? '' }
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
