import { describe, expect, it } from 'vitest'
import { ACTIONS, bindingConflict, bindingFromEvent, matchBinding, validateOverrides } from './keybindings.js'
describe('shortcut catalog and compatibility', () => {
  it('has nine actions with no default collisions', () => {
    expect(ACTIONS).toHaveLength(9)
    expect(bindingConflict({})).toBeNull()
    for (const action of ACTIONS) action.defaultBinding.forEach((binding, variant) => expect(matchBinding(binding, {})).toEqual({ id: action.id, variant }))
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
  it('stores only normalized overrides and removes the old binding', () => {
    expect(validateOverrides({ 'sidebar.toggle': ['Mod+b'] })).toEqual({})
    const overrides = validateOverrides({ 'sidebar.toggle': ['Shift+Mod+j'] })
    expect(overrides).toEqual({ 'sidebar.toggle': ['Mod+Shift+J'] })
    expect(matchBinding('Mod+B', overrides)).toBeNull()
    expect(matchBinding('Mod+Shift+J', overrides)?.id).toBe('sidebar.toggle')
  })
})
