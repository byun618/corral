/** One action per user-visible operation. Each stored chord names a dispatch variant through bindingVariants. */
export const ACTIONS = [
  { id: 'palette.open', title: '커맨드 팔레트', defaultBinding: ['Mod+K'], bindingVariants: [0], variants: ['열기'] },
  { id: 'terminal.new', title: '새 탭', defaultBinding: ['Mod+T', 'Mod+Shift+T'], bindingVariants: [0, 0], variants: ['열기'] },
  { id: 'mru.open', title: '최근 pane 전환', defaultBinding: ['Control+Tab', 'Control+Shift+Tab'], bindingVariants: [0, 1], variants: ['다음', '이전'] },
  { id: 'terminal.split', title: 'pane 분할', defaultBinding: ['Mod+D', 'Mod+Shift+D'], bindingVariants: [0, 1], variants: ['오른쪽', '아래'] },
  { id: 'group.split', title: '영역 분할', defaultBinding: ['Mod+Alt+D', 'Mod+Alt+Shift+D'], bindingVariants: [0, 1], variants: ['오른쪽', '아래'] },
  { id: 'terminal.focus', title: '인접 pane 포커스', defaultBinding: ['Mod+Alt+ArrowLeft', 'Mod+Alt+ArrowRight', 'Mod+Alt+ArrowUp', 'Mod+Alt+ArrowDown', 'Mod+Alt+Shift+ArrowLeft', 'Mod+Alt+Shift+ArrowRight', 'Mod+Alt+Shift+ArrowUp', 'Mod+Alt+Shift+ArrowDown'], bindingVariants: [0, 1, 2, 3, 0, 1, 2, 3], variants: ['왼쪽', '오른쪽', '위', '아래'] },
  { id: 'group.close', title: '활성 영역 닫기', defaultBinding: ['Mod+Alt+W', 'Mod+Alt+Shift+W'], bindingVariants: [0, 0], variants: ['닫기'] },
  { id: 'terminal.zoom', title: 'pane 줌 전환', defaultBinding: ['Mod+Shift+Z', 'Mod+Alt+Shift+Z'], bindingVariants: [0, 0], variants: ['전환'] },
  { id: 'terminal.close', title: 'pane / 탭 닫기', defaultBinding: ['Mod+W'], bindingVariants: [0], variants: ['닫기'] },
  { id: 'sidebar.toggle', title: '사이드바 접기 / 펼치기', defaultBinding: ['Mod+B'], bindingVariants: [0], variants: ['전환'] },
  // LIFE-470 D28b — 198 `worktree.palette`(⌘J). 같은 391 팔레트를 연다(⌘K 는 그대로 — 게이트 ⓪ Q3).
  { id: 'palette.search', title: '검색 (팔레트)', defaultBinding: ['Mod+J'], bindingVariants: [0], variants: ['열기'] },
  // LIFE-478 — 198 `workspace.rename`(Mod+Alt+R, 활성 워크트리 인라인 rename) · `workspace.delete`(Mod+Shift+Backspace, hover 카드 삭제).
  { id: 'workspace.rename', title: '워크트리 이름 바꾸기', defaultBinding: ['Mod+Alt+R'], bindingVariants: [0], variants: ['활성 워크트리'] },
  { id: 'workspace.delete', title: '워크트리 삭제', defaultBinding: ['Mod+Shift+Backspace'], bindingVariants: [0], variants: ['hover 중인 카드'] },
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
/**
 * 나중에 기본 바인딩을 얻은 액션 — **기존 재정의가 그 조합을 이미 쓰면 기본값이 비켜 선다**(LIFE-470 K1ⓑ). ⌘J 를 다른 액션에
 * 재정의해 둔 사용자의 `keybindings.json` 이 충돌로 버려지지 않게 한다(재정의가 이기고, 이 액션은 조합 없음으로 남는다 —
 * 단축키 설정에서 다시 배정할 수 있다). 처음부터 있던 액션의 기본값은 지금처럼 재정의보다 앞선다.
 */
const YIELDING_DEFAULTS: readonly ActionId[] = ['palette.search', 'workspace.rename', 'workspace.delete']

function claimedByOtherOverrides(input: { id: ActionId; overrides: Keybindings }): Set<string> {
  const claimed = new Set<string>()
  for (const [owner, bindings] of Object.entries(input.overrides)) if (owner !== input.id && Array.isArray(bindings)) for (const binding of bindings) claimed.add(binding)
  return claimed
}

/** 표시·매칭에 쓰는 조합 — 비켜 선 기본 조합은 빠진다(그 자리는 빈 칸, 단축키 설정에서 「없음」). */
export function bindingsFor(id: ActionId, overrides: Keybindings): readonly string[] {
  const own = overrides[id]
  if (own !== undefined) return own
  const defaults = ACTIONS.find((action) => action.id === id)!.defaultBinding
  if (!YIELDING_DEFAULTS.includes(id)) return defaults
  const claimed = claimedByOtherOverrides({ id, overrides })
  return defaults.filter((binding) => !claimed.has(binding))
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
  // 비켜 서는 기본값(YIELDING_DEFAULTS)을 **명시로** 다시 적은 재정의는 남긴다 — 다른 재정의가 그 조합을 쓰면 기본값과 같아도
  // 그냥 버리면 저장이 조용히 무시된다. 남겨 두면 아래 충돌 검사가 잡는다(저장 = 오류 문구, 읽기 = 나중 액션을 버림).
  for (const id of YIELDING_DEFAULTS) {
    const raw: unknown = Reflect.get(value, id)
    const action = ACTIONS.find((row) => row.id === id)!
    if (result[id] !== undefined || !Array.isArray(raw) || raw.length !== action.defaultBinding.length) continue
    const normalized = raw.map((binding) => (typeof binding === 'string' ? normalizeBinding(binding) : null))
    if (normalized.some((binding) => binding === null)) continue
    const claimed = claimedByOtherOverrides({ id, overrides: result })
    if (normalized.some((binding) => binding !== null && claimed.has(binding))) result[id] = [...action.defaultBinding]
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
