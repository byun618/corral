// 설정 섹션 레지스트리 (LIFE-511 K1ⓒ·K3ⓑ·K5) — 내비·팔레트·검색이 **이 목록 하나**를 본다.
// 그룹 이름·순서는 Orca 198 `settings-navigation-foundations.ts` `SETTINGS_NAV_GROUPS` 그대로(한국어 표기는 Orca ko 로케일 캡처
// 510 `c5-settings/orca-01`·`orca-nav-22`). 섹션이 하나도 없는 그룹은 그리지 않는다 — T6(LIFE-516) 뒤에는 「AI 기능 › 에이전트」 · 「설정 시작 › 일반」 ·
// 「인터페이스 › 외관·단축키」.
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
  // 에이전트 — 198 「AI 기능」 의 첫 섹션(`settings-navigation-capability-sections.ts:36`, 아이콘 Bot). corral 은 「기본 Agent」 하나만(LIFE-515 D4).
  // 설명은 Orca 「AI agents를 관리하고, 기본값을 설정하고, 명령을 사용자 정의하세요.」 에서 corral 에 없는 관리·명령을 뺐다(D5).
  {
    id: 'agents',
    group: 'capabilities',
    title: '에이전트',
    description: 'AI agents의 기본값을 설정하세요.',
    searchEntries: [
      {
        title: '기본 Agent',
        description: '새 에이전트 탭(⌘⌥T)과 탭바 + 메뉴의 맨 앞 에이전트에 쓰입니다.',
        keywords: ['agent', 'agents', 'default', 'default agent', 'new agent tab', 'claude', 'codex', 'grok', 'auto', 'blank', '⌘⌥T', 'cmd+alt+t', '에이전트', '기본', '기본값', '자동', 'agent 없음', '빈 terminal', '새 에이전트 탭'],
      },
    ],
  },
  // 일반 — 198 「설정 시작」 의 섹션(`settings-navigation-capability-sections.ts:177-186`, 아이콘 SlidersHorizontal). corral 은 확인 대화상자 행 셋만(LIFE-516 D6).
  // 설명은 Orca 「워크스페이스 기본값, 앱 설정 및 유지 관리.」 대신 corral 에 있는 것만 말한다. 검색 항목 = 198 탐색·워크스페이스 행 + #21569 행.
  {
    id: 'general',
    group: 'setup',
    title: '일반',
    description: '탭·터미널을 닫거나 워크트리를 삭제하기 전에 묻는 확인 대화상자.',
    searchEntries: [
      { title: '탐색', description: '탭을 닫을 때의 확인.', keywords: ['navigation', '탐색'] },
      { title: '고정된 탭을 닫기 전에 확인', description: '고정된 탭을 닫기 전에 확인 대화상자를 표시합니다.', keywords: ['pinned', 'pin', 'tab', 'confirm', 'close', '고정', '핀', '탭', '닫기', '확인', '다시 묻지'] },
      { title: '실행 중인 터미널을 닫기 전에 확인', description: '터미널을 닫을 때 실행 중인 에이전트나 명령을 중지하기 전에 묻습니다.', keywords: ['terminal', 'agent', 'command', 'running', 'confirm', 'close', '실행 중', '터미널', '에이전트', '명령', '닫기', '확인', '다시 묻지'] },
      { title: '워크스페이스', description: '워크트리를 삭제할 때의 확인.', keywords: ['workspace', 'worktree', '워크스페이스', '워크트리'] },
      { title: '워크트리를 삭제하기 전에 확인', description: '사이드바에서 워크트리를 삭제하기 전에 확인 대화상자를 표시합니다.', keywords: ['delete', 'worktree', 'workspace', 'confirm', 'dialog', 'skip', 'prompt', '삭제', '워크트리', '워크스페이스', '확인', '다시 묻지'] },
    ],
  },
  // 외관 — 198 순서대로 「인터페이스」 의 첫 섹션(단축키보다 위, 198 `settings-navigation-interface-sections.ts`). corral 은 그 안의
  // 「터미널」 카드(LIFE-512)와 「창 및 사이드바」 카드(LIFE-516 S27 — 카드 레이아웃 한 행, D8)가 있다. 인터페이스(앱 테마·줌·IDE 글꼴) 카드는 없다(S30·S19 의도적).
  {
    id: 'appearance',
    group: 'interface',
    title: '외관',
    description: '터미널 글꼴·테마·커서·pane 모양, 사이드바 카드 레이아웃, 상태바 사용량.',
    searchEntries: [
      { title: '터미널', description: '터미널 외관 — 글꼴, 테마, 커서, pane.', keywords: ['terminal', 'appearance', '외관', '터미널', '모양'] },
      { title: '글꼴 크기', description: '새 창 및 라이브 업데이트의 기본 terminal 글꼴 크기입니다.', keywords: ['terminal', 'typography', 'font', 'font size', 'size', '글꼴', '크기', '폰트'] },
      { title: '글꼴군', description: '새 창 및 라이브 업데이트를 위한 기본 terminal 글꼴 모음입니다.', keywords: ['terminal', 'typography', 'font', 'font family', 'family', 'sf mono', 'menlo', 'jetbrains mono', 'fira code', '글꼴', '폰트'] },
      { title: '글꼴 두께', description: 'terminal 텍스트 글꼴 두께를 제어합니다.', keywords: ['terminal', 'typography', 'font weight', 'weight', 'bold', '굵기', '두께', '글꼴'] },
      { title: 'Ghostty에서 가져오기', description: '지원되는 Ghostty terminal 설정을 한 번만 가져옵니다.', keywords: ['ghostty', 'Ghostty', 'import', '가져오기', 'config', '구성', 'terminal', 'settings'] },
      { title: '라인 높이', description: 'terminal 라인 높이 승수를 제어합니다.', keywords: ['terminal', 'typography', 'line height', '줄높이', '줄 높이', '라인'] },
      { title: '터미널 테마', description: '터미널 테마와 구분선 색상을 선택합니다.', keywords: ['terminal', 'theme', 'themes', 'dark', 'color', 'colors', 'preview', '테마', '색', '색상', '미리보기'] },
      { title: '다크 디바이더 색상', description: '어두운 모드에서 창 사이의 분할 구분선을 제어합니다.', keywords: ['terminal', 'divider', 'color', 'pane', '디바이더', '구분선', '색상'] },
      { title: 'Cursor 모양', description: 'terminal 패널의 기본 커서 모양입니다.', keywords: ['terminal', 'cursor', 'bar', 'block', 'underline', 'blink', '커서', '깜박임', '막대', '블록', '밑줄'] },
      { title: '비활성 창 불투명도', description: '현재 활성화되지 않은 창에 불투명도가 적용됩니다.', keywords: ['pane', 'opacity', 'dimming', 'inactive', '투명도', '불투명도', '비활성'] },
      { title: '구분선 두께', description: '창 구분선의 두께입니다.', keywords: ['pane', 'divider', 'thickness', '구분선', '디바이더', '두께'] },
      { title: '창 및 사이드바', description: '사이드바 모양.', keywords: ['window', 'sidebar', 'appearance', '창', '사이드바'] },
      { title: '카드 레이아웃', description: '사이드바의 워크트리 카드를 자세히 또는 간단히 표시합니다.', keywords: ['card', 'card layout', 'layout', 'compact', 'detailed', 'sidebar', 'workspace card', 'worktree card', '카드', '레이아웃', '간단히', '자세히', '사이드바', '워크트리 카드'] },
      // 상태바 (LIFE-636 E9ⓓ) — 「상태바」·「사용량」·usage·provider 이름이 이 카드를 찾는다.
      { title: '상태바', description: '상태바에 보일 provider 사용량.', keywords: ['status bar', 'statusbar', 'usage', 'rate limit', 'limit', 'quota', '상태바', '사용량', '한도', '사용률'] },
      { title: '사용량 표시', description: 'Claude · Codex · Grok 한도 사용률 칩을 켜고 끕니다.', keywords: ['usage', 'claude', 'codex', 'grok', 'anthropic', 'openai', 'xai', 'provider', '사용량', '한도', '칩'] },
    ],
  },
  {
    id: 'shortcuts',
    group: 'interface',
    title: '단축키',
    description: '일반 작업에 대한 키보드 단축키입니다.',
    searchEntries: [
      { title: '키보드 단축키', description: '단축키를 바꾸거나 끄고 기본값으로 되돌립니다.', keywords: ['shortcut', 'shortcuts', 'keybinding', 'keybindings', 'keyboard', 'hotkey', '키', '바인딩', '키보드'] },
    ],
  },
  // Mobile — LIFE-577. 비어 있던 「원격 호스트」 그룹의 첫 섹션(폰이 tailnet 으로 이 맥에 붙는다). 아이콘 lucide Smartphone.
  {
    id: 'mobile',
    group: 'remote',
    title: 'Mobile',
    description: '폰에서 tailnet 으로 이 맥의 corral 에 붙습니다 — Tailscale 점검, 페어링 QR, 기기 관리.',
    searchEntries: [
      { title: 'Mobile 켜기', description: '모바일 서버와 tailscale serve 항목을 켜고 끕니다.', keywords: ['mobile', 'phone', 'iphone', 'android', 'server', 'remote', '모바일', '폰', '휴대폰', '서버', '원격', '켜기'] },
      { title: 'Tailscale 점검', description: 'CLI · 로그인 · HTTPS 인증서 · Funnel 꺼짐.', keywords: ['tailscale', 'tailnet', 'serve', 'funnel', 'https', 'certificate', 'cli', '테일스케일', '인증서', '점검'] },
      { title: '페어링', description: 'QR 과 1회용 코드로 기기를 등록합니다.', keywords: ['pair', 'pairing', 'qr', 'code', 'token', '페어링', '코드', '연결'] },
      { title: '기기', description: '페어링된 기기 목록과 해지.', keywords: ['device', 'devices', 'revoke', '기기', '해지', '목록'] },
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
