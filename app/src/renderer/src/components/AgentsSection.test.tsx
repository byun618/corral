// @vitest-environment happy-dom
// LIFE-515 K2 — 설정 › AI 기능 › 에이전트 「기본 Agent」 pill(Orca 198 `AgentDefaultSetting.tsx`). 쓰기는 가짜 preload `setSettings` 로 센다 —
// main 저장소의 unchanged·파일 쓰기는 `main/settings.test.ts` 「defaultAgent (LIFE-515 K1)」 가 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BindingLabels } from '../hooks/BindingLabels.js'
import type { Keybindings } from '../../../shared/keybindings.js'
import { DEFAULT_SETTINGS, readSettings, type DefaultAgent, type Settings, type SettingsWriteResult } from '../../../shared/terminal-settings.js'
import { resetSettingsStoreForTest } from '../settings-store.js'
import { AgentsSection } from './AgentsSection.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let stored: Settings
let pushes: Array<(next: unknown) => void>
const writes: Array<Partial<Settings>> = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  stored = { ...DEFAULT_SETTINGS }
  pushes = []
  writes.length = 0
  // 가짜 preload — main 과 같은 규칙: 바뀐 칸이 없으면 unchanged(쓰기 없음), 바뀌면 saved + 모든 창에 푸시.
  Reflect.set(window, 'corral', {
    getSettingsSync: () => stored,
    onSettings: (listener: (next: unknown) => void) => { pushes.push(listener); return () => {} },
    setSettings: async (patch: Partial<Settings>): Promise<SettingsWriteResult> => {
      const next = readSettings({ ...stored, ...patch })
      if (next.defaultAgent === stored.defaultAgent) return { status: 'unchanged', settings: stored }
      writes.push(patch)
      stored = next
      for (const push of pushes) push(stored)
      return { status: 'saved', settings: stored }
    },
  })
  resetSettingsStoreForTest(null)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
  resetSettingsStoreForTest(null)
})

const mount = (overrides: Keybindings = {}): void => {
  act(() => root.render(createElement(BindingLabels.Provider, { value: overrides }, createElement(AgentsSection))))
}
const pills = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[data-default-agent]')]
const pill = (value: DefaultAgent): HTMLButtonElement => {
  // 비 null 단언 대신 존재 확인으로 좁힌다(fix1 R1-03).
  const found = host.querySelector<HTMLButtonElement>(`[data-default-agent="${value}"]`)
  if (found === null) throw new Error(`pill ${value} 없음`)
  return found
}

it('「기본 Agent」 소제목 + pill 다섯 — 자동 · agent 없음(빈 terminal) · Claude · Codex · Grok(카탈로그 순서) (K2ⓑ)', () => {
  mount()
  expect(host.querySelector('[data-settings-subsection-header] h3')?.textContent).toBe('기본 Agent')
  expect(pills().map((button) => button.dataset.defaultAgent)).toEqual(['auto', 'blank', 'claude', 'codex', 'grok'])
  expect(pills().map((button) => button.textContent)).toEqual(['자동', 'agent 없음(빈 terminal)', 'Claude', 'Codex', 'Grok'])
  // D5 설명 — corral 에 있는 두 자리(⌘⌥T 와 + 메뉴)만 말한다. 명령 재정의·CLI 인수·원격은 없다.
  const description = host.querySelector('[data-settings-subsection-header] p')?.textContent ?? ''
  expect(description).toContain('⌘⌥T')
  expect(description).not.toMatch(/명령 재정의|CLI 인수|SSH|원격/)
})

it('기본값 자동 — 자동만 aria-pressed=true, Check 는 자동 앞 · 나머지는 Check 없음 (K2ⓑ, Orca 198 배치)', () => {
  mount()
  expect(pills().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false'])
  expect(pill('auto').classList.contains('is-active')).toBe(true)
  expect(pill('auto').firstElementChild?.querySelector('path[d="M20 6 9 17l-5-5"]')).not.toBeNull()
  expect(host.querySelectorAll('[data-default-agent] path[d="M20 6 9 17l-5-5"]')).toHaveLength(1)
  // agent 없음은 터미널 아이콘이 앞에 있다.
  expect(pill('blank').firstElementChild?.querySelector('path[d="m4 17 6-6-6-6"]')).not.toBeNull()
})

it('클릭 = 쓰기 1회 + 활성 이동, Check 는 agent 없음·에이전트 pill 의 뒤 · 이미 선택된 pill 클릭 = 쓰기 0 (K2ⓒ)', async () => {
  mount()
  await act(async () => pill('codex').click())
  expect(writes).toEqual([{ defaultAgent: 'codex' }])
  expect(pills().map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false'])
  expect(pill('codex').lastElementChild?.querySelector('path[d="M20 6 9 17l-5-5"]')).not.toBeNull()
  await act(async () => pill('codex').click())
  expect(writes).toHaveLength(1)
  await act(async () => pill('blank').click())
  expect(writes).toEqual([{ defaultAgent: 'codex' }, { defaultAgent: 'blank' }])
  expect(pill('blank').lastElementChild?.querySelector('path[d="M20 6 9 17l-5-5"]')).not.toBeNull()
  await act(async () => pill('auto').click())
  expect(stored.defaultAgent).toBe('auto')
  expect(writes).toHaveLength(3)
})

it('다른 창의 변경(main 푸시)이 오면 그 pill 이 활성 · 저장값으로 다시 열어도 같은 pill (K2ⓓ)', () => {
  stored = { ...DEFAULT_SETTINGS, defaultAgent: 'grok' }
  mount()
  expect(pill('grok').getAttribute('aria-pressed')).toBe('true')
  act(() => { for (const push of pushes) push({ ...stored, defaultAgent: 'claude' }) })
  expect(pill('claude').getAttribute('aria-pressed')).toBe('true')
  expect(pill('grok').getAttribute('aria-pressed')).toBe('false')
})

it('설명의 단축키는 레지스트리 라벨 — 재정의를 따르고 「없음」 이면 기호 없이 (K2ⓑ·D5)', () => {
  mount({ 'terminal.newAgent': ['Mod+Alt+Shift+T'] })
  expect(host.querySelector('[data-settings-subsection-header] p')?.textContent).toContain('⌘⌥⇧T')
  mount({ 'terminal.newAgent': [null] })
  expect(host.querySelector('[data-settings-subsection-header] p')?.textContent).not.toContain('⌘')
})

it('감지·활성 토글·명령·인자·env·상태 훅 칸은 없다 (K2ⓕ — S33·S34·S35 의도적)', () => {
  mount()
  expect(host.querySelectorAll('input, [role="switch"], select, textarea')).toHaveLength(0)
  expect(host.textContent).not.toMatch(/감지|새로고침|명령|인수|환경|훅|Yolo/)
})
