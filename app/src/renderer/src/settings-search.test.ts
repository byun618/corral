// LIFE-511 K5ⓓ — 설정 검색 점수(198 settings-search.ts 단계 점수) · 내비 그룹(섹션 있는 그룹만, K3ⓑ).
import { describe, expect, it } from 'vitest'
import { matchesSettingsSearch, rankSettingsSearch, scoreSettingsSearch } from './settings-search.js'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, sectionSearchEntries, settingsNavGroups, settingsSectionById, type SettingsSection } from './settings-registry.js'

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
  // LIFE-577 — 「원격 호스트 › Mobile」 이 더해졌다(그룹 4개).
  it('T6 레지스트리(LIFE-516) + Mobile(LIFE-577): 그룹은 「AI 기능」·「설정 시작」·「인터페이스」·「원격 호스트」, 섹션은 「에이전트」 · 「일반」 · 「외관」·「단축키」 · 「Mobile」 — 198 그룹 순서대로', () => {
    const groups = settingsNavGroups({ query: '' })
    expect(groups.map((group) => group.title)).toEqual(['AI 기능', '설정 시작', '인터페이스', '원격 호스트'])
    expect(groups.map((group) => group.sections.map((section) => section.id))).toEqual([['agents'], ['general'], ['appearance', 'shortcuts'], ['mobile']])
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
    expect(settingsNavGroups({ query: '', sections }).map((group) => group.id)).toEqual(['capabilities', 'setup', 'interface', 'remote'])
    expect(settingsNavGroups({ query: '단축키', sections }).map((group) => group.id)).toEqual(['interface', 'setup'])
  })
  // LIFE-577 A8ⓓ — Mobile 절이 검색에 잡힌다.
  it.each(['mobile', '모바일', 'tailscale', '페어링', 'QR', '기기', 'funnel'])('질의 %s 는 Mobile 섹션을 남긴다', (query) => {
    expect(settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))).toContain('mobile')
  })
  // LIFE-515 K2ⓔ — 기본 Agent 검색 키워드(한·영·에이전트 이름·단축키 기호)로 에이전트 섹션이 걸린다.
  it.each(['에이전트', 'agent', 'Agents', '기본 agent', 'default', '기본값', 'claude', 'Codex', 'grok', '자동', '빈 terminal', '⌘⌥T', '새 에이전트 탭'])('질의 %s 는 에이전트 섹션을 남긴다', (query) => {
    expect(settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))).toContain('agents')
  })
  it('검색 항목의 첫 칸은 섹션 자체다(섹션 제목 점수)', () => {
    expect(sectionSearchEntries(settingsSectionById('shortcuts'))[0]).toEqual({ title: '단축키', description: '일반 작업에 대한 키보드 단축키입니다.' })
    expect(sectionSearchEntries(settingsSectionById('appearance'))[0]).toEqual({ title: '외관', description: '터미널 글꼴·테마·커서·pane 모양과 사이드바 카드 레이아웃.' })
    expect(sectionSearchEntries(settingsSectionById('general'))[0]).toEqual({ title: '일반', description: '탭·터미널을 닫거나 워크트리를 삭제하기 전에 묻는 확인 대화상자.' })
  })
})

describe('외관 섹션 검색 키워드 (LIFE-512 K5ⓒ)', () => {
  it.each(['외관', 'terminal', 'font', 'theme', 'cursor', 'opacity', 'divider', 'line height', '글꼴', '테마', '커서', '투명도', '구분선', '줄높이', 'Appearance'])('질의 %s 는 외관 섹션을 남긴다', (query) => {
    expect(settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))).toContain('appearance')
  })
  it('단축키 질의는 외관을 끌어오지 않는다', () => {
    expect(settingsNavGroups({ query: '단축키' }).flatMap((group) => group.sections.map((section) => section.id))).toEqual(['shortcuts'])
  })
})

describe('Ghostty 가져오기 검색 키워드 (LIFE-513 K8ⓒ)', () => {
  it.each(['ghostty', 'Ghostty', 'import', '가져오기'])('질의 %s 는 외관 섹션을 남긴다', (query) => {
    expect(settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))).toEqual(['appearance'])
  })
})

describe('일반 섹션 검색 키워드 (LIFE-516 K2ⓔ)', () => {
  it.each(['일반', '고정', '핀', 'pinned', '탭', '닫기', '확인', '실행 중', '터미널을 닫기', '삭제', '워크스페이스', '워크트리', '다시 묻지', 'confirm', 'running', 'delete'])('질의 %s 는 일반 섹션을 남긴다', (query) => {
    expect(settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))).toContain('general')
  })
})

describe('외관 › 창 및 사이드바 검색 키워드 (LIFE-516 K6ⓔ)', () => {
  it.each(['카드 레이아웃', '사이드바', '간단히', '자세히', 'compact', 'detailed', 'card layout', '창 및 사이드바'])('질의 %s 는 외관 섹션을 남긴다', (query) => {
    expect(settingsNavGroups({ query }).flatMap((group) => group.sections.map((section) => section.id))).toContain('appearance')
  })
})
