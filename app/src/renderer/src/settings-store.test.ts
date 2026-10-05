// @vitest-environment happy-dom
// 렌더러 설정 저장소 (LIFE-512 K1ⓑ · 코디 답 Q3 조건 2) — 동기 읽기(`getSettingsSync`)는 부팅 때 **한 번**뿐이고, 이후 값은 푸시로만 바뀐다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type SettingsWriteResult } from '../../shared/terminal-settings.js'
import { getSettings, resetSettingsStoreForTest, updateSettings } from './settings-store.js'

let push: ((next: Settings) => void) | null = null
const getSettingsSync = vi.fn(() => ({ ...DEFAULT_SETTINGS, terminalFontSize: 16 }))
let failWrites = false
let rejectWrites = false
const setSettings = vi.fn(async (patch: Partial<Settings>): Promise<SettingsWriteResult> => {
  // 실패면 main 은 메모리를 확정하지 않고 저장값을 돌려주며 푸시하지 않는다(r1 R1-03).
  if (rejectWrites) throw new Error('EACCES: permission denied, lstat settings.json.tmp')
  if (failWrites) return { status: 'failed', settings: { ...DEFAULT_SETTINGS, terminalFontSize: 16 }, error: 'EISDIR' }
  const next = { ...DEFAULT_SETTINGS, terminalFontSize: 16, ...patch }
  push?.(next)
  return { status: 'saved', settings: next }
})
const onSettings = vi.fn((listener: (next: Settings) => void) => {
  push = listener
  return () => { push = null }
})

beforeEach(() => {
  resetSettingsStoreForTest()
  push = null
  failWrites = false
  rejectWrites = false
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

describe('settings-store — 쓰기 실패(r1 R1-03)', () => {
  it('실패면 false 를 돌려주고 값은 저장값 그대로다', async () => {
    getSettings()
    failWrites = true
    expect(await updateSettings({ terminalFontSize: 20 })).toBe(false)
    expect(getSettings().terminalFontSize).toBe(16)
    failWrites = false
    expect(await updateSettings({ terminalFontSize: 20 })).toBe(true)
    expect(getSettings().terminalFontSize).toBe(20)
  })
})

describe('settings-store — invoke 거절(r2 R2-01)', () => {
  it('setSettings 가 reject 해도 던지지 않고 false · 값은 그대로 · 같은 값 재시도가 저장된다', async () => {
    getSettings()
    rejectWrites = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await updateSettings({ terminalFontSize: 20 })).toBe(false)
    expect(getSettings().terminalFontSize).toBe(16)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    rejectWrites = false
    expect(await updateSettings({ terminalFontSize: 20 })).toBe(true)
    expect(getSettings().terminalFontSize).toBe(20)
  })
})
