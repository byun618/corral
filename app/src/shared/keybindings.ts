/**
 * One action per user-visible operation. Each stored chord names a dispatch variant through bindingVariants.
 * `group` — 설정 › 단축키 섹션의 묶음(LIFE-511). Orca 198 그룹(Global · Tabs · Tab Navigation · Terminal Panes)에 같은 뜻의 액션을 대응시켰다.
 */
export const ACTIONS = [
  { id: 'palette.open', group: '전역', title: '커맨드 팔레트', defaultBinding: ['Mod+K'], bindingVariants: [0], variants: ['열기'] },
  // LIFE-495 — ⌘⇧T 는 「닫은 탭 다시 열기」로 넘어갔다(P1). 옛 파일의 두 칸 재정의는 `LEGACY_DEFAULTS` 가 한 칸으로 옮긴다.
  { id: 'terminal.new', group: '탭', title: '새 탭', defaultBinding: ['Mod+T'], bindingVariants: [0], variants: ['열기'] },
  { id: 'mru.open', group: '탭 이동', title: '최근 pane 전환', defaultBinding: ['Control+Tab', 'Control+Shift+Tab'], bindingVariants: [0, 1], variants: ['다음', '이전'] },
  { id: 'terminal.split', group: '터미널 pane', title: 'pane 분할', defaultBinding: ['Mod+D', 'Mod+Shift+D'], bindingVariants: [0, 1], variants: ['오른쪽', '아래'] },
  { id: 'group.split', group: '터미널 pane', title: '영역 분할', defaultBinding: ['Mod+Alt+D', 'Mod+Alt+Shift+D'], bindingVariants: [0, 1], variants: ['오른쪽', '아래'] },
  { id: 'terminal.focus', group: '터미널 pane', title: '인접 pane 포커스', defaultBinding: ['Mod+Alt+ArrowLeft', 'Mod+Alt+ArrowRight', 'Mod+Alt+ArrowUp', 'Mod+Alt+ArrowDown', 'Mod+Alt+Shift+ArrowLeft', 'Mod+Alt+Shift+ArrowRight', 'Mod+Alt+Shift+ArrowUp', 'Mod+Alt+Shift+ArrowDown'], bindingVariants: [0, 1, 2, 3, 0, 1, 2, 3], variants: ['왼쪽', '오른쪽', '위', '아래'] },
  { id: 'group.close', group: '터미널 pane', title: '활성 영역 닫기', defaultBinding: ['Mod+Alt+W', 'Mod+Alt+Shift+W'], bindingVariants: [0, 0], variants: ['닫기'] },
  { id: 'terminal.zoom', group: '터미널 pane', title: 'pane 줌 전환', defaultBinding: ['Mod+Shift+Z', 'Mod+Alt+Shift+Z'], bindingVariants: [0, 0], variants: ['전환'] },
  { id: 'terminal.close', group: '터미널 pane', title: 'pane / 탭 닫기', defaultBinding: ['Mod+W'], bindingVariants: [0], variants: ['닫기'] },
  { id: 'sidebar.toggle', group: '전역', title: '사이드바 접기 / 펼치기', defaultBinding: ['Mod+B'], bindingVariants: [0], variants: ['전환'] },
  // LIFE-470 D28b — 198 `worktree.palette`(⌘J). 같은 391 팔레트를 연다(⌘K 는 그대로 — 게이트 ⓪ Q3).
  { id: 'palette.search', group: '전역', title: '검색 (팔레트)', defaultBinding: ['Mod+J'], bindingVariants: [0], variants: ['열기'] },
  // LIFE-478 — 198 `workspace.rename`(Mod+Alt+R, 활성 워크트리 인라인 rename) · `workspace.delete`(Mod+Shift+Backspace, hover 카드 삭제).
  { id: 'workspace.rename', group: '전역', title: '워크트리 이름 바꾸기', defaultBinding: ['Mod+Alt+R'], bindingVariants: [0], variants: ['활성 워크트리'] },
  { id: 'workspace.delete', group: '전역', title: '워크트리 삭제', defaultBinding: ['Mod+Shift+Backspace'], bindingVariants: [0], variants: ['hover 중인 카드'] },
  // LIFE-495 — 탭 단축키(220 `definitions-core-2.ts`). ⌘R 은 기본 메뉴 Reload 가 쥐고 있어 main 이 가로챈다(`main/index.ts`).
  { id: 'tab.reopenClosed', group: '탭', title: '닫은 탭 다시 열기', defaultBinding: ['Mod+Shift+T'], bindingVariants: [0], variants: ['다시 열기'] },
  { id: 'tab.rename', group: '탭', title: '탭 제목 바꾸기', defaultBinding: ['Mod+R'], bindingVariants: [0], variants: ['활성 탭'] },
  // 220 은 ⌘⌥[ ](같은 종류)·⌘⇧[ ](전체)·⌃PgUp/Dn(터미널만)을 따로 두지만 corral 탭은 전부 터미널이라 셋이 같은 순환이다 — 한 액션의 별칭이다.
  {
    id: 'tab.cycle',
    group: '탭 이동',
    title: '이전 / 다음 탭',
    defaultBinding: ['Mod+Shift+]', 'Mod+Shift+[', 'Mod+Alt+]', 'Mod+Alt+[', 'Control+PageDown', 'Control+PageUp'],
    bindingVariants: [0, 1, 0, 1, 0, 1],
    variants: ['다음', '이전'],
  },
  {
    id: 'tab.selectByIndex',
    group: '탭 이동',
    title: 'N번째 탭',
    defaultBinding: ['Control+1', 'Control+2', 'Control+3', 'Control+4', 'Control+5', 'Control+6', 'Control+7', 'Control+8', 'Control+9'],
    bindingVariants: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    variants: ['1번째', '2번째', '3번째', '4번째', '5번째', '6번째', '7번째', '8번째', '9번째'],
  },
  // LIFE-511 — 198 `app.settings`(Mod+Comma). 설정 페이지를 연다. 나중에 생긴 기본값이라 양보한다(아래 YIELDING_DEFAULTS).
  { id: 'settings.open', group: '전역', title: '설정 열기', defaultBinding: ['Mod+,'], bindingVariants: [0], variants: ['열기'] },
  // LIFE-515 — 198 `tab.newAgent`(darwin Mod+Alt+T). 설정 › AI 기능 › 에이전트의 기본 Agent 로 새 탭을 연다(agent 없음이면 빈 터미널 — D2).
  // id 는 `terminal.` 접두로 둔다(`terminal.new` 와 같은 줄기) — 지을 때는 `tab.*` 가 경계 검사 R4 오탐에 걸렸다(LIFE-518 이 해소: 액션 id 는 요청 envelope 자리에서만 걸린다). 나중에 생긴 기본값이라 양보한다.
  { id: 'terminal.newAgent', group: '탭', title: '새 에이전트 탭', defaultBinding: ['Mod+Alt+T'], bindingVariants: [0], variants: ['기본 Agent'] },
  // LIFE-589 — Orca `sidebar.right.toggle`(Mod+L) · `sidebar.explorer.toggle`(Mod+Shift+E). ⌘⇧E 는 「탐색기 보이기」(닫혀 있으면 열고 포커스) —
  // VS Code `workbench.view.explorer` 와 같은 뜻이다. 나중에 생긴 기본값이라 양보한다(아래 YIELDING_DEFAULTS).
  { id: 'rightPanel.toggle', group: '전역', title: '오른쪽 패널 열기 / 닫기', defaultBinding: ['Mod+L'], bindingVariants: [0], variants: ['전환'] },
  { id: 'explorer.show', group: '전역', title: '탐색기 보이기', defaultBinding: ['Mod+Shift+E'], bindingVariants: [0], variants: ['보이기'] },
] as const
export type ActionId = (typeof ACTIONS)[number]['id']
/** 칸 위치 = `defaultBinding` 칸. `null` = 그 칸 조합 없음(비켜 선 칸을 그대로 둔 채 다른 칸만 고쳐 저장한 경우 — LIFE-495 fix2 R2-01). */
export type Keybindings = Partial<Record<ActionId, (string | null)[]>>
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

