import { describe, expect, it } from 'vitest'
import { ACTIONS, bindingConflict, bindingFromEvent, bindingsFor, matchBinding, menuKeyShortcut, migrateLegacyOverrides, normalizeBinding, validateOverrides } from './keybindings.js'
describe('shortcut catalog and compatibility', () => {
  it('keeps the nine actions, the palette and the LIFE-470 search chord without collisions', () => {
    // LIFE-478: + workspace.rename(⌘⌥R) · workspace.delete(⌘⇧⌫)
    // LIFE-495: + tab.reopenClosed(⌘⇧T) · tab.rename(⌘R) · tab.cycle(⌘⇧[ ] · ⌘⌥[ ] · ⌃PgUp/Dn) · tab.selectByIndex(⌃1–9)
    expect(ACTIONS).toHaveLength(17)
    expect(matchBinding('Mod+K', {})).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+J', { 'palette.open': ['Mod+J'] })).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+K', { 'palette.open': ['Mod+J'] })).toBeNull()
    expect(bindingConflict({})).toBeNull()
    for (const action of ACTIONS) action.defaultBinding.forEach((binding, index) => expect(matchBinding(binding, {})).toEqual({ id: action.id, variant: action.bindingVariants[index] }))
  })
  it('preserves Shift variants and leaves Ctrl+D/T/W to the terminal', () => {
    expect(matchBinding('Control+D', {})).toBeNull()
    expect(matchBinding('Control+T', {})).toBeNull()
    // LIFE-495 P1 — ⌘⇧T 는 「닫은 탭 다시 열기」다(⌘T 는 새 탭 그대로).
    expect(matchBinding('Mod+Shift+T', {})).toEqual({ id: 'tab.reopenClosed', variant: 0 })
    expect(matchBinding('Mod+T', {})).toEqual({ id: 'terminal.new', variant: 0 })
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
    // LIFE-495 — terminal.new 는 한 칸이 됐다. 별칭 규칙은 두 칸 액션(terminal.split)으로 본다.
    const explicit = { 'terminal.split': ['Mod+J', 'Mod+Shift+D'] }
    expect(matchBinding('Mod+Shift+D', explicit)).toEqual({ id: 'terminal.split', variant: 1 })
    expect(() => validateOverrides({ ...explicit, 'sidebar.toggle': ['Mod+Shift+D'] })).toThrow(/충돌/)
    const moved = validateOverrides({ 'terminal.split': ['Mod+J', 'Mod+Shift+J'], 'sidebar.toggle': ['Mod+Shift+D'] })
    expect(matchBinding('Mod+Shift+D', moved)?.id).toBe('sidebar.toggle')
    expect(matchBinding('Mod+Shift+J', moved)).toEqual({ id: 'terminal.split', variant: 1 })
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
    expect(bindingsFor('palette.search', legacy)).toEqual([null])
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
    expect(bindingsFor('palette.search', overrides)).toEqual([null])
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
    expect(bindingsFor('workspace.rename', overrides)).toEqual([null])
    expect(matchBinding('Mod+Alt+R', overrides)).toEqual({ id: 'palette.open', variant: 0 })
  })
})

