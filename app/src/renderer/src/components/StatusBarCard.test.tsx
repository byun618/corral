// @vitest-environment happy-dom
// LIFE-636 E9 — 설정 › 외관 「상태바」 카드: 스위치 3개(기본 켬)·「로그인 정보 없음」·끄기/켜기 = settings.json 패치,
// 설정 칸 읽기(구 settings.json → 기본값, ⓔ)·검색(ⓓ).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, readSettings, sanitizeSettingsPatch, type Settings, type SettingsWriteResult } from '../../../shared/terminal-settings.js'
import { USAGE_SETTING_ROWS, usageEnabled, type UsageSnapshot } from '../../../shared/usage.js'
import { settingsNavGroups } from '../settings-registry.js'
import { resetSettingsStoreForTest } from '../settings-store.js'
import { resetUsageStoreForTest } from '../usage-store.js'
import { StatusBarCard } from './StatusBarCard.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

describe('설정 칸(E9ⓑⓔ)', () => {
  it('구 settings.json(새 칸 없음) → 셋 다 기본 켬, 다른 칸은 그대로', () => {
    const read = readSettings({ version: 1, terminalFontSize: 16, mobileEnabled: true })
    expect([read.statusBarUsageClaude, read.statusBarUsageCodex, read.statusBarUsageGrok]).toEqual([true, true, true])
    expect(read.terminalFontSize).toBe(16)
    expect(read.mobileEnabled).toBe(true)
  })
  it('저장된 false 를 읽는다 · 잘못된 값은 그 칸만 기본값', () => {
    const read = readSettings({ statusBarUsageCodex: false, statusBarUsageGrok: 'no' })
    expect([read.statusBarUsageClaude, read.statusBarUsageCodex, read.statusBarUsageGrok]).toEqual([true, false, true])
  })
  it('패치 검증 — boolean 만 받는다', () => {
    expect(sanitizeSettingsPatch({ statusBarUsageCodex: false, statusBarUsageGrok: 1 })).toEqual({ accepted: { statusBarUsageCodex: false }, rejected: ['statusBarUsageGrok'] })
  })
  it('usageEnabled — 표의 칸을 본다, 표에 없는 id 는 꺼짐(조회 안 함)', () => {
    const settings = { ...DEFAULT_SETTINGS, statusBarUsageCodex: false }
    expect(USAGE_SETTING_ROWS.map((row) => usageEnabled({ settings, id: row.id }))).toEqual([true, false, true])
    expect(usageEnabled({ settings, id: 'gemini' })).toBe(false)
  })
})

describe('설정 검색(E9ⓓ)', () => {
  for (const query of ['상태바', '사용량', 'usage', 'Usage', 'claude', 'codex', 'grok', 'status bar']) {
    it(`「${query}」 → 외관 섹션`, () => {
      const sections = settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))
      expect(sections).toContain('appearance')
    })
  }
})

describe('「상태바」 카드(E9ⓐⓒ)', () => {
  let host: HTMLDivElement
  let root: Root
  let patches: Partial<Settings>[] = []
  let stored: Settings = { ...DEFAULT_SETTINGS }

  function install(snapshot: UsageSnapshot): void {
    patches = []
    stored = { ...DEFAULT_SETTINGS }
    resetSettingsStoreForTest()
    resetUsageStoreForTest()
    Reflect.set(window, 'corral', {
      getSettingsSync: () => stored,
      onSettings: () => () => {},
      setSettings: async (patch: Partial<Settings>): Promise<SettingsWriteResult> => {
        patches.push(patch)
        stored = readSettings({ ...stored, ...patch })
        return { status: 'saved', settings: stored }
      },
      getUsage: async () => snapshot,
      onUsage: () => () => {},
    })
  }
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    Reflect.deleteProperty(window, 'corral')
    resetSettingsStoreForTest()
    resetUsageStoreForTest()
  })

  it('스위치 3개 기본 켬 · 자격 없는 provider 옆 「로그인 정보 없음」 · 끄기 = 그 칸 false 패치', async () => {
    install({ providers: [
      { id: 'claude', name: 'Claude', usage: { status: 'loading' }, refreshing: true },
      { id: 'codex', name: 'Codex', usage: { status: 'unavailable', reason: 'Codex 로그인 정보 없음' }, refreshing: false },
      { id: 'grok', name: 'Grok', usage: { status: 'error', error: { kind: 'expired', message: 'x' }, checkedAt: 0 }, refreshing: false },
    ] })
    await act(async () => { root.render(createElement(StatusBarCard, { query: '' })) })
    const switches = [...host.querySelectorAll<HTMLButtonElement>('[data-statusbar-usage-setting] [role="switch"]')]
    expect(switches.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true'])
    const notes = [...host.querySelectorAll<HTMLElement>('[data-statusbar-usage-signed-out]')].map((el) => el.closest<HTMLElement>('[data-statusbar-usage-setting]')!.dataset.statusbarUsageSetting)
    expect(notes).toEqual(['codex'])
    expect(host.textContent).toContain('로그인 정보 없음')
    await act(async () => { switches[1]!.click() })
    expect(patches).toEqual([{ statusBarUsageCodex: false }])
    expect(host.querySelectorAll<HTMLButtonElement>('[data-statusbar-usage-setting] [role="switch"]')[1]!.getAttribute('aria-checked')).toBe('false')
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('[data-statusbar-usage-setting] [role="switch"]')[1]!.click() })
    expect(patches).toEqual([{ statusBarUsageCodex: false }, { statusBarUsageCodex: true }])
  })
})
