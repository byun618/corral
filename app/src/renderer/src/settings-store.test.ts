// @vitest-environment happy-dom
// 렌더러 설정 저장소 (LIFE-512 K1ⓑ · 코디 답 Q3 조건 2) — 동기 읽기(`getSettingsSync`)는 부팅 때 **한 번**뿐이고, 이후 값은 푸시로만 바뀐다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/terminal-settings.js'
import { getSettings, resetSettingsStoreForTest, updateSettings } from './settings-store.js'

let push: ((next: Settings) => void) | null = null
const getSettingsSync = vi.fn(() => ({ ...DEFAULT_SETTINGS, terminalFontSize: 16 }))
const setSettings = vi.fn(async (patch: Partial<Settings>) => {
  const next = { ...DEFAULT_SETTINGS, terminalFontSize: 16, ...patch }
  push?.(next)
  return next
})
const onSettings = vi.fn((listener: (next: Settings) => void) => {
  push = listener
  return () => { push = null }
})

beforeEach(() => {
  resetSettingsStoreForTest()
  push = null
  getSettingsSync.mockClear()
  setSettings.mockClear()
  onSettings.mockClear()
  Object.defineProperty(window, 'corral', { configurable: true, value: { getSettingsSync, setSettings, onSettings } })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'corral')
  resetSettingsStoreForTest()
})

describe('settings-store — 동기 읽기는 부팅 1회', () => {
  it('여러 번 읽어도 getSettingsSync 는 한 번, 구독도 한 번', () => {
    expect(getSettings().terminalFontSize).toBe(16)
    getSettings()
    getSettings()
    expect(getSettingsSync).toHaveBeenCalledTimes(1)
    expect(onSettings).toHaveBeenCalledTimes(1)
  })

  it('이후 값은 푸시로만 바뀐다 — 쓰기·푸시 뒤에도 동기 읽기를 다시 하지 않는다', async () => {
    getSettings()
    push?.({ ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula' })
    expect(getSettings().terminalThemeDark).toBe('Dracula')
    await updateSettings({ terminalFontSize: 18 })
    expect(getSettings().terminalFontSize).toBe(18)
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(getSettingsSync).toHaveBeenCalledTimes(1)
  })
})
