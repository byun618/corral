import { describe, expect, it } from 'vitest'
import { ACTIONS, bindingConflict, EDITOR_YIELD_ACTIONS, bindingFromEvent, bindingsFor, explorerKeyShortcut, matchBinding, menuKeyShortcut, migrateLegacyOverrides, NON_REPEATING_ACTIONS, normalizeBinding, scopeOf, validateOverrides, yieldsOutsideMarkdown, yieldsToEditorFind } from './keybindings.js'
describe('shortcut catalog and compatibility', () => {
  it('keeps the nine actions, the palette and the LIFE-470 search chord without collisions', () => {
    // LIFE-478: + workspace.rename(⌘⌥R) · workspace.delete(⌘⇧⌫)
    // LIFE-495: + tab.reopenClosed(⌘⇧T) · tab.rename(⌘R) · tab.cycle(⌘⇧[ ] · ⌘⌥[ ] · ⌃PgUp/Dn) · tab.selectByIndex(⌃1–9)
    // LIFE-511: + settings.open(⌘,)
    // LIFE-515: + terminal.newAgent(⌘⌥T)
    // LIFE-589: + rightPanel.toggle(⌘L) · explorer.show(⌘⇧E)
    // LIFE-591: + file.save(⌘S)
    // LIFE-592: + explorer.delete(⌘⌫) · explorer.undo(⌘Z) · explorer.redo(⌘⇧Z) — 탐색기 범위
    // LIFE-593: + quickOpen.open(⌘P) · explorer.filter(⌘⌥F — 탐색기 범위)
    // LIFE-601: + tasks.toggle(⌘I)
    // LIFE-629: + markdown.togglePreview(⇧⌘V)
    expect(ACTIONS).toHaveLength(34) // LIFE-683: + ⌘⇧G 소스 제어 보이기 · LIFE-824: + ⌃` 터미널 ↔ 편집기 전환 · LIFE-825: + ⌘⌥↩ 영역 최대화·영역 크기 균등화(키 없음) · LIFE-812: + ⌘F 터미널에서 찾기(터미널 범위)
    expect(matchBinding('Mod+K', {})).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+J', { 'palette.open': ['Mod+J'] })).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+K', { 'palette.open': ['Mod+J'] })).toBeNull()
    expect(bindingConflict({})).toBeNull()
    for (const action of ACTIONS) action.defaultBinding.forEach((binding, index) => expect(matchBinding(binding, {}, scopeOf(action))).toEqual({ id: action.id, variant: action.bindingVariants[index] }))
  })
  it('LIFE-592 탐색기 범위 — 트리 안에서만 매칭, 트리 안에서는 전역보다 앞선다, 범위가 다르면 충돌 아님', () => {
    // 트리 밖: ⌘Z·⌘⌫ 는 아무 액션도 아니다(편집기·입력칸·터미널의 것), ⌘⇧Z 는 터미널 줌 그대로
    expect(matchBinding('Mod+Z', {})).toBeNull()
    expect(matchBinding('Mod+Backspace', {})).toBeNull()
    expect(matchBinding('Mod+Shift+Z', {})).toEqual({ id: 'terminal.zoom', variant: 0 })
    // 트리 안: 탐색기 액션이 먼저, 없으면 전역(⌘K 팔레트는 트리에서도 열린다)
    expect(matchBinding('Mod+Z', {}, 'explorer')).toEqual({ id: 'explorer.undo', variant: 0 })
    expect(matchBinding('Mod+Shift+Z', {}, 'explorer')).toEqual({ id: 'explorer.redo', variant: 0 })
    expect(matchBinding('Mod+Backspace', {}, 'explorer')).toEqual({ id: 'explorer.delete', variant: 0 })
    expect(matchBinding('Mod+K', {}, 'explorer')).toEqual({ id: 'palette.open', variant: 0 })
    expect(bindingConflict({})).toBeNull()
    // 같은 범위 안 겹침 — 나중 기본값(양보)이 비켜 선다(탐색기 삭제를 ⌘Z 로 바꾸면 탐색기 실행 취소는 「없음」)
    expect(bindingsFor('explorer.undo', validateOverrides({ 'explorer.delete': ['Mod+Z'] }))).toEqual([null])
    // 재지정 — 트리 안 다시 실행을 ⌘Y 로
    const moved = validateOverrides({ 'explorer.redo': ['Mod+Y'] })
    expect(matchBinding('Mod+Y', moved, 'explorer')).toEqual({ id: 'explorer.redo', variant: 0 })
    expect(matchBinding('Mod+Shift+Z', moved, 'explorer')).toEqual({ id: 'terminal.zoom', variant: 0 })
  })
  it('LIFE-812 터미널 범위 — ⌘F 는 터미널 포커스에서만, 기본값 중복·충돌 0(C6ⓓ)', () => {
    // 터미널 밖(Monaco·설정 검색칸·입력칸)은 ⌘F 를 가져가지 않는다 — 그 자리의 찾기로 간다
    expect(matchBinding('Mod+F', {})).toBeNull()
    expect(matchBinding('Mod+F', {}, 'explorer')).toBeNull()
    expect(matchBinding('Mod+F', {}, 'terminal')).toEqual({ id: 'terminal.find', variant: 0 })
    // 터미널 안에서도 전역 액션은 그대로 — ⌥⌘F(탐색기 이름 필터)는 트리 범위라 터미널에서 매칭되지 않는다(base 그대로)
    expect(matchBinding('Mod+K', {}, 'terminal')).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+Alt+F', {}, 'terminal')).toBeNull()
    expect(matchBinding('Mod+Alt+F', {}, 'explorer')).toEqual({ id: 'explorer.filter', variant: 0 })
    // 기본 조합 중복 0 — 범위별로 센다
    const seen = new Set<string>()
    for (const action of ACTIONS) for (const binding of action.defaultBinding) {
      const key = `${scopeOf(action)}\0${binding}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
    expect(bindingConflict({})).toBeNull()
    // 나중 기본값이라 양보한다(fix3 R3-3) — ⌘F 를 전역 액션에 직접 건 사용자의 설정은 버려지지 않고(충돌 아님), 터미널 포커스에서도 그 액션이 돈다
    const palette = validateOverrides({ 'palette.open': ['Mod+F'] })
    expect(bindingConflict(palette)).toBeNull()
    expect(bindingsFor('terminal.find', palette)).toEqual([null])
    expect(matchBinding('Mod+F', palette, 'terminal')).toEqual({ id: 'palette.open', variant: 0 })
    expect(matchBinding('Mod+F', palette)).toEqual({ id: 'palette.open', variant: 0 })
    // 탐색기 범위는 그대로 — 트리 안에서는 탐색기 기본값이 전역 재정의보다 앞선다(base 동작)
    expect(matchBinding('Mod+Z', validateOverrides({ 'palette.open': ['Mod+Z'] }), 'explorer')).toEqual({ id: 'explorer.undo', variant: 0 })
    // 같은 터미널 범위에 다른 조합으로 옮길 수 있다
    expect(matchBinding('Mod+Shift+F', validateOverrides({ 'terminal.find': ['Mod+Shift+F'] }), 'terminal')).toEqual({ id: 'terminal.find', variant: 0 })
  })
  it('LIFE-592 explorerKeyShortcut — 트리 포커스 표지가 켜졌을 때 ⌘Z·⌘⇧Z 만 main 이 가져온다', () => {
    const key = (input: { key: string; shift?: boolean; focused: boolean; overrides?: object }) =>
      explorerKeyShortcut({ key: input.key, code: `Key${input.key.toUpperCase()}`, meta: true, alt: false, control: false, shift: input.shift === true, isAutoRepeat: false, overrides: input.overrides ?? {}, explorerFocused: input.focused })
    expect(key({ key: 'z', focused: true })).toEqual({ id: 'explorer.undo', variant: 0 })
    expect(key({ key: 'Z', shift: true, focused: true })).toEqual({ id: 'explorer.redo', variant: 0 })
    expect(key({ key: 'z', focused: false })).toBeNull()
    expect(key({ key: 'k', focused: true })).toBeNull()
    // 재지정해 ⌘Z 가 탐색기 실행 취소가 아니면 가져오지 않는다(메뉴 role 그대로)
    expect(key({ key: 'z', focused: true, overrides: validateOverrides({ 'explorer.undo': ['Mod+U'] }) })).toBeNull()
  })
  it('LIFE-601 tasks.toggle = ⌘I (I 물리 키 — 한글 자판에서도) · 기본 바인딩 충돌 0 · 기존 재정의가 ⌘I 를 쓰면 비켜 선다', () => {
    expect(matchBinding('Mod+I', {})).toEqual({ id: 'tasks.toggle', variant: 0 })
    expect(bindingFromEvent({ key: 'ㅑ', code: 'KeyI', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe('Mod+I')
    expect(bindingConflict({})).toBeNull()
    expect(matchBinding('Mod+I', { 'palette.open': ['Mod+I'] })).toEqual({ id: 'palette.open', variant: 0 })
  })
  it('LIFE-511 settings.open = ⌘, (Comma 물리 키) · 기존 재정의가 ⌘, 를 쓰면 비켜 선다', () => {
    expect(matchBinding('Mod+,', {})).toEqual({ id: 'settings.open', variant: 0 })
    expect(bindingFromEvent({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe('Mod+,')
    // 한글 자판에서도 물리 위치로 읽는다.
    expect(bindingFromEvent({ key: '<', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe('Mod+Shift+,')
    const claimed = validateOverrides({ 'palette.open': ['Mod+,'] })
    expect(claimed).toEqual({ 'palette.open': ['Mod+,'] })
    expect(bindingsFor('settings.open', claimed)).toEqual([null])
    expect(matchBinding('Mod+,', claimed)).toEqual({ id: 'palette.open', variant: 0 })
    // 「없음」 으로 둔 설정 열기 — 키는 아무 액션도 아니다.
    expect(matchBinding('Mod+,', validateOverrides({ 'settings.open': [null] }))).toBeNull()
    // 다른 조합으로 바꿀 수 있다.
    expect(matchBinding('Mod+Shift+,', validateOverrides({ 'settings.open': ['Mod+Shift+,'] }))).toEqual({ id: 'settings.open', variant: 0 })
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

describe('fix2 R2-01 — 재정의의 빈 칸(null) = 그 칸 조합 없음', () => {
  const index = (slots: (string | null)[]) => ({ 'tab.selectByIndex': slots })
  const rest = ['Control+3', 'Control+4', 'Control+5', 'Control+6', 'Control+7', 'Control+8', 'Control+9']
  it('검증이 null 칸을 보존한다 — 다른 칸은 정규화, 칸 위치 그대로', () => {
    const overrides = validateOverrides({ 'sidebar.toggle': ['Control+1'], ...index([null, 'Control+g', ...rest]) })
    expect(overrides['tab.selectByIndex']).toEqual([null, 'Control+G', ...rest])
    expect(matchBinding('Control+1', overrides)).toEqual({ id: 'sidebar.toggle', variant: 0 })
    expect(matchBinding('Control+G', overrides)).toEqual({ id: 'tab.selectByIndex', variant: 1 })
    expect(bindingConflict(overrides)).toBeNull()
  })
  it('null 칸은 충돌 검사·다른 액션의 비켜 서기에서 조합으로 세지 않는다', () => {
    expect(() => validateOverrides({ ...index([null, null, ...rest]) })).not.toThrow()
    expect(bindingsFor('sidebar.toggle', validateOverrides(index([null, 'Control+2', ...rest])))).toEqual(['Mod+B'])
  })
  it('칸 수가 다르거나 칸이 문자열·null 이 아니면 지금처럼 거절한다', () => {
    expect(() => validateOverrides(index([null, 'Control+2']))).toThrow()
    expect(() => validateOverrides({ 'tab.selectByIndex': [0, 'Control+2', ...rest] })).toThrow()
  })
  it('옛 모양 이행은 null 칸이 있는 재정의를 건드리지 않는다', () => {
    expect(migrateLegacyOverrides({ 'terminal.new': [null, 'Mod+Shift+J'] }).value).toEqual({ 'terminal.new': [null, 'Mod+Shift+J'] })
    expect(migrateLegacyOverrides({ 'terminal.new': [null, 'Mod+Shift+J'] }).dropped).toEqual([])
  })
})

describe('LIFE-515 K3 — terminal.newAgent(⌘⌥T)', () => {
  it('기본 Mod+Alt+T · 물리 키(KeyT)로 읽는다 — macOS Option 글리프(†)·한글 자판(ㅅ)이어도 같다 · 기존 기본값과 충돌 없음', () => {
    expect(matchBinding('Mod+Alt+T', {})).toEqual({ id: 'terminal.newAgent', variant: 0 })
    expect(bindingFromEvent({ key: '†', code: 'KeyT', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe('Mod+Alt+T')
    expect(bindingFromEvent({ key: 'ㅅ', code: 'KeyT', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe('Mod+Alt+T')
    expect(bindingConflict({})).toBeNull()
    // ⌘T·⌘⇧T 는 그대로다.
    expect(matchBinding('Mod+T', {})).toEqual({ id: 'terminal.new', variant: 0 })
    expect(matchBinding('Mod+Shift+T', {})).toEqual({ id: 'tab.reopenClosed', variant: 0 })
  })
  it('나중에 생긴 기본값이라 비켜 선다 — 기존 재정의가 ⌘⌥T 를 쓰면 그 재정의가 이기고 새 액션은 「없음」', () => {
    const claimed = validateOverrides({ 'sidebar.toggle': ['Mod+Alt+T'] })
    expect(claimed).toEqual({ 'sidebar.toggle': ['Mod+Alt+T'] })
    expect(bindingsFor('terminal.newAgent', claimed)).toEqual([null])
    expect(matchBinding('Mod+Alt+T', claimed)).toEqual({ id: 'sidebar.toggle', variant: 0 })
  })
  it('재정의·끄기·초기화 — 단축키 설정과 같은 길(validateOverrides)', () => {
    expect(matchBinding('Mod+Alt+Shift+T', validateOverrides({ 'terminal.newAgent': ['Mod+Alt+Shift+T'] }))).toEqual({ id: 'terminal.newAgent', variant: 0 })
    expect(matchBinding('Mod+Alt+T', validateOverrides({ 'terminal.newAgent': [null] }))).toBeNull()
    // 기본값과 같은 재정의는 저장하지 않는다(초기화).
    expect(validateOverrides({ 'terminal.newAgent': ['Mod+Alt+T'] })).toEqual({})
    // 다른 액션의 기본값을 쓰면 충돌로 거절한다.
    expect(() => validateOverrides({ 'terminal.newAgent': ['Mod+T'] })).toThrow(/충돌/)
  })
  it('누르고 있어도 한 번만 — NON_REPEATING_ACTIONS 에 든다(Orca `event.repeat` 무시)', () => {
    expect(NON_REPEATING_ACTIONS).toContain('terminal.newAgent')
  })
})
describe('LIFE-589 오른쪽 패널·탐색기 단축키', () => {
  it('기본 ⌘L 패널 토글 · ⌘⇧E 탐색기 열고 포커스, 길게 눌러도 반복하지 않는다', () => {
    expect(matchBinding('Mod+L', {})).toEqual({ id: 'rightPanel.toggle', variant: 0 })
    expect(matchBinding('Mod+Shift+E', {})).toEqual({ id: 'explorer.show', variant: 0 })
    expect(NON_REPEATING_ACTIONS).toEqual(expect.arrayContaining(['rightPanel.toggle', 'explorer.show']))
  })
  it('기존 재정의가 ⌘L·⌘⇧E 를 쓰면 비켜 선다 — 사용자 파일을 버리지 않는다', () => {
    const legacy = { 'sidebar.toggle': ['Mod+L'], 'palette.open': ['Mod+Shift+E'] }
    expect(validateOverrides(legacy, true)).toEqual(legacy)
    expect(matchBinding('Mod+L', legacy)?.id).toBe('sidebar.toggle')
    expect(matchBinding('Mod+Shift+E', legacy)?.id).toBe('palette.open')
    expect(bindingsFor('rightPanel.toggle', legacy)).toEqual([null])
    expect(bindingsFor('explorer.show', legacy)).toEqual([null])
    expect(bindingConflict(legacy)).toBeNull()
  })
})

describe('LIFE-593 ⌘P 빠른 열기 · ⌥⌘F 이름 필터', () => {
  it('E1ⓐ ⌘P = quickOpen.open(전역), ⌥⌘F 는 트리 안에서만 explorer.filter', () => {
    expect(matchBinding('Mod+P', {})).toEqual({ id: 'quickOpen.open', variant: 0 })
    expect(matchBinding('Mod+Alt+F', {})).toBeNull()
    expect(matchBinding('Mod+Alt+F', {}, 'explorer')).toEqual({ id: 'explorer.filter', variant: 0 })
  })
  it('나중에 생긴 기본값이라 양보한다 — ⌘P 를 이미 다른 액션에 재정의한 설정이 버려지지 않는다', () => {
    const overrides = validateOverrides({ 'sidebar.toggle': ['Mod+P'] })
    expect(overrides['sidebar.toggle']).toEqual(['Mod+P'])
    expect(bindingsFor('quickOpen.open', overrides)).toEqual([null])
    expect(matchBinding('Mod+P', overrides)).toEqual({ id: 'sidebar.toggle', variant: 0 })
  })
  it('재지정·충돌 검사', () => {
    expect(bindingConflict({ 'quickOpen.open': ['Mod+K'] })).not.toBeNull()
    expect(validateOverrides({ 'quickOpen.open': ['Mod+Shift+O'] })['quickOpen.open']).toEqual(['Mod+Shift+O'])
  })
  it('키를 누르고 있어도 한 번', () => {
    expect(NON_REPEATING_ACTIONS).toContain('quickOpen.open')
  })
})

describe('LIFE-629 ⇧⌘V Markdown 미리보기 전환', () => {
  it('기본값 ⇧⌘V · 다른 기본값과 충돌 없음 · 한 번만(반복 삼킴)', () => {
    expect(matchBinding('Mod+Shift+V', {})).toEqual({ id: 'markdown.togglePreview', variant: 0 })
    expect(bindingFromEvent({ key: 'V', code: 'KeyV', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe('Mod+Shift+V')
    // 한글 자판(ㅍ)이어도 물리 키로 읽는다
    expect(bindingFromEvent({ key: 'ㅍ', code: 'KeyV', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe('Mod+Shift+V')
    expect(bindingConflict({})).toBeNull()
    expect(NON_REPEATING_ACTIONS).toContain('markdown.togglePreview')
    // 메뉴 Paste and Match Style(⌘⌥⇧V)·⌘V 는 액션이 아니다
    expect(matchBinding('Mod+Alt+Shift+V', {})).toBeNull()
    expect(matchBinding('Mod+V', {})).toBeNull()
  })
  it('재정의가 먹는다 · 저장 형식 그대로(기본값과 같으면 파일에 안 남는다)', () => {
    const moved = validateOverrides({ 'markdown.togglePreview': ['Mod+Alt+V'] })
    expect(moved).toEqual({ 'markdown.togglePreview': ['Mod+Alt+V'] })
    expect(matchBinding('Mod+Alt+V', moved)).toEqual({ id: 'markdown.togglePreview', variant: 0 })
    expect(matchBinding('Mod+Shift+V', moved)).toBeNull()
    expect(validateOverrides({ 'markdown.togglePreview': ['Mod+Shift+V'] })).toEqual({})
    // 기존 재정의 파일(다른 액션들)은 그대로 통과한다
    expect(validateOverrides({ 'palette.open': ['Mod+J'], 'palette.search': ['Mod+Shift+J'] })).toEqual({ 'palette.open': ['Mod+J'], 'palette.search': ['Mod+Shift+J'] })
  })
  it('기존 사용자 재정의가 ⇧⌘V 를 쓰면 새 기본값이 비켜 선다(YIELDING_DEFAULTS) — 충돌로 파일이 버려지지 않는다', () => {
    const existing = validateOverrides({ 'palette.search': ['Mod+Shift+V'] })
    expect(existing).toEqual({ 'palette.search': ['Mod+Shift+V'] })
    expect(bindingsFor('markdown.togglePreview', existing)).toEqual([null])
    expect(matchBinding('Mod+Shift+V', existing)).toEqual({ id: 'palette.search', variant: 0 })
    expect(bindingConflict(existing)).toBeNull()
  })
  it('yieldsOutsideMarkdown — Markdown 보기 밖이면 이 액션만 양보, 다른 액션은 그대로', () => {
    expect(yieldsOutsideMarkdown({ id: 'markdown.togglePreview', inMarkdownView: false })).toBe(true)
    expect(yieldsOutsideMarkdown({ id: 'markdown.togglePreview', inMarkdownView: true })).toBe(false)
    for (const action of ACTIONS) if (action.id !== 'markdown.togglePreview') expect(yieldsOutsideMarkdown({ id: action.id, inMarkdownView: false })).toBe(false)
  })
  it('LIFE-692 새 편집기 키는 앱 전역 액션이 아니다(편집기로 간다) — ⌘K 만 앱이 쥔다', () => {
    for (const binding of ['Mod+Backspace', 'Mod+Shift+K', 'Alt+ArrowUp', 'Alt+ArrowDown', 'Alt+Shift+ArrowUp', 'Alt+Shift+ArrowDown', 'Mod+]', 'Mod+[', 'Mod+/', 'Alt+Shift+A', 'Mod+Enter', 'Mod+Shift+Enter', 'Control+J', 'Control+T', 'Control+Alt+ArrowLeft', 'Control+Alt+ArrowRight']) expect(matchBinding(binding, {})).toBeNull()
    expect(matchBinding('Mod+K', {})).toEqual({ id: 'palette.open', variant: 0 })
  })
})

describe('LIFE-683 F2-05 (R1-03 되돌림)', () => {
  it('scm.show 는 편집기 양보 목록에 들지 않는다 — 편집기 포커스에서도 ⌘⇧G = 소스 제어', () => {
    expect(EDITOR_YIELD_ACTIONS).not.toContain('scm.show')
  })
})

describe('LIFE-825 — ⌘⌥Enter 영역 최대화', () => {
  it('기본 조합 Mod+Alt+Enter 는 group.maximize, 균등화는 키 없음(매칭 0)·누르고 있어도 한 번', () => {
    expect(matchBinding('Mod+Alt+Enter', {})).toEqual({ id: 'group.maximize', variant: 0 })
    expect(ACTIONS.find((action) => action.id === 'group.even')?.defaultBinding).toEqual([])
    expect(bindingsFor('group.even', {})).toEqual([])
    expect(NON_REPEATING_ACTIONS).toContain('group.maximize')
  })
  it('yieldsToEditorFind — 찾기 위젯이 열린 편집기에서만 Monaco 「모두 바꾸기」에 양보', () => {
    expect(yieldsToEditorFind({ id: 'group.maximize', findWidgetVisible: true })).toBe(true)
    expect(yieldsToEditorFind({ id: 'group.maximize', findWidgetVisible: false })).toBe(false)
    expect(yieldsToEditorFind({ id: 'group.close', findWidgetVisible: true })).toBe(false)
  })
})
