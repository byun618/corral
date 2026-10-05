// 설정 섹션 레지스트리 (LIFE-511 K1ⓒ·K3ⓑ·K5) — 내비·팔레트·검색이 **이 목록 하나**를 본다.
// 그룹 이름·순서는 Orca 198 `settings-navigation-foundations.ts` `SETTINGS_NAV_GROUPS` 그대로(한국어 표기는 Orca ko 로케일 캡처
// 510 `c5-settings/orca-01`·`orca-nav-22`). 섹션이 하나도 없는 그룹은 그리지 않는다 — T1 직후에는 「인터페이스 › 단축키」 하나.
// 섹션을 더하는 일감(T2~)은 `SETTINGS_SECTIONS` 에 한 줄을 더하고 `SettingsPage` 의 본문 분기에 컴포넌트를 단다.
import { rankSettingsSearch, type SettingsSearchEntry } from './settings-search.js'

export const SETTINGS_GROUPS = [
  { id: 'capabilities', title: 'AI 기능' },
  { id: 'setup', title: '설정 시작' },
  { id: 'workflows', title: '워크플로' },
  { id: 'interface', title: '인터페이스' },
  { id: 'remote', title: '원격 호스트' },
  { id: 'security', title: '개인정보 및 보안' },
  { id: 'advanced', title: '고급' },
  { id: 'experimental', title: '실험적 기능' },
] as const
export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id']

export type SettingsSection = {
  id: SettingsSectionId
  group: SettingsGroupId
  title: string
  description: string
  /** 내비 행 오른쪽 배지(198 「베타」·「Dev」 자리, K3ⓐ). T1 섹션은 없다. */
  badge?: string
  /** 섹션 안 항목들 — 검색이 섹션 제목 다음 단계로 본다(정적 키워드, K5ⓐ). */
  searchEntries: readonly SettingsSearchEntry[]
}

export const SETTINGS_SECTIONS = [
  {
    id: 'shortcuts',
    group: 'interface',
    title: '단축키',
    description: '일반 작업에 대한 키보드 단축키입니다.',
    searchEntries: [
      { title: '키보드 단축키', description: '단축키를 바꾸거나 끄고 기본값으로 되돌립니다.', keywords: ['shortcut', 'shortcuts', 'keybinding', 'keybindings', 'keyboard', 'hotkey', '키', '바인딩', '키보드'] },
    ],
  },
] as const satisfies readonly { id: string; group: SettingsGroupId; title: string; description: string; searchEntries: readonly SettingsSearchEntry[] }[]
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'shortcuts'

/** 검색이 보는 항목 — 첫 항목이 섹션 자체(제목·설명)라 섹션 제목 점수를 받는다. */
export function sectionSearchEntries(section: SettingsSection): SettingsSearchEntry[] {
  return [{ title: section.title, description: section.description }, ...section.searchEntries]
}

export type SettingsNavGroup = { id: SettingsGroupId; title: string; sections: SettingsSection[] }

/**
 * 내비에 그릴 그룹 — 섹션이 있는 그룹만, 질의가 맞는 섹션만(K3ⓑ·K5ⓐ).
 * 질의가 비면 그룹 순서·섹션 순서 그대로. 질의가 있으면 점수가 높은 섹션이 속한 그룹이 먼저 온다(Orca `getSettingsNavGroupDefinitionsForSearch`).
 */
export function settingsNavGroups(input: { query: string; sections?: readonly SettingsSection[] }): SettingsNavGroup[] {
  const ranked = rankSettingsSearch({ query: input.query, items: input.sections ?? SETTINGS_SECTIONS, entriesOf: sectionSearchEntries })
  const groupOrder = input.query.trim() === '' ? SETTINGS_GROUPS.map((group) => group.id) : [...new Set(ranked.map((section) => section.group))]
  return groupOrder.flatMap((id) => {
    const sections = ranked.filter((section) => section.group === id)
    if (sections.length === 0) return []
    const group = SETTINGS_GROUPS.find((row) => row.id === id)!
    return [{ id, title: group.title, sections }]
  })
}

export function settingsSectionById(id: SettingsSectionId): SettingsSection {
  return SETTINGS_SECTIONS.find((section) => section.id === id)!
}
