// 사용자 설정 저장소 (LIFE-512 K1ⓐⓒⓓⓕ) — 실제로 디스크에 쓰고 새 저장소로 다시 읽는다.
// 손으로 고친 파일이 다른 칸을 깨뜨리지 않는 것(칸별 격리), 바꾸기 전에는 파일을 만들지 않는 것(K9 원복이 「없음」 으로 돌아가게),
// ui-prefs 와 칸이 겹치지 않는 것(U8)을 같이 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_TERMINAL_THEME } from '../shared/terminal-settings.js'
import { SettingsStore } from './settings.js'
import { UiPrefsStore } from './ui-prefs.js'

let dir = ''
let file = ''
let saved: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l512-settings-'))
  file = path.join(dir, 'settings.json')
  saved = process.env.CORRAL_SETTINGS
  process.env.CORRAL_SETTINGS = file
})
afterEach(() => {
  if (saved === undefined) delete process.env.CORRAL_SETTINGS
  else process.env.CORRAL_SETTINGS = saved
  fs.rmSync(dir, { recursive: true, force: true })
})

const fresh = (): SettingsStore => {
  const store = new SettingsStore(dir)
  store.load()
  return store
}

describe('SettingsStore — 기본값·파일 생성 시점', () => {
  it('파일이 없으면 Orca 198 기본값이고 파일을 만들지 않는다', () => {
    const store = fresh()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.get()).toMatchObject({ terminalFontSize: 14, terminalFontFamily: 'SF Mono', terminalFontWeight: 500, terminalFontWeightBold: 700, terminalLineHeight: 1, terminalThemeDark: 'Ghostty Default Style Dark', terminalCursorStyle: 'block', terminalCursorBlink: true, terminalInactivePaneOpacity: 0.9, terminalDividerColorDark: '#3f3f46', terminalDividerThicknessPx: 3 })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('바뀌는 것이 없는 갱신은 쓰지 않는다 — 기본값과 같은 값을 보내도 파일이 생기지 않는다', () => {
    const store = fresh()
    const result = store.update({ terminalFontSize: 14, terminalThemeDark: DEFAULT_TERMINAL_THEME })
    expect(result.status).toBe('unchanged')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('CORRAL_SETTINGS 가 없으면 <userData>/settings.json', () => {
    delete process.env.CORRAL_SETTINGS
    expect(new SettingsStore(dir).file).toBe(path.join(dir, 'settings.json'))
  })
})

describe('SettingsStore — 영속·부분 갱신', () => {
  it('재기동해도 남는다 (새 저장소로 다시 읽는다)', () => {
    const store = fresh()
    store.update({ terminalThemeDark: 'Dracula', terminalFontSize: 16 })
    const again = fresh()
    expect(again.get()).toEqual({ ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula', terminalFontSize: 16 })
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.version).toBe(1)
    expect(onDisk.terminalThemeDark).toBe('Dracula')
  })

  it('부분 갱신은 준 칸만 덮는다', () => {
    const store = fresh()
    store.update({ terminalFontSize: 18 })
    store.update({ terminalCursorStyle: 'bar' })
    expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, terminalFontSize: 18, terminalCursorStyle: 'bar' })
  })

  it('연속 갱신(± 연타·숫자 입력)에도 파일이 깨지지 않고 마지막 값이 남는다 — 즉시 쓰기라 종료 비우기가 필요 없다', () => {
    const store = fresh()
    for (const size of [15, 16, 17, 18, 19, 1, 16]) store.update({ terminalFontSize: size })
    // 1 은 범위 밖 → 거부(r1 R1-02, 파일·IPC 경로는 고정하지 않는다)되고 16 이 마지막이다.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).terminalFontSize).toBe(16)
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(fresh().get().terminalFontSize).toBe(16)
  })

  it('잘못된 갱신 칸은 버리고 나머지는 적용한다', () => {
    const store = fresh()
    const result = store.update({ terminalFontSize: 'big', terminalThemeDark: 'Nope', terminalCursorStyle: 'beam', terminalDividerColorDark: 'red', unknownKey: 1, terminalLineHeight: 1.5 })
    expect(result.status).toBe('saved')
    expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, terminalLineHeight: 1.5 })
  })

  it('get() 은 복사본이다 — 받은 값을 고쳐도 저장소가 바뀌지 않는다', () => {
    const store = fresh()
    const got = store.get()
    got.terminalFontSize = 99
    got.terminalThemeDark = 'Dracula'
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('SettingsStore — 쓰기 실패(r1 R1-03)', () => {
  it('쓰기가 실패하면 메모리를 확정하지 않고 저장값을 돌려준다 — 같은 값 재시도가 파일을 쓴다', () => {
    const store = fresh()
    // 대상 경로를 디렉터리로 막아 rename 이 EISDIR/EPERM 으로 실패하게 한다.
    fs.mkdirSync(file)
    const failed = store.update({ terminalFontSize: 16 })
    expect(failed.status).toBe('failed')
    expect(failed.settings.terminalFontSize).toBe(14)
    expect(store.get().terminalFontSize).toBe(14)
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    fs.rmSync(file, { recursive: true })
    const retried = store.update({ terminalFontSize: 16 })
    expect(retried.status).toBe('saved')
    expect(retried.settings.terminalFontSize).toBe(16)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).terminalFontSize).toBe(16)
    expect(fresh().get().terminalFontSize).toBe(16)
  })
})

describe('SettingsStore — 글꼴군 200자 초과(r3 R3-01)', () => {
  it('201자는 그 칸만 거부 — unchanged · 메모리·파일 바이트 그대로 · 200자는 저장된다', () => {
    const store = fresh()
    expect(store.update({ terminalFontFamily: 'Menlo' }).status).toBe('saved')
    const before = fs.readFileSync(file, 'utf8')
    const rejected = store.update({ terminalFontFamily: 'X'.repeat(201) })
    expect(rejected.status).toBe('unchanged')
    expect(store.get().terminalFontFamily).toBe('Menlo')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(store.update({ terminalFontFamily: 'Y'.repeat(200) }).status).toBe('saved')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).terminalFontFamily).toBe('Y'.repeat(200))
  })
})

