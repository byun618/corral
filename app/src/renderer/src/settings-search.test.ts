// LIFE-511 K5ⓓ — 설정 검색 점수(198 settings-search.ts 단계 점수) · 내비 그룹(섹션 있는 그룹만, K3ⓑ).
import { describe, expect, it } from 'vitest'
import { matchesSettingsSearch, rankSettingsSearch, scoreSettingsSearch } from './settings-search.js'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, sectionSearchEntries, settingsNavGroups, type SettingsSection } from './settings-registry.js'

describe('scoreSettingsSearch — 섹션 제목 > 항목 제목 > 설명 > 키워드, 단계마다 일치 > 접두 > 포함', () => {
  const entries = [{ title: '단축키', description: '일반 작업에 대한 키보드 단축키입니다.' }, { title: '키보드 단축키', description: '단축키를 바꿉니다', keywords: ['shortcut', 'keybinding'] }]
  it.each([
    ['단축키', 900],
    ['단축', 850],
    ['축키', 800],
    ['키보드 단축키', 700],
    ['키보드', 650],
    ['일반 작업', 450],
    ['shortcut', 300],
    ['keybind', 250],
    ['binding', 200],
    ['SHORTCUT', 300],
    ['  단축키  ', 900],
  ])('%s → %i', (query, score) => {
    expect(scoreSettingsSearch({ query, entries })).toBe(score)
  })
  it('빈 질의는 1(모두 보인다), 맞지 않으면 0', () => {
    expect(scoreSettingsSearch({ query: '', entries })).toBe(1)
    expect(scoreSettingsSearch({ query: '   ', entries })).toBe(1)
    expect(scoreSettingsSearch({ query: '터미널', entries })).toBe(0)
    expect(matchesSettingsSearch({ query: 'zzz', entries })).toBe(false)
  })
  it('순위 — 점수 내림차순, 같으면 원래 순서. 0 점은 빠진다', () => {
    const items = [{ name: 'a', entries: [{ title: '외관' }] }, { name: 'b', entries: [{ title: '단축키' }] }, { name: 'c', entries: [{ title: '알림', keywords: ['단축키'] }] }]
    expect(rankSettingsSearch({ query: '단축키', items, entriesOf: (item) => item.entries }).map((item) => item.name)).toEqual(['b', 'c'])
    expect(rankSettingsSearch({ query: '', items, entriesOf: (item) => item.entries }).map((item) => item.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('settingsNavGroups — 섹션이 있는 그룹만(K3ⓑ)', () => {
  it('T1 레지스트리: 그룹은 「인터페이스」 하나, 섹션은 「단축키」 하나', () => {
    const groups = settingsNavGroups({ query: '' })
    expect(groups.map((group) => group.title)).toEqual(['인터페이스'])
    expect(groups[0]!.sections.map((section) => section.id)).toEqual(['shortcuts'])
    // 레지스트리의 그룹은 198 순서 8개 그대로 — 빈 그룹은 그리지 않을 뿐이다.
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual(['capabilities', 'setup', 'workflows', 'interface', 'remote', 'security', 'advanced', 'experimental'])
  })
  it.each(['단축키', 'shortcut', 'keybinding', '키보드', 'HOTKEY'])('한·영 질의 %s 는 단축키 섹션을 남긴다', (query) => {
    expect(settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))).toEqual(['shortcuts'])
  })
  it('맞는 섹션이 없으면 그룹도 없다(결과 없음 상태)', () => {
    expect(settingsNavGroups({ query: '존재하지 않는 설정' })).toEqual([])
  })
  it('섹션이 여럿이면 빈 그룹을 건너뛰고 198 그룹 순서를 지킨다 · 질의가 있으면 점수 높은 섹션의 그룹이 먼저', () => {
    const sections: SettingsSection[] = [
      ...SETTINGS_SECTIONS,
      // 가상 섹션 — 레지스트리에 섹션을 더했을 때의 모양만 본다(제품 레지스트리는 건드리지 않는다).
      { id: 'shortcuts', group: 'setup', title: '일반', description: '앱 설정', searchEntries: [{ title: '탭 순서', keywords: ['단축키 힌트'] }] },
    ]
    expect(settingsNavGroups({ query: '', sections }).map((group) => group.id)).toEqual(['setup', 'interface'])
    expect(settingsNavGroups({ query: '단축키', sections }).map((group) => group.id)).toEqual(['interface', 'setup'])
  })
  it('검색 항목의 첫 칸은 섹션 자체다(섹션 제목 점수)', () => {
    expect(sectionSearchEntries(SETTINGS_SECTIONS[0])[0]).toEqual({ title: '단축키', description: '일반 작업에 대한 키보드 단축키입니다.' })
  })
})