const PUNCTUATION_CODES: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Equal: '=', Minus: '-',
}

/** Physical letter codes also work with macOS Option glyphs and Korean input layouts. */
export function bindingFromEvent(event: KeyInput): string | null {
  if (event.isComposing || ['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null
  let key = event.key === ' ' ? 'Space' : event.key
  // LIFE-495 U1 — 문장부호 키도 물리 위치로 읽는다. ⇧[ 는 key 가 `{`, macOS ⌥[ 는 `“` 로 와서 글자로는 바인딩이 안 된다.
  const punctuation = event.code === undefined ? undefined : PUNCTUATION_CODES[event.code]
  if (event.code && /^(Key[A-Z]|Digit[0-9])$/.test(event.code)) key = event.code.replace(/^(Key|Digit)/, '')
  else if (punctuation !== undefined) key = punctuation
  return normalizeBinding([...event.metaKey ? ['Mod'] : [], ...event.ctrlKey ? ['Control'] : [], ...event.altKey ? ['Alt'] : [], ...event.shiftKey ? ['Shift'] : [], key].join('+'))
}
/**
 * 나중에 기본 바인딩을 얻은 액션 — **기존 재정의가 그 조합을 이미 쓰면 기본값이 비켜 선다**(LIFE-470 K1ⓑ). ⌘J 를 다른 액션에
 * 재정의해 둔 사용자의 `keybindings.json` 이 충돌로 버려지지 않게 한다(재정의가 이기고, 이 액션은 조합 없음으로 남는다 —
 * 단축키 설정에서 다시 배정할 수 있다). 처음부터 있던 액션의 기본값은 지금처럼 재정의보다 앞선다.
 */
const YIELDING_DEFAULTS: readonly ActionId[] = ['palette.search', 'workspace.rename', 'workspace.delete', 'tab.reopenClosed', 'tab.rename', 'tab.cycle', 'tab.selectByIndex', 'settings.open', 'terminal.newAgent', 'rightPanel.toggle', 'explorer.show']

/**
 * 기본 조합 **개수가 바뀐** 액션의 옛 기본값 (LIFE-495 K7ⓘ). 칸 수가 다른 재정의는 아래 검사에서 버려지므로, 옛 칸 수 그대로인 재정의를
 * 읽을 때 새 칸 수로 옮긴다 — 규칙: 옛 기본값과 **다르게 고친 칸**(사용자의 뜻)을 앞에서부터 새 칸에 싣고, 모자라면 새 기본값으로 채운다.
 * 옛 기본값 그대로인 칸(`terminal.new` 의 ⌘⇧T 별칭 등)은 버린다 — 그 조합은 이제 다른 액션의 기본값이다. 새 칸에 못 실은 고친 칸은
 * `dropped` 로 돌려준다(main 이 로그로 남긴다 — 조용히 사라지지 않게).
 */
const LEGACY_DEFAULTS: readonly { id: ActionId; defaultBinding: readonly string[] }[] = [{ id: 'terminal.new', defaultBinding: ['Mod+T', 'Mod+Shift+T'] }]

export function migrateLegacyOverrides(value: object): { value: Record<string, unknown>; dropped: { id: ActionId; binding: string }[] } {
  const next: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const dropped: { id: ActionId; binding: string }[] = []
  for (const legacy of LEGACY_DEFAULTS) {
    const raw: unknown = next[legacy.id]
    const action = ACTIONS.find((row) => row.id === legacy.id)
    if (action === undefined || !Array.isArray(raw) || raw.length !== legacy.defaultBinding.length || raw.length === action.defaultBinding.length) continue
    const normalized = raw.map((binding) => (typeof binding === 'string' ? normalizeBinding(binding) : null))
    if (normalized.some((binding) => binding === null)) continue
    const edited = normalized.filter((binding, index): binding is string => binding !== null && binding !== legacy.defaultBinding[index])
    const kept = action.defaultBinding.map((fallback, index) => edited[index] ?? fallback)
    for (const binding of edited.slice(action.defaultBinding.length)) dropped.push({ id: legacy.id, binding })
    next[legacy.id] = kept
  }
  return { value: next, dropped }
}

/** 재정의 칸 정규화 — null 칸 = 그 칸 조합 없음(fix2 R2-01, 저장·파일 읽기가 같은 뜻으로 보존), 그 밖은 정규화할 수 있는 문자열. 하나라도 아니면 null. */
function normalizeSlots(value: unknown): (string | null)[] | null {
  if (!Array.isArray(value)) return null
  const slots: (string | null)[] = []
  for (const binding of value) {
    if (binding === null) { slots.push(null); continue }
    const normalized = typeof binding === 'string' ? normalizeBinding(binding) : null
    if (normalized === null) return null
    slots.push(normalized)
  }
  return slots
}

function claimedByOtherOverrides(input: { id: ActionId; overrides: Keybindings }): Set<string> {
  const claimed = new Set<string>()
  for (const [owner, bindings] of Object.entries(input.overrides)) if (owner !== input.id && Array.isArray(bindings)) for (const binding of bindings) if (binding !== null) claimed.add(binding)
  return claimed
}

/**
 * 표시·매칭에 쓰는 조합 — 칸 위치 = `defaultBinding`·`bindingVariants` 의 칸. 비켜 선 기본 조합은 **그 칸이 null**(단축키 설정에서 「없음」).
 * 칸을 지우지 않는다 — 지우면 뒤 칸이 앞으로 당겨져 variant(방향·탭 번호)가 밀린다(LIFE-495 fix1 R1-04: ⌃1 을 다른 액션이 쓰면 ⌃2 가 첫 탭을 골랐다).
 */
export function bindingsFor(id: ActionId, overrides: Keybindings): readonly (string | null)[] {
  const own = overrides[id]
  if (own !== undefined) return own
  const action = ACTIONS.find((row) => row.id === id)
  // 목록에 없는 id 는 조합이 없다(ActionId 는 목록에서 온 이름이라 실제로는 오지 않는다 — LIFE-506 비단언 정리).
  if (action === undefined) return []
  const defaults = action.defaultBinding
  if (!YIELDING_DEFAULTS.includes(id)) return defaults
  const claimed = claimedByOtherOverrides({ id, overrides })
  return defaults.map((binding) => (claimed.has(binding) ? null : binding))
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
/** 누르고 있어도 한 번만 도는 액션 (LIFE-495 K6ⓔ) — 렌더러 keydown·main 메뉴 키 두 길이 같은 목록을 본다(fix1 R1-06). */
export const NON_REPEATING_ACTIONS: readonly ActionId[] = ['tab.reopenClosed', 'tab.rename', 'terminal.newAgent', 'rightPanel.toggle', 'explorer.show']

/**
 * main `before-input-event` 가 메뉴 가속키에서 가져오는 키 — `⌘W`(File ▸ Close Window)·`⌘R`(View ▸ Reload). 순수 판정.
 * `claimed` 면 main 이 늘 삼킨다(재정의로 비었다고 창 닫기·새로고침으로 되돌아가면 안 된다). `dispatch` 는 렌더러로 보낼 매칭 —
 * 반복(autoRepeat)은 **매칭된 액션**이 `NON_REPEATING_ACTIONS` 면 보내지 않는다(물리 키 기준이 아니다 — ⌘W 를 다시 열기로 재정의해도 한 번).
 */
export function menuKeyShortcut(input: { key: string; code: string; meta: boolean; alt: boolean; control: boolean; shift: boolean; isAutoRepeat: boolean; overrides: Keybindings }): {
  claimed: 'W' | 'R' | null
  dispatch: ShortcutMatch | null
} {
  if (!input.meta || input.alt || input.control || input.shift) return { claimed: null, dispatch: null }
  const lower = input.key.toLowerCase()
  const claimed = input.code === 'KeyW' || lower === 'w' ? 'W' : input.code === 'KeyR' || lower === 'r' ? 'R' : null
  if (claimed === null) return { claimed: null, dispatch: null }
  const match = matchBinding(`Mod+${claimed}`, input.overrides)
  if (match === null || (input.isAutoRepeat && NON_REPEATING_ACTIONS.includes(match.id))) return { claimed, dispatch: null }
  return { claimed, dispatch: match }
}
function findConflict(overrides: Keybindings) {
  const owners = new Map<string, (typeof ACTIONS)[number]>()
  for (const action of ACTIONS) {
    for (const binding of bindingsFor(action.id, overrides)) {
      if (binding === null) continue
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
export function validateOverrides(input: unknown, discardInvalid = false): Keybindings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('단축키 파일은 객체여야 합니다')
  const value = migrateLegacyOverrides(input).value
  const result: Keybindings = {}
  for (const [id, bindings] of Object.entries(value)) {
    const action = ACTIONS.find((row) => row.id === id)
    if (!action) {
      if (discardInvalid) continue
      throw new Error(`알 수 없는 액션: ${id}`)
    }
    const normalized = normalizeSlots(bindings)
    if (normalized === null || normalized.length !== action.defaultBinding.length) {
      if (discardInvalid) continue
      throw new Error(`${action.title}: 올바르지 않은 바인딩`)
    }
    if (JSON.stringify(normalized) !== JSON.stringify(action.defaultBinding)) result[action.id] = normalized
  }
  // 비켜 서는 기본값(YIELDING_DEFAULTS)을 **명시로** 다시 적은 재정의는 남긴다 — 다른 재정의가 그 조합을 쓰면 기본값과 같아도
  // 그냥 버리면 저장이 조용히 무시된다. 남겨 두면 아래 충돌 검사가 잡는다(저장 = 오류 문구, 읽기 = 나중 액션을 버림).
  for (const id of YIELDING_DEFAULTS) {
    const raw: unknown = Reflect.get(value, id)
    const action = ACTIONS.find((row) => row.id === id)
    if (action === undefined || result[id] !== undefined || !Array.isArray(raw) || raw.length !== action.defaultBinding.length) continue
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
