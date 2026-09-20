import { describe, expect, it } from 'vitest'
import { ACTIONS, bindingConflict, bindingFromEvent, matchBinding, normalizeBinding, validateOverrides } from './keybindings.js'
describe('shortcut catalog and compatibility', () => {
  it('keeps the nine actions and adds a rebindable palette without collisions', () => {
    expect(ACTIONS).toHaveLength(10)
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