describe('SettingsStore — 정리까지 실패(r2 R2-01)', () => {
  it('부모 폴더 권한이 없어 쓰기·임시 파일 정리가 둘 다 실패해도 던지지 않고 failed — 권한을 돌리면 같은 값 재시도가 저장된다', () => {
    const locked = path.join(dir, 'locked')
    fs.mkdirSync(locked)
    process.env.CORRAL_SETTINGS = path.join(locked, 'settings.json')
    const store = new SettingsStore(dir)
    store.load()
    fs.chmodSync(locked, 0o000)
    try {
      const failed = store.update({ terminalFontSize: 18 })
      expect(failed.status).toBe('failed')
      expect(failed.settings.terminalFontSize).toBe(14)
      expect(store.get().terminalFontSize).toBe(14)
    } finally {
      fs.chmodSync(locked, 0o700)
    }
    const retried = store.update({ terminalFontSize: 18 })
    expect(retried.status).toBe('saved')
    expect(JSON.parse(fs.readFileSync(path.join(locked, 'settings.json'), 'utf8')).terminalFontSize).toBe(18)
    expect(fs.readdirSync(locked).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('SettingsStore — 손상 격리 (칸마다 따로 기본값)', () => {
  it('손상된 칸만 기본값이고 나머지는 산다', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, terminalFontSize: 'x', terminalThemeDark: 'Dracula', terminalCursorStyle: 42, terminalCursorBlink: false, terminalDividerColorDark: '#zzz', terminalDividerThicknessPx: 5 }))
    expect(fresh().get()).toEqual({ ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula', terminalCursorBlink: false, terminalDividerThicknessPx: 5 })
  })

  it('범위 밖 숫자는 그 칸만 기본값이다 — 범위 고정은 UI 입력에서만(r1 R1-02)', () => {
    fs.writeFileSync(file, JSON.stringify({ terminalFontSize: 30, terminalFontWeight: 50, terminalLineHeight: 9, terminalInactivePaneOpacity: -1, terminalDividerThicknessPx: 100, terminalFontWeightBold: 760 }))
    expect(fresh().get()).toEqual({ ...DEFAULT_SETTINGS, terminalFontWeightBold: 760 })
  })

  it('codex r1 R1-02 재현 입력 — 범위 밖 칸은 기본값, 유효한 칸은 산다', () => {
    fs.writeFileSync(file, JSON.stringify({ terminalFontSize: 99, terminalLineHeight: 0, terminalDividerThicknessPx: -1, terminalThemeDark: 'Dracula' }))
    expect(fresh().get()).toEqual({ ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula' })
  })

  it('없는 테마 이름은 기본 테마로', () => {
    fs.writeFileSync(file, JSON.stringify({ terminalThemeDark: 'Not A Theme' }))
    expect(fresh().get().terminalThemeDark).toBe(DEFAULT_TERMINAL_THEME)
  })

  it('JSON 이 깨졌거나 객체가 아니면 전부 기본값', () => {
    fs.writeFileSync(file, '{not json')
    expect(fresh().get()).toEqual(DEFAULT_SETTINGS)
    fs.writeFileSync(file, '[1,2]')
    expect(fresh().get()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('U8 — settings.json 과 ui-prefs.json 은 칸이 겹치지 않는다', () => {
  it('두 저장소 기본값의 키 교집합이 0 이다(버전 칸 제외)', () => {
    const prefsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l512-uiprefs-'))
    const savedPrefs = process.env.CORRAL_UI_PREFS
    process.env.CORRAL_UI_PREFS = path.join(prefsDir, 'ui-prefs.json')
    try {
      const prefs = new UiPrefsStore(prefsDir)
      prefs.load()
      const prefKeys = new Set(Object.keys(prefs.get()))
      const shared = Object.keys(fresh().get()).filter((key) => prefKeys.has(key))
      expect(shared).toEqual([])
      expect(prefKeys.size).toBeGreaterThan(5)
    } finally {
      if (savedPrefs === undefined) delete process.env.CORRAL_UI_PREFS
      else process.env.CORRAL_UI_PREFS = savedPrefs
      fs.rmSync(prefsDir, { recursive: true, force: true })
    }
  })
})

describe('terminalColorOverrides (LIFE-513 K7)', () => {
  it('기본값은 빈 override 이고, 파일이 없을 때 빈 override 를 보내도 파일을 만들지 않는다', () => {
    const store = fresh()
    expect(store.get().terminalColorOverrides).toEqual({})
    expect(store.update({ terminalColorOverrides: {} }).status).toBe('unchanged')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('저장·재기동 유지 · 값은 소문자 · 같은 내용(키 순서 달라도)이면 쓰지 않는다', () => {
    const store = fresh()
    expect(store.update({ terminalColorOverrides: { background: '#1A1B26', red: '#F00' } }).status).toBe('saved')
    expect(fresh().get().terminalColorOverrides).toEqual({ background: '#1a1b26', red: '#f00' })
    expect(store.update({ terminalColorOverrides: { red: '#f00', background: '#1a1b26' } }).status).toBe('unchanged')
  })

  it('패치는 통째로 바꾼다 — {} 가 비움이고, 비운 상태가 재기동 뒤 유지된다', () => {
    const store = fresh()
    store.update({ terminalColorOverrides: { background: '#101010' } })
    expect(store.update({ terminalColorOverrides: {} }).status).toBe('saved')
    expect(store.get().terminalColorOverrides).toEqual({})
    expect(fresh().get().terminalColorOverrides).toEqual({})
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).terminalColorOverrides).toEqual({})
  })

  it('테마 + 비움을 한 번의 쓰기로(F12 쓰기 모양)', () => {
    const store = fresh()
    store.update({ terminalColorOverrides: { background: '#101010' } })
    const result = store.update({ terminalThemeDark: 'Dracula', terminalColorOverrides: {} })
    expect(result.status).toBe('saved')
    expect(fresh().get()).toMatchObject({ terminalThemeDark: 'Dracula', terminalColorOverrides: {} })
  })

  it('손상 격리(파일) — 잘못된 키·값은 그 키만 버리고, 다른 칸과 다른 색은 산다', () => {
    fs.writeFileSync(file, JSON.stringify({ terminalFontSize: 16, terminalColorOverrides: { background: '#101010', bold: '#ffffff', red: 'red', extendedAnsi: ['#000000'], green: '#00ff00', __proto__: { x: 1 } } }))
    expect(fresh().get()).toEqual({ ...DEFAULT_SETTINGS, terminalFontSize: 16, terminalColorOverrides: { background: '#101010', green: '#00ff00' } })
  })

  it('손상 격리(파일) — 칸이 객체가 아니면 그 칸만 기본값(빈 override)', () => {
    fs.writeFileSync(file, JSON.stringify({ terminalThemeDark: 'Dracula', terminalColorOverrides: ['#000000'] }))
    expect(fresh().get()).toEqual({ ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula' })
  })

  it('손상 격리(IPC 패치) — 잘못된 색만 버리고, 전부 잘못이면 기존 override 를 지우지 않는다', () => {
    const store = fresh()
    store.update({ terminalColorOverrides: { background: '#101010' } })
    expect(store.update({ terminalColorOverrides: { nope: '#123456', red: 'crimson' } }).status).toBe('unchanged')
    expect(store.get().terminalColorOverrides).toEqual({ background: '#101010' })
    store.update({ terminalColorOverrides: { foreground: '#eeeeee', red: 'crimson' } })
    expect(store.get().terminalColorOverrides).toEqual({ foreground: '#eeeeee' })
    expect(store.update({ terminalColorOverrides: 'x' }).status).toBe('unchanged')
  })

  it('get() 의 override 는 복사본이다', () => {
    const store = fresh()
    store.update({ terminalColorOverrides: { background: '#101010' } })
    store.get().terminalColorOverrides.background = '#ffffff'
    expect(store.get().terminalColorOverrides).toEqual({ background: '#101010' })
  })
})