describe('LIFE-495 K7 — 탭 단축키', () => {
  const key = (input: { key: string; code: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) => ({
    key: input.key, code: input.code, metaKey: input.meta ?? false, ctrlKey: input.ctrl ?? false, altKey: input.alt ?? false, shiftKey: input.shift ?? false,
  })
  it('⌘⇧[ ] — key 가 `{` `}` 로 와도 물리 위치(BracketLeft/Right)로 읽는다', () => {
    expect(bindingFromEvent(key({ key: '}', code: 'BracketRight', meta: true, shift: true }))).toBe('Mod+Shift+]')
    expect(matchBinding('Mod+Shift+]', {})).toEqual({ id: 'tab.cycle', variant: 0 })
    expect(matchBinding(bindingFromEvent(key({ key: '{', code: 'BracketLeft', meta: true, shift: true }))!, {})).toEqual({ id: 'tab.cycle', variant: 1 })
  })
  it('⌘⌥[ ] — macOS Option 글리프(“ ‘)로 와도 같다', () => {
    expect(matchBinding(bindingFromEvent(key({ key: '‘', code: 'BracketRight', meta: true, alt: true }))!, {})).toEqual({ id: 'tab.cycle', variant: 0 })
    expect(matchBinding(bindingFromEvent(key({ key: '“', code: 'BracketLeft', meta: true, alt: true }))!, {})).toEqual({ id: 'tab.cycle', variant: 1 })
  })
  it('한글 입력기 — key 가 무엇이든 code 로 읽는다(⌘R·⌘⇧T·⌘⇧[)', () => {
    expect(matchBinding(bindingFromEvent(key({ key: 'ㄱ', code: 'KeyR', meta: true }))!, {})).toEqual({ id: 'tab.rename', variant: 0 })
    expect(matchBinding(bindingFromEvent(key({ key: 'ㅅ', code: 'KeyT', meta: true, shift: true }))!, {})).toEqual({ id: 'tab.reopenClosed', variant: 0 })
    expect(matchBinding(bindingFromEvent(key({ key: '{', code: 'BracketLeft', meta: true, shift: true }))!, {})).toEqual({ id: 'tab.cycle', variant: 1 })
  })
  it('⌃PgUp/Dn = 이전/다음, ⌃1–9 = N번째(⌃9 = 9번째)', () => {
    expect(matchBinding('Control+PageDown', {})).toEqual({ id: 'tab.cycle', variant: 0 })
    expect(matchBinding('Control+PageUp', {})).toEqual({ id: 'tab.cycle', variant: 1 })
    expect(matchBinding(bindingFromEvent(key({ key: '1', code: 'Digit1', ctrl: true }))!, {})).toEqual({ id: 'tab.selectByIndex', variant: 0 })
    expect(matchBinding('Control+9', {})).toEqual({ id: 'tab.selectByIndex', variant: 8 })
    // Ctrl+Tab 은 MRU pane 스위처 그대로(P2).
    expect(matchBinding('Control+Tab', {})).toEqual({ id: 'mru.open', variant: 0 })
  })
  it('새 기본값끼리·기존 기본값과 충돌이 없다', () => {
    expect(bindingConflict({})).toBeNull()
  })
  it('새 액션은 재정의·충돌 검사가 된다(단축키 설정 화면과 같은 길)', () => {
    expect(validateOverrides({ 'tab.rename': ['Mod+Shift+E'] })).toEqual({ 'tab.rename': ['Mod+Shift+E'] })
    expect(() => validateOverrides({ 'tab.rename': ['Mod+K'] })).toThrow(/충돌/)
    expect(() => validateOverrides({ 'tab.cycle': ['Mod+Shift+]'] })).toThrow() // 칸 수(6)가 다르다
  })
  it('새 기본값은 비켜 선다 — 기존 재정의가 ⌘⇧T 를 쓰고 있으면 그 재정의가 이긴다', () => {
    const overrides = validateOverrides({ 'sidebar.toggle': ['Mod+Shift+T'] }, true)
    expect(overrides).toEqual({ 'sidebar.toggle': ['Mod+Shift+T'] })
    expect(matchBinding('Mod+Shift+T', overrides)?.id).toBe('sidebar.toggle')
    expect(bindingsFor('tab.reopenClosed', overrides)).toEqual([null])
  })
})

describe('LIFE-495 K7ⓘ — 옛 단축키 파일 이행(terminal.new 두 칸 → 한 칸)', () => {
  it('옛 기본값 그대로인 두 번째 칸(⌘⇧T)은 버리고 고친 첫 칸을 싣는다', () => {
    expect(validateOverrides({ 'terminal.new': ['Mod+J', 'Mod+Shift+T'] }, true)).toEqual({ 'terminal.new': ['Mod+J'] })
    expect(migrateLegacyOverrides({ 'terminal.new': ['Mod+J', 'Mod+Shift+T'] }).dropped).toEqual([])
  })
  it('두 번째 칸만 고쳤으면 그 칸이 새 칸이 된다 — 사용자가 고친 조합이 산다', () => {
    expect(validateOverrides({ 'terminal.new': ['Mod+T', 'Mod+Shift+J'] }, true)).toEqual({ 'terminal.new': ['Mod+Shift+J'] })
  })
  it('두 칸을 다 고쳤으면 앞 칸을 싣고, 못 실은 칸은 dropped 로 알린다(조용히 버리지 않는다)', () => {
    const legacy = { 'terminal.new': ['Mod+J', 'Mod+Shift+J'], 'sidebar.toggle': ['Mod+Alt+B'] }
    expect(validateOverrides(legacy, true)).toEqual({ 'terminal.new': ['Mod+J'], 'sidebar.toggle': ['Mod+Alt+B'] })
    expect(migrateLegacyOverrides(legacy).dropped).toEqual([{ id: 'terminal.new', binding: 'Mod+Shift+J' }])
  })
  it('저장 경로(엄격)에서도 옛 모양이 오류가 아니다 · 새 모양(한 칸)은 그대로다', () => {
    expect(validateOverrides({ 'terminal.new': ['Mod+J', 'Mod+Shift+T'] })).toEqual({ 'terminal.new': ['Mod+J'] })
    expect(validateOverrides({ 'terminal.new': ['Mod+J'] })).toEqual({ 'terminal.new': ['Mod+J'] })
  })
})

describe('fix1 R1-04 — 비켜 선 기본 조합은 빈 칸으로 남아 남은 조합의 variant 를 밀지 않는다', () => {
  it('sidebar.toggle 이 ⌃1 을 쓰면 ⌃2 = 둘째 탭, ⌃9 = 아홉째 탭 그대로', () => {
    const overrides = validateOverrides({ 'sidebar.toggle': ['Control+1'] })
    expect(matchBinding('Control+1', overrides)).toEqual({ id: 'sidebar.toggle', variant: 0 })
    expect(matchBinding('Control+2', overrides)).toEqual({ id: 'tab.selectByIndex', variant: 1 })
    expect(matchBinding('Control+9', overrides)).toEqual({ id: 'tab.selectByIndex', variant: 8 })
    expect(bindingsFor('tab.selectByIndex', overrides)[0]).toBeNull()
  })
  it('sidebar.toggle 이 ⌘⇧] 를 쓰면 남은 ⌘⇧[ 는 여전히 「이전」', () => {
    const overrides = validateOverrides({ 'sidebar.toggle': ['Mod+Shift+]'] })
    expect(matchBinding('Mod+Shift+[', overrides)).toEqual({ id: 'tab.cycle', variant: 1 })
    expect(matchBinding('Mod+Alt+]', overrides)).toEqual({ id: 'tab.cycle', variant: 0 })
  })
})

describe('fix1 R1-06 — main 이 가져오는 메뉴 키(⌘W·⌘R)의 반복 억제는 매칭된 액션 기준', () => {
  const key = (input: { key: string; isAutoRepeat: boolean }) => ({ key: input.key, code: `Key${input.key.toUpperCase()}`, meta: true, alt: false, control: false, shift: false, isAutoRepeat: input.isAutoRepeat })
  const dispatched = (overrides: ReturnType<typeof validateOverrides>, letter: string): number =>
    [false, true, true].filter((repeat) => menuKeyShortcut({ ...key({ key: letter, isAutoRepeat: repeat }), overrides }).dispatch !== null).length
  it('다시 열기를 ⌘W 로 재정의하면 누르고 있어도 한 번', () => {
    const overrides = validateOverrides({ 'terminal.close': ['Mod+E'], 'tab.reopenClosed': ['Mod+W'] })
    expect(dispatched(overrides, 'w')).toBe(1)
    expect(menuKeyShortcut({ ...key({ key: 'w', isAutoRepeat: true }), overrides }).claimed).toBe('W')
  })
  it('기본 ⌘W(닫기)는 지금처럼 반복도 보낸다 · ⌘R(이름 바꾸기)은 한 번', () => {
    expect(dispatched({}, 'w')).toBe(3)
    expect(dispatched({}, 'r')).toBe(1)
  })
  it('⌘⇧R·⌥ 가 낀 키·다른 글자는 가져오지 않는다', () => {
    expect(menuKeyShortcut({ ...key({ key: 'r', isAutoRepeat: false }), shift: true, overrides: {} }).claimed).toBeNull()
    expect(menuKeyShortcut({ ...key({ key: 't', isAutoRepeat: false }), overrides: {} }).claimed).toBeNull()
  })
})
