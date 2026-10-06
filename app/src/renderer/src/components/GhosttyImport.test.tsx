// @vitest-environment happy-dom
// LIFE-513 — 「Ghostty에서 가져오기」 모달(K8ⓑ) · 적용 쓰기 1회·override 병합(K5ⓐ) · 쓰기 실패(K5ⓒ) · F12 테마 선택 쓰기(K6ⓐⓑ) ·
// 미리보기와 라이브 pane 이 같은 해석(테마 + override)을 쓴다(K5ⓑ 드리프트 금지). xterm 은 happy-dom 에서 못 그려 가짜로 바꾼다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GhosttyImportPreview } from '../../../shared/ghostty-import.js'
import type { Settings, SettingsWriteResult } from '../../../shared/terminal-settings.js'
import { DEFAULT_SIDEBAR_VIEW } from '../../../shared/sidebar-view.js'

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) { this.options = { ...options } }
    open(): void {}
    write(): void {}
    reset(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

const { DEFAULT_SETTINGS, copySettings, resolveTerminalTheme } = await import('../../../shared/terminal-settings.js')
const { getSettings, resetSettingsStoreForTest } = await import('../settings-store.js')
const { terminalAppearanceOptions, terminalCssVars } = await import('../terminal-appearance.js')
const { previewAppearanceOptions } = await import('./TerminalSettingsPreview.js')
const { TerminalAppearanceSection, themeSelectionPatch } = await import('./TerminalAppearanceSection.js')
const { GhosttyImportButton } = await import('./GhosttyImport.js')
const { SettingsPage } = await import('./SettingsPage.js')
const { ghosttyDiffRows, ghosttyImportPatch } = await import('../ghostty-import.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
const writes: Array<Partial<Settings>> = []
let previewResult: GhosttyImportPreview | null = { status: 'not-found' }
let failWrites = false

function installCorral(): void {
  const setSettings = vi.fn(async (patch: Partial<Settings>): Promise<SettingsWriteResult> => {
    writes.push(patch)
    const saved = getSettings()
    if (failWrites) return { status: 'failed', settings: saved, error: 'EACCES' }
    return { status: 'saved', settings: { ...saved, ...patch } }
  })
  Object.defineProperty(window, 'corral', { configurable: true, value: { setSettings, previewGhosttyImport: vi.fn(async () => previewResult) } })
}

beforeEach(() => {
  resetSettingsStoreForTest(copySettings(DEFAULT_SETTINGS))
  writes.length = 0
  previewResult = { status: 'not-found' }
  failWrites = false
  installCorral()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
})
function render(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(node))
  return host
}
const modal = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-ghostty-import-modal]')
async function click(element: Element | null): Promise<void> {
  if (element === null) throw new Error('클릭 대상 없음')
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const openModal = async (): Promise<void> => { await click(document.body.querySelector('[data-settings-ghostty-import]')) }

describe('버튼 위치 (K8ⓐ)', () => {
  it('「Terminal 타이포그래피」 소제목의 action 자리에 있다', () => {
    const view = render(createElement(TerminalAppearanceSection, { query: '' }))
    const header = [...view.querySelectorAll('[data-settings-subsection-header]')].find((node) => node.textContent?.includes('Terminal 타이포그래피'))
    expect(header?.querySelector('.settings-subsection-action [data-settings-ghostty-import]')?.textContent).toBe('Ghostty에서 가져오기')
  })
})

describe('모달 상태 (K8ⓑ)', () => {
  it('로딩 → 설정 없음 · 취소로 닫힌다', async () => {
    let resolve: (value: GhosttyImportPreview) => void = () => {}
    Reflect.set(window.corral, 'previewGhosttyImport', vi.fn(() => new Promise<GhosttyImportPreview>((done) => { resolve = done })))
    render(createElement(GhosttyImportButton))
    await openModal()
    expect(modal()?.dataset['ghosttyImportModal']).toBe('loading')
    expect(modal()?.textContent).toContain('미리보기 로드 중…')
    expect(modal()?.querySelector('.modal-title')?.textContent).toBe('Ghostty에서 가져오기')
    expect(modal()?.textContent).toContain('Ghostty 구성에서 가져올 설정을 확인하세요.')
    await act(async () => { resolve({ status: 'not-found' }) })
    expect(modal()?.dataset['ghosttyImportModal']).toBe('not-found')
    expect(modal()?.textContent).toContain('이 시스템에는 Ghostty 구성이 없습니다.')
    expect(modal()?.querySelector('[data-ghostty-import-apply]')).toBeNull()
    await click(modal()!.querySelector('[data-ghostty-import-cancel]'))
    expect(modal()).toBeNull()
  })

  it('오류 — 첫 오류 문구를 보인다', async () => {
    previewResult = { status: 'error', error: '구성을 읽을 수 없습니다 (/x/config): EACCES' }
    render(createElement(GhosttyImportButton))
    await openModal()
    expect(modal()?.querySelector('[data-ghostty-import-error]')?.textContent).toBe('구성을 읽을 수 없습니다 (/x/config): EACCES')
  })

  it('바뀔 값(한국어 라벨·색 견본) · 읽은 경로 전부 · 지원되지 않는 키(사유)', async () => {
    previewResult = {
      status: 'found',
      configPaths: ['/h/.config/ghostty/config', '/h/.config/ghostty/config.ghostty'],
      diff: { terminalFontFamily: 'Menlo', terminalCursorBlink: false, terminalColorOverrides: { background: '#101010', red: '#ff0000' } },
      unsupported: [{ key: 'font-size', reason: '정수만 받음' }, { key: 'theme', reason: '테마 파일을 찾을 수 없음: X' }],
    }
    render(createElement(GhosttyImportButton))
    await openModal()
    const m = modal()!
    expect(m.querySelector('[data-ghostty-import-paths]')?.textContent).toBe('구성: /h/.config/ghostty/config, /h/.config/ghostty/config.ghostty')
    expect(m.textContent).toContain('업데이트할 설정')
    expect(m.querySelector('[data-ghostty-import-row="terminalFontFamily"]')?.textContent).toBe('글꼴군Menlo')
    expect(m.querySelector('[data-ghostty-import-row="terminalCursorBlink"]')?.textContent).toBe('깜박이는 Cursor끔')
    const swatch = m.querySelector<HTMLElement>('[data-ghostty-import-color="background"] .ghostty-import-swatch')
    expect(swatch?.style.backgroundColor).toBeTruthy()
    expect(m.querySelector('[data-ghostty-import-color="red"]')?.textContent).toBe('red: #ff0000')
    expect(m.querySelector('[data-ghostty-import-unsupported]')?.textContent).toBe('font-size — 정수만 받음theme — 테마 파일을 찾을 수 없음: X')
    expect(m.textContent).toContain('지원되지 않는 키')
    expect(m.querySelector('[data-ghostty-import-apply]')?.textContent).toBe('변경 사항 적용')
  })

  it('새 설정 없음 — 적용 버튼 없음', async () => {
    previewResult = { status: 'found', configPaths: ['/h/.config/ghostty/config'], diff: {}, unsupported: [] }
    render(createElement(GhosttyImportButton))
    await openModal()
    expect(modal()?.querySelector('[data-ghostty-import-no-changes]')?.textContent).toBe('가져올 새 설정이 없습니다. 현재 설정이 이미 일치합니다.')
    expect(modal()?.querySelector('[data-ghostty-import-apply]')).toBeNull()
  })

  it('Esc 로 닫힌다(설정 화면으로 새지 않는다 — preventDefault)', async () => {
    render(createElement(GhosttyImportButton))
    await openModal()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { document.body.dispatchEvent(event) })
    expect(modal()).toBeNull()
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('적용 (K5ⓐⓒ)', () => {
  it('쓰기 1회 · override 는 현재 override 위에 병합 · 「가져오기 완료」 + 바뀐 값 목록 · 완료로 닫는다', async () => {
    resetSettingsStoreForTest({ ...copySettings(DEFAULT_SETTINGS), terminalColorOverrides: { foreground: '#eeeeee' } })
    previewResult = { status: 'found', configPaths: ['/c'], diff: { terminalFontFamily: 'Menlo', terminalColorOverrides: { background: '#101010' } }, unsupported: [{ key: 'keybind', reason: 'x' }] }
    render(createElement(GhosttyImportButton))
    await openModal()
    await click(modal()!.querySelector('[data-ghostty-import-apply]'))
    expect(writes).toEqual([{ terminalFontFamily: 'Menlo', terminalColorOverrides: { foreground: '#eeeeee', background: '#101010' } }])
    expect(modal()?.dataset['ghosttyImportModal']).toBe('applied')
    expect(modal()?.querySelector('[data-ghostty-import-done]')?.textContent).toBe('가져오기 완료')
    expect(modal()?.querySelector('[data-ghostty-import-row="terminalFontFamily"]')).not.toBeNull()
    // 완료 화면에는 경로·지원되지 않는 키를 다시 보이지 않는다(198 과 같다).
    expect(modal()?.querySelector('[data-ghostty-import-unsupported]')).toBeNull()
    expect(getSettings().terminalFontFamily).toBe('Menlo')
    await click(modal()!.querySelector('[data-ghostty-import-close]'))
    expect(modal()).toBeNull()
    expect(writes).toHaveLength(1)
  })

  it('쓰기 실패(failed) — 「완료」 가 아니라 오류, 다시 누르면 다시 쓴다', async () => {
    failWrites = true
    previewResult = { status: 'found', configPaths: ['/c'], diff: { terminalFontFamily: 'Menlo' }, unsupported: [] }
    render(createElement(GhosttyImportButton))
    await openModal()
    await click(modal()!.querySelector('[data-ghostty-import-apply]'))
    expect(modal()?.dataset['ghosttyImportModal']).toBe('found')
    expect(modal()?.querySelector('[data-ghostty-import-done]')).toBeNull()
    expect(modal()?.querySelector('[data-ghostty-import-apply-error]')?.textContent).toBe('설정을 저장하지 못했습니다. 다시 시도하세요.')
    failWrites = false
    await click(modal()!.querySelector('[data-ghostty-import-apply]'))
    expect(writes).toHaveLength(2)
    expect(modal()?.dataset['ghosttyImportModal']).toBe('applied')
  })

  it('ghosttyImportPatch — override 가 없으면 diff 그대로', () => {
    expect(ghosttyImportPatch({ diff: { terminalFontSize: 16 }, current: copySettings(DEFAULT_SETTINGS) })).toEqual({ terminalFontSize: 16 })
  })

  it('ghosttyDiffRows — 칸 이름은 설정 화면 한국어 라벨', () => {
    expect(ghosttyDiffRows({ terminalFontSize: 16, terminalLineHeight: 1.2, terminalCursorStyle: 'bar', terminalInactivePaneOpacity: 0.7, terminalDividerColorDark: '#445566' }).map((row) => row.label)).toEqual(['글꼴 크기', '라인 높이', 'Cursor 모양', '비활성 창 불투명도', '다크 디바이더 색상'])
  })
})

describe('F12 — 테마를 고르면 가져온 색을 지운다 (K6ⓐⓑ, Orca #22069)', () => {
  const withOverrides = (): Settings => ({ ...copySettings(DEFAULT_SETTINGS), terminalColorOverrides: { background: '#101010' } })

  it('themeSelectionPatch — override 가 있으면 같은 테마도 테마 + 비움, 없으면 같은 테마는 null', () => {
    expect(themeSelectionPatch({ name: DEFAULT_SETTINGS.terminalThemeDark, settings: withOverrides() })).toEqual({ terminalThemeDark: DEFAULT_SETTINGS.terminalThemeDark, terminalColorOverrides: {} })
    expect(themeSelectionPatch({ name: 'Dracula', settings: withOverrides() })).toEqual({ terminalThemeDark: 'Dracula', terminalColorOverrides: {} })
    expect(themeSelectionPatch({ name: DEFAULT_SETTINGS.terminalThemeDark, settings: copySettings(DEFAULT_SETTINGS) })).toBeNull()
    expect(themeSelectionPatch({ name: 'Dracula', settings: copySettings(DEFAULT_SETTINGS) })).toEqual({ terminalThemeDark: 'Dracula' })
  })

  it('화면 — override 가 있을 때 지금 선택된 테마를 누르면 쓰기 1회로 비우고, 다시 누르면 쓰지 않는다', async () => {
    resetSettingsStoreForTest(withOverrides())
    const view = render(createElement(TerminalAppearanceSection, { query: '' }))
    const current = (): Element | null => view.querySelector(`[data-settings-theme-option="${DEFAULT_SETTINGS.terminalThemeDark}"]`)
    await click(current())
    expect(writes).toEqual([{ terminalThemeDark: DEFAULT_SETTINGS.terminalThemeDark, terminalColorOverrides: {} }])
    expect(getSettings().terminalColorOverrides).toEqual({})
    await click(current())
    expect(writes).toHaveLength(1)
    await click(view.querySelector('[data-settings-theme-option="Dracula"]'))
    expect(writes[1]).toEqual({ terminalThemeDark: 'Dracula' })
  })
})

describe('해석 공유 — 라이브 pane·미리보기·CSS 변수가 테마 + override (K5ⓑ 드리프트 금지)', () => {
  it('override 가 테마 위에 덮이고 세 곳이 같은 값을 본다', () => {
    const settings: Settings = { ...copySettings(DEFAULT_SETTINGS), terminalThemeDark: 'Dracula', terminalColorOverrides: { background: '#101010', red: '#ff0000' } }
    const expected = resolveTerminalTheme({ themeName: 'Dracula', overrides: { background: '#101010', red: '#ff0000' } })
    expect(expected.background).toBe('#101010')
    expect(expected.red).toBe('#ff0000')
    expect(expected.foreground).toBe(resolveTerminalTheme({ themeName: 'Dracula' }).foreground)
    expect(terminalAppearanceOptions(settings).theme).toEqual(expected)
    expect(previewAppearanceOptions(settings).theme).toEqual(expected)
    expect(terminalCssVars(settings)['--term-bg']).toBe('#101010')
  })

  it('비우면 고른 테마 값 그대로', () => {
    const settings: Settings = { ...copySettings(DEFAULT_SETTINGS), terminalThemeDark: 'Dracula' }
    expect(terminalAppearanceOptions(settings).theme).toEqual(resolveTerminalTheme({ themeName: 'Dracula' }))
  })
})

describe('모달 세대 — 닫았다 다시 연 모달에는 그 세대 응답만 (fix1 R1-03)', () => {
  const resultA: GhosttyImportPreview = { status: 'found', configPaths: ['/tmp/A'], diff: { terminalFontFamily: 'OldA' }, unsupported: [] }
  const resultB: GhosttyImportPreview = { status: 'found', configPaths: ['/tmp/B'], diff: { terminalFontFamily: 'NewB' }, unsupported: [] }
  const pending: Array<(value: GhosttyImportPreview) => void> = []
  const deferPreviews = (): void => {
    pending.length = 0
    Reflect.set(window.corral, 'previewGhosttyImport', vi.fn(() => new Promise<GhosttyImportPreview>((done) => { pending.push(done) })))
  }
  const closeAndReopen = async (): Promise<void> => {
    await click(modal()!.querySelector('[data-ghostty-import-cancel]'))
    await openModal()
  }

  it('이전 응답 A 가 먼저 와도 버리고, 새 응답 B 를 보인다', async () => {
    deferPreviews()
    render(createElement(GhosttyImportButton))
    await openModal()
    await closeAndReopen()
    await act(async () => { pending[0]!(resultA) })
    expect(modal()?.dataset['ghosttyImportModal']).toBe('loading')
    await act(async () => { pending[1]!(resultB) })
    expect(modal()?.querySelector('[data-ghostty-import-paths]')?.textContent).toBe('구성: /tmp/B')
  })

  it('새 응답 B 가 먼저 오고 이전 응답 A 가 늦게 와도 B 가 남는다', async () => {
    deferPreviews()
    render(createElement(GhosttyImportButton))
    await openModal()
    await closeAndReopen()
    await act(async () => { pending[1]!(resultB) })
    await act(async () => { pending[0]!(resultA) })
    expect(modal()?.querySelector('[data-ghostty-import-paths]')?.textContent).toBe('구성: /tmp/B')
    expect(modal()?.textContent).not.toContain('OldA')
  })

  it('적용 응답도 그 세대만 — 적용 중 닫고 다시 열면 새 모달은 「완료」 가 되지 않는다', async () => {
    previewResult = resultB
    let finish: (value: SettingsWriteResult) => void = () => {}
    Reflect.set(window.corral, 'setSettings', vi.fn((patch: Partial<Settings>) => { writes.push(patch); return new Promise<SettingsWriteResult>((done) => { finish = done }) }))
    render(createElement(GhosttyImportButton))
    await openModal()
    await click(modal()!.querySelector('[data-ghostty-import-apply]'))
    await closeAndReopen()
    expect(modal()?.dataset['ghosttyImportModal']).toBe('found')
    await act(async () => { finish({ status: 'saved', settings: { ...getSettings(), terminalFontFamily: 'NewB' } }) })
    expect(modal()?.dataset['ghosttyImportModal']).toBe('found')
    expect(modal()?.querySelector('[data-ghostty-import-done]')).toBeNull()
    expect(writes).toHaveLength(1)
  })
})

describe('모달 키보드·포커스 격리 — 설정 화면과 함께 (fix1 R1-04)', () => {
  const found: GhosttyImportPreview = { status: 'found', configPaths: ['/h/.config/ghostty/config'], diff: { terminalFontFamily: 'Menlo' }, unsupported: [] }
  const renderPage = (): void => {
    render(createElement(SettingsPage, { section: 'appearance', onSelectSection: () => {}, onClose: () => {}, overrides: {}, onChangeOverrides: () => {}, sidebarView: DEFAULT_SIDEBAR_VIEW, onChangeSidebarView: () => {} }))
  }
  const insideModal = (): boolean => modal()?.contains(document.activeElement) ?? false
  const key = async (init: KeyboardEventInit): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    const target = document.activeElement ?? document.body
    await act(async () => { target.dispatchEvent(event) })
    return event
  }

  it('⌘F 는 설정 검색으로 포커스를 빼 가지 않는다 — 모달이 남고 포커스도 모달 안', async () => {
    previewResult = found
    renderPage()
    await openModal()
    expect(insideModal()).toBe(true)
    await key({ key: 'f', code: 'KeyF', metaKey: true })
    expect(modal()).not.toBeNull()
    expect(insideModal()).toBe(true)
    expect(document.activeElement?.hasAttribute('data-settings-search')).toBe(false)
  })

  it('Tab·Shift+Tab 은 모달 안을 돈다', async () => {
    previewResult = found
    renderPage()
    await openModal()
    const cancel = modal()!.querySelector<HTMLElement>('[data-ghostty-import-cancel]')
    const apply = modal()!.querySelector<HTMLElement>('[data-ghostty-import-apply]')
    expect(document.activeElement).toBe(apply)
    await key({ key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    await key({ key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(apply)
    await key({ key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)
  })

  it.each<[string, () => void]>([
    ['로딩', () => { Reflect.set(window.corral, 'previewGhosttyImport', vi.fn(() => new Promise<GhosttyImportPreview>(() => {}))) }],
    ['설정 없음', () => { previewResult = { status: 'not-found' } }],
    ['오류', () => { previewResult = { status: 'error', error: 'EACCES' } }],
    ['새 설정 없음', () => { previewResult = { status: 'found', configPaths: ['/c'], diff: {}, unsupported: [] } }],
  ])('%s 상태에서도 초기 포커스가 모달 안', async (_name, arrange) => {
    arrange()
    renderPage()
    await openModal()
    expect(insideModal()).toBe(true)
  })

  it('닫으면(취소·Esc·완료) 포커스가 「Ghostty에서 가져오기」 버튼으로 돌아온다', async () => {
    previewResult = found
    renderPage()
    const trigger = document.body.querySelector('[data-settings-ghostty-import]')
    await openModal()
    await click(modal()!.querySelector('[data-ghostty-import-cancel]'))
    expect(document.activeElement).toBe(trigger)
    await openModal()
    await key({ key: 'Escape' })
    expect(modal()).toBeNull()
    expect(document.activeElement).toBe(trigger)
    await openModal()
    await click(modal()!.querySelector('[data-ghostty-import-apply]'))
    expect(insideModal()).toBe(true)
    await click(modal()!.querySelector('[data-ghostty-import-close]'))
    expect(document.activeElement).toBe(trigger)
  })
})
