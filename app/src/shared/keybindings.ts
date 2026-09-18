/** One action per user-visible operation. Each stored chord names a dispatch variant through bindingVariants. */
export const ACTIONS = [
  { id: 'terminal.new', title: '새 탭', defaultBinding: ['Mod+T', 'Mod+Shift+T'], bindingVariants: [0, 0], variants: ['열기'] },
  { id: 'mru.open', title: '최근 pane 전환', defaultBinding: ['Control+Tab', 'Control+Shift+Tab'], bindingVariants: [0, 1], variants: ['다음', '이전'] },
  { id: 'terminal.split', title: 'pane 분할', defaultBinding: ['Mod+D', 'Mod+Shift+D'], bindingVariants: [0, 1], variants: ['오른쪽', '아래'] },
  { id: 'group.split', title: '영역 분할', defaultBinding: ['Mod+Alt+D', 'Mod+Alt+Shift+D'], bindingVariants: [0, 1], variants: ['오른쪽', '아래'] },
  { id: 'terminal.focus', title: '인접 pane 포커스', defaultBinding: ['Mod+Alt+ArrowLeft', 'Mod+Alt+ArrowRight', 'Mod+Alt+ArrowUp', 'Mod+Alt+ArrowDown', 'Mod+Alt+Shift+ArrowLeft', 'Mod+Alt+Shift+ArrowRight', 'Mod+Alt+Shift+ArrowUp', 'Mod+Alt+Shift+ArrowDown'], bindingVariants: [0, 1, 2, 3, 0, 1, 2, 3], variants: ['왼쪽', '오른쪽', '위', '아래'] },
  { id: 'group.close', title: '활성 영역 닫기', defaultBinding: ['Mod+Alt+W', 'Mod+Alt+Shift+W'], bindingVariants: [0, 0], variants: ['닫기'] },
  { id: 'terminal.zoom', title: 'pane 줌 전환', defaultBinding: ['Mod+Shift+Z', 'Mod+Alt+Shift+Z'], bindingVariants: [0, 0], variants: ['전환'] },
  { id: 'terminal.close', title: 'pane / 탭 닫기', defaultBinding: ['Mod+W'], bindingVariants: [0], variants: ['닫기'] },
  { id: 'sidebar.toggle', title: '사이드바 접기 / 펼치기', defaultBinding: ['Mod+B'], bindingVariants: [0], variants: ['전환'] },
] as const
export type ActionId = (typeof ACTIONS)[number]['id']
export type Keybindings = Partial<Record<ActionId, string[]>>
export type ShortcutMatch = { id: ActionId; variant: number }
export type KeyInput = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }
const modifiers = ['Mod', 'Control', 'Alt', 'Shift']

export function normalizeBinding(value: string): string | null {
  const parts = value.split('+')
  const key = parts.pop()
  if (!key || !/^(?:[A-Za-z0-9]|Arrow(?:Left|Right|Up|Down)|Tab|Enter|Escape|Space|Backspace|Delete|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-9]|2[0-4])|[[\]\\;',./`=-])$/.test(key)) return null
  if (parts.length === 0 || parts.some((part) => !modifiers.includes(part)) || new Set(parts).size !== parts.length) return null
  return [...modifiers.filter((part) => parts.includes(part)), key.length === 1 ? key.toUpperCase() : key].join('+')
}

/** Physical letter codes also work with macOS Option glyphs and Korean input layouts. */
export function bindingFromEvent(event: KeyInput): string | null {
  if (event.isComposing || ['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null
  let key = event.key === ' ' ? 'Space' : event.key
  if (event.code && /^(Key[A-Z]|Digit[0-9])$/.test(event.code)) key = event.code.replace(/^(Key|Digit)/, '')
  return normalizeBinding([...event.metaKey ? ['Mod'] : [], ...event.ctrlKey ? ['Control'] : [], ...event.altKey ? ['Alt'] : [], ...event.shiftKey ? ['Shift'] : [], key].join('+'))
}
export function bindingsFor(id: ActionId, overrides: Keybindings): readonly string[] {
  return overrides[id] ?? ACTIONS.find((action) => action.id === id)!.defaultBinding
}

/** Matching and collision checks use exactly the displayed/stored chords. */
export function matchBinding(binding: string, overrides: Keybindings): ShortcutMatch | null {
  for (const action of ACTIONS) {
    const index = bindingsFor(action.id, overrides).indexOf(binding)
    const variant = action.bindingVariants[index]
    if (variant !== undefined) return { id: action.id, variant }
  }
  return null
}
function findConflict(overrides: Keybindings) {
  const owners = new Map<string, (typeof ACTIONS)[number]>()
  for (const action of ACTIONS) {
    for (const binding of bindingsFor(action.id, overrides)) {
      const owner = owners.get(binding)
      if (owner) return { first: owner.id, second: action.id, message: `${formatBinding(binding)}: ${owner.title} · ${action.title} 충돌` }
      owners.set(binding, action)
    }
  }
  return null
}
export function bindingConflict(overrides: Keybindings): string | null {
  return findConflict(overrides)?.message ?? null
}
export function validateOverrides(value: unknown, discardInvalid = false): Keybindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('단축키 파일은 객체여야 합니다')
  const result: Keybindings = {}
  for (const [id, bindings] of Object.entries(value)) {
    const action = ACTIONS.find((row) => row.id === id)
    if (!action) {
      if (discardInvalid) continue
      throw new Error(`알 수 없는 액션: ${id}`)
    }
    if (!Array.isArray(bindings) || bindings.length !== action.defaultBinding.length || bindings.some((binding) => typeof binding !== 'string' || !normalizeBinding(binding))) {
      if (discardInvalid) continue
      throw new Error(`${action.title}: 올바르지 않은 바인딩`)
    }
    const normalized = bindings.map((binding: string) => normalizeBinding(binding)!)
    if (JSON.stringify(normalized) !== JSON.stringify(action.defaultBinding)) result[action.id] = normalized
  }
  // Defaults win over corrupt overrides; between overrides catalog order wins.
  // Recheck after each deletion because restoring a default can reveal another conflict.
  for (let conflict = findConflict(result); conflict; conflict = findConflict(result)) {
    if (!discardInvalid) throw new Error(conflict.message)
    const rejected = result[conflict.second] !== undefined ? conflict.second : conflict.first
    delete result[rejected]
  }
  return result
}
export function formatBinding(binding: string): string {
  return binding.replaceAll('Mod+', '⌘').replaceAll('Control+', '⌃').replaceAll('Alt+', '⌥').replaceAll('Shift+', '⇧').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
}
