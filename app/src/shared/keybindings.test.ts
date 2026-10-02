import { describe, expect, it } from 'vitest'
import { ACTIONS, bindingConflict, bindingFromEvent, bindingsFor, matchBinding, normalizeBinding, validateOverrides } from './keybindings.js'
describe('shortcut catalog and compatibility', () => {
  it('keeps the nine actions, the palette and the LIFE-470 search chord without collisions', () => {
    // LIFE-478: + workspace.rename(⌘⌥R) · workspace.delete(⌘⇧⌫)
    expect(ACTIONS).toHaveLength(13)
    expect(matchBinding('Mod+K', {})).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+J', { 'palette.open': ['Mod+J'] })).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+K', { 'palette.open': ['Mod+J'] })).toBeNull()
    expect(bindingConflict({})).toBeNull()
    for (const action of ACTIONS) action.defaultBinding.forEach((binding, index) => expect(matchBinding(binding, {})).toEqual({ id: action.id, variant: action.bindingVariants[index] }))
  })
  it('preserves Shift variants and leaves Ctrl+D/T/W to the terminal', () => {
    expect(matchBinding('Control+D', {})).toBeNull()
    expect(matchBinding('Control+T', {})).toBeNull()
    expect(matchBinding('Mod+Shift+T', {})).toEqual({ id: 'terminal.new', variant: 0 })
    expect(matchBinding('Mod+Alt+Shift+ArrowLeft', {})).toEqual({ id: 'terminal.focus', variant: 0 })
    expect(matchBinding('Control+W', {})).toBeNull()
    expect(matchBinding('Alt+W', {})).toBeNull() // existing handler requires Mod
  })
  it('maps physical letter keys, ignores standalone modifiers and composition', () => {
    const event = { key: '∂', code: 'KeyD', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true }
    expect(bindingFromEvent(event)).toBe('Mod+Alt+D')
    expect(bindingFromEvent({ ...event, isComposing: true })).toBeNull()
    expect(bindingFromEvent({ ...event, key: 'Shift', code: 'ShiftLeft' })).toBeNull()
  })
  it('rejects collisions and duplicate variants', () => {
    expect(() => validateOverrides({ 'sidebar.toggle': ['Mod+D'] })).toThrow(/pane 분할/)
    expect(() => validateOverrides({ 'terminal.split': ['Mod+J', 'Mod+J'] })).toThrow(/충돌/)
    expect(() => validateOverrides({ 'terminal.focus': ['Mod+J'] })).toThrow()
  })
  it.each(['D', 'Tab', 'Enter', 'Space', 'F1'])('rejects unmodified %s at every shared entry point', (key) => {
    expect(normalizeBinding(key)).toBeNull()
    expect(bindingFromEvent({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull()
    expect(() => validateOverrides({ 'sidebar.toggle': [key] })).toThrow()
  })
  it('uses identical explicit aliases for matching and conflicts regardless of customization', () => {
    const explicit = { 'terminal.new': ['Mod+J', 'Mod+Shift+T'] }
    expect(matchBinding('Mod+Shift+T', explicit)).toEqual({ id: 'terminal.new', variant: 0 })
    expect(() => validateOverrides({ ...explicit, 'sidebar.toggle': ['Mod+Shift+T'] })).toThrow(/충돌/)
    const moved = validateOverrides({ 'terminal.new': ['Mod+J', 'Mod+Shift+J'], 'sidebar.toggle': ['Mod+Shift+T'] })
    expect(matchBinding('Mod+Shift+T', moved)?.id).toBe('sidebar.toggle')
    expect(matchBinding('Mod+Shift+J', moved)).toEqual({ id: 'terminal.new', variant: 0 })
    expect(matchBinding('Mod+Alt+Shift+ArrowDown', {})).toEqual({ id: 'terminal.focus', variant: 3 })
  })
  it('stores only normalized overrides and removes the old binding', () => {
    expect(validateOverrides({ 'sidebar.toggle': ['Mod+b'] })).toEqual({})
    const overrides = validateOverrides({ 'sidebar.toggle': ['Shift+Mod+j'] })
    expect(overrides).toEqual({ 'sidebar.toggle': ['Mod+Shift+J'] })
    expect(matchBinding('Mod+B', overrides)).toBeNull()
    expect(matchBinding('Mod+Shift+J', overrides)?.id).toBe('sidebar.toggle')
  })
})
describe('LIFE-470 K1 — ⌘J search chord', () => {
  it('opens through its own action by default and leaves ⌘K on the palette', () => {
    expect(matchBinding('Mod+J', {})).toEqual({ id: 'palette.search', variant: 0 })
    expect(matchBinding('Mod+K', {})).toEqual({ id: 'palette.open', variant: 0 })
  })
  it('yields to an existing override that already uses ⌘J — the user file is not discarded', () => {
    // 469 출고 시점 사용자가 ⌘J 를 다른 액션에 걸어 둔 파일 모양.
    const legacy = { 'sidebar.toggle': ['Mod+J'] }
    expect(validateOverrides(legacy, true)).toEqual({ 'sidebar.toggle': ['Mod+J'] })
    expect(validateOverrides(legacy)).toEqual({ 'sidebar.toggle': ['Mod+J'] })
    expect(matchBinding('Mod+J', legacy)?.id).toBe('sidebar.toggle')
    expect(bindingsFor('palette.search', legacy)).toEqual([])
    expect(bindingConflict(legacy)).toBeNull()
  })
  it('can be reassigned and reset to the default', () => {
    const moved = validateOverrides({ 'palette.search': ['Mod+Shift+J'] })
    expect(matchBinding('Mod+Shift+J', moved)).toEqual({ id: 'palette.search', variant: 0 })
    expect(matchBinding('Mod+J', moved)).toBeNull()
    const { 'palette.search': _dropped, ...reset } = moved
    expect(_dropped).toEqual(['Mod+Shift+J'])
    expect(matchBinding('Mod+J', reset)).toEqual({ id: 'palette.search', variant: 0 })
  })
  it('explicitly re-saving the yielded default against a claiming override is a conflict, not a silent no-op', () => {
    expect(() => validateOverrides({ 'sidebar.toggle': ['Mod+J'], 'palette.search': ['Mod+J'] })).toThrow(/충돌/)
    // 읽기(손상 허용)에서는 카탈로그 뒤쪽(나중 액션)을 버린다 — 기존 재정의가 남는다.
    expect(validateOverrides({ 'sidebar.toggle': ['Mod+J'], 'palette.search': ['Mod+J'] }, true)).toEqual({ 'sidebar.toggle': ['Mod+J'] })
  })
  it('a user who rebinds the palette to ⌘J keeps it; the search chord steps aside', () => {
    const overrides = validateOverrides({ 'palette.open': ['Mod+J'] })
    expect(matchBinding('Mod+J', overrides)?.id).toBe('palette.open')
    expect(bindingsFor('palette.search', overrides)).toEqual([])
  })
  it('LIFE-478 ⌘⌥R(macOS Option 글리프 ®) → workspace.rename · ⌘⇧⌫ → workspace.delete, 설정 화면 재지정 가능', () => {
    const optionR = { key: '®', code: 'KeyR', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true }
    expect(matchBinding(bindingFromEvent(optionR)!, {})).toEqual({ id: 'workspace.rename', variant: 0 })
    const del = { key: 'Backspace', code: 'Backspace', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }
    expect(matchBinding(bindingFromEvent(del)!, {})).toEqual({ id: 'workspace.delete', variant: 0 })
    expect(validateOverrides({ 'workspace.rename': ['Mod+Alt+N'] })).toEqual({ 'workspace.rename': ['Mod+Alt+N'] })
    expect(matchBinding('Mod+Alt+N', { 'workspace.rename': ['Mod+Alt+N'] })).toEqual({ id: 'workspace.rename', variant: 0 })
  })
  it('LIFE-478 새 기본값은 비켜 선다 — 사용자가 ⌘⌥R 을 다른 액션에 재정의해 두었으면 그 재정의가 이긴다', () => {
    const overrides = validateOverrides({ 'palette.open': ['Mod+Alt+R'] }, true)
    expect(overrides).toEqual({ 'palette.open': ['Mod+Alt+R'] })
    expect(bindingsFor('workspace.rename', overrides)).toEqual([])
    expect(matchBinding('Mod+Alt+R', overrides)).toEqual({ id: 'palette.open', variant: 0 })
  })
})
