// LIFE-496 K1ⓖ — `+` 드롭다운 순수 계산. Orca v1.4.219 테스트(query-token-match · tab-create-menu-options · tab-agent-launch-options ·
// open-tab-search · QuickLaunchButton)와 같은 상황은 같은 기대값을 쓴다. corral 고유분(한국어 토큰·워치독 판정)은 따로 적는다.
import { describe, expect, it } from 'vitest'
import {
  LAUNCH_WATCHDOG_MS,
  OPEN_TAB_SEARCH_RESULT_LIMIT,
  activeOptionId,
  buildActiveOptions,
  buildAgentLaunchOptions,
  findMatchingAgentLaunchOptions,
  findMatchingMenuOptions,
  launchWatchdogMessage,
  launchWatchdogVerdict,
  normalizeMatchQuery,
  scoreQueryTokens,
  searchOpenTabs,
  selectedIndex,
  showStaticCreateMenu,
  stepSelection,
  stepStaticItem,
  tokenizeMatchValue,
  type OpenTabSearchEntry,
} from './tab-create-menu.js'

const entry = ({ tabId, title, ...extra }: Partial<OpenTabSearchEntry> & { tabId: string; title: string }): OpenTabSearchEntry => ({
  tabId, groupId: 'g1', title, branch: 'main', agent: null, groupIndex: 0, tabIndex: Number(tabId.replace(/\D/g, '')) || 0, isCurrent: false, ...extra,
})

describe('query token match (Orca query-token-match.test.ts)', () => {
  it('대소문자·공백을 접는다', () => {
    expect(normalizeMatchQuery('  New   Terminal ')).toBe('new terminal')
  })
  it('글자·숫자가 아닌 곳에서 자른다', () => {
    expect(tokenizeMatchValue('GitHub Copilot-cli')).toEqual(['github', 'copilot', 'cli'])
  })
  it('한국어도 토큰이 된다 (corral — Orca 는 [a-z0-9] 만)', () => {
    expect(tokenizeMatchValue('새 터미널')).toEqual(['새', '터미널'])
  })
  it('같음 > 접두 > 중간', () => {
    const exact = scoreQueryTokens({ query: 'terminal', values: ['terminal'] })
    const prefix = scoreQueryTokens({ query: 'term', values: ['terminal'] })
    const substring = scoreQueryTokens({ query: 'rmin', values: ['terminal'] })
    expect(exact.score).toBeGreaterThan(prefix.score)
    expect(prefix.score).toBeGreaterThan(substring.score)
    expect(substring.allTokensMatched).toBe(true)
  })
  it('안 맞는 토큰을 알린다', () => {
    expect(scoreQueryTokens({ query: 'new browser', values: ['new terminal'] }).allTokensMatched).toBe(false)
  })
  it('빈 입력은 0', () => {
    expect(scoreQueryTokens({ query: '', values: ['terminal'] })).toEqual({ allTokensMatched: false, score: 0 })
    expect(scoreQueryTokens({ query: 'terminal', values: [] })).toEqual({ allTokensMatched: false, score: 0 })
  })
})

describe('정적 메뉴 매칭 (Orca tab-create-menu-options.test.ts)', () => {
  it('terminal·shell·new terminal → 새 터미널', () => {
    for (const query of ['new terminal', 'terminal', 'shell', 'term', '터미널', '새 터미널'])
      expect(findMatchingMenuOptions({ query }).map((option) => option.id), query).toEqual(['new-terminal'])
  })
  it('browser 는 없다 (corral 에 브라우저 탭이 없다 — 의도적)', () => {
    expect(findMatchingMenuOptions({ query: 'browser' })).toEqual([])
  })
  it('빈 질의는 매칭 없음', () => {
    expect(findMatchingMenuOptions({ query: '   ' })).toEqual([])
  })
})

describe('에이전트 (Orca tab-agent-launch-options.test.ts · agent-catalog 순서)', () => {
  const options = buildAgentLaunchOptions()
  it('카탈로그 순서 claude → codex → grok', () => {
    expect(options.map((option) => option.agent)).toEqual(['claude', 'codex', 'grok'])
    expect(options.map((option) => option.label)).toEqual(['Claude', 'Codex', 'Grok'])
  })
  it('id·라벨·명령으로 맞춘다', () => {
    expect(findMatchingAgentLaunchOptions({ query: 'Claude', options }).map((option) => option.agent)).toEqual(['claude'])
    expect(findMatchingAgentLaunchOptions({ query: 'openai codex', options })).toEqual([])
    expect(findMatchingAgentLaunchOptions({ query: 'grok', options }).map((option) => option.agent)).toEqual(['grok'])
  })
  it('부분 접두로도 찾는다', () => {
    expect(findMatchingAgentLaunchOptions({ query: 'clau', options }).map((option) => option.agent)).toEqual(['claude'])
  })
  it('중간 일치는 안 받는다', () => {
    expect(findMatchingAgentLaunchOptions({ query: 'lau', options })).toEqual([])
  })
  it('한 글자 접두는 안 받는다 — 두 글자부터', () => {
    expect(findMatchingAgentLaunchOptions({ query: 'c', options })).toEqual([])
    expect(findMatchingAgentLaunchOptions({ query: 'co', options }).map((option) => option.agent)).toEqual(['codex'])
  })
})

describe('열린 탭 검색 (Orca open-tab-search · omnibox 필드)', () => {
  it('최대 4건', () => {
    const entries = Array.from({ length: 6 }, (_, index) => entry({ tabId: `t${index}`, title: `build ${index}` }))
    expect(searchOpenTabs({ entries, query: 'build' })).toHaveLength(OPEN_TAB_SEARCH_RESULT_LIMIT)
  })
  it('빈 질의는 결과 없음', () => {
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: 'build' })], query: ' ' })).toEqual([])
  })
  it('제목 전체 일치 > 단어 일치 > 접두 > 중간', () => {
    const entries = [entry({ tabId: 't1', title: 'rebuilding' }), entry({ tabId: 't2', title: 'build logs' }), entry({ tabId: 't3', title: 'build' }), entry({ tabId: 't4', title: 'builder' })]
    expect(searchOpenTabs({ entries, query: 'build' }).map((result) => result.tabId)).toEqual(['t3', 't2', 't4', 't1'])
  })
  it('현재 탭은 숨기지 않고 같은 순위면 앞선다', () => {
    const entries = [entry({ tabId: 't1', title: 'server a' }), entry({ tabId: 't2', title: 'server b', isCurrent: true })]
    expect(searchOpenTabs({ entries, query: 'server' }).map((result) => result.tabId)).toEqual(['t2', 't1'])
  })
  it('같은 순위면 영역 순서 → 탭 순서', () => {
    const entries = [entry({ tabId: 't5', title: 'dev', groupId: 'g2', groupIndex: 1, tabIndex: 0 }), entry({ tabId: 't9', title: 'dev', groupIndex: 0, tabIndex: 3 })]
    expect(searchOpenTabs({ entries, query: 'dev' }).map((result) => result.tabId)).toEqual(['t9', 't5'])
  })
  it('"terminal" 은 별칭으로 모든 터미널 탭에 맞는다 (Orca TERMINAL_TYPE_SEARCH_ALIASES)', () => {
    const entries = [entry({ tabId: 't1', title: 'claude' }), entry({ tabId: 't2', title: 'zsh' })]
    expect(searchOpenTabs({ entries, query: 'terminal' }).map((result) => result.tabId)).toEqual(['t1', 't2'])
  })
  it('별칭은 접두로도 맞는다 — "term"·"termin" 으로 열린 터미널 탭을 찾는다 (R1-03, Orca EXACT_ALIAS_QUALITIES)', () => {
    const entries = [entry({ tabId: 't1', title: 'alpha-build' }), entry({ tabId: 't2', title: 'beta' })]
    expect(searchOpenTabs({ entries, query: 'term' }).map((result) => result.tabId)).toEqual(['t1', 't2'])
    expect(searchOpenTabs({ entries, query: 'termin' }).map((result) => result.tabId)).toEqual(['t1', 't2'])
    // 중간 일치는 별칭에서 받지 않는다(field-exact·word-exact·field-prefix·word-prefix 만).
    expect(searchOpenTabs({ entries, query: 'rmin' })).toEqual([])
  })
  it('한 글자 라틴 문자·숫자 질의는 같음·접두만 받는다 — 중간 한 글자는 안 맞는다 (R2-05, Orca match-field SHORT_TOKEN_QUALITIES)', () => {
    const entries = [entry({ tabId: 't1', title: 'alpha-build' }), entry({ tabId: 't2', title: 'beta' }), entry({ tabId: 't3', title: 'notes v2' })]
    expect(searchOpenTabs({ entries, query: 'a' }).map((result) => result.tabId)).toEqual(['t1'])
    expect(searchOpenTabs({ entries, query: 'b' }).map((result) => result.tabId)).toEqual(['t2', 't1'])
    // 문자↔숫자 경계에서 단어가 갈린다(Orca text-segments) — "v2" 의 "2" 는 단어 시작이다(R3-04).
    expect(searchOpenTabs({ entries, query: '2' }).map((result) => result.tabId)).toEqual(['t3'])
    expect(searchOpenTabs({ entries, query: 'v' }).map((result) => result.tabId)).toEqual(['t3'])
  })
  it('한 글자 질의의 단어 경계 — 원문 camelCase 경계와 문자↔숫자 경계를 지킨다 (R3-04, Orca text-segments.ts)', () => {
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: 'fooBar' }), entry({ tabId: 't2', title: 'foobar' })], query: 'b' }).map((result) => result.tabId)).toEqual(['t1'])
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: 'task2' }), entry({ tabId: 't2', title: 'task-2' }), entry({ tabId: 't3', title: '2task' }), entry({ tabId: 't4', title: 'x22' })], query: '2' }).map((result) => result.tabId).sort()).toEqual(['t1', 't2', 't3', 't4'])
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: 'abc' })], query: 'b' })).toEqual([])
  })
  it('결합 문자 제목은 NFC 로 합쳐서 본다 — é 로 찾고, 결합 문자 뒤 글자를 단어 시작으로 보지 않는다 (R4-03, Orca normalized-text.ts)', () => {
    const decomposed = (text: string): string => text.normalize('NFD')
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: decomposed('éclair') })], query: 'é' }).map((result) => result.tabId)).toEqual(['t1'])
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: decomposed('fooÉclair') })], query: 'é' }).map((result) => result.tabId)).toEqual(['t1'])
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: decomposed('éclair') })], query: 'c' })).toEqual([])
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: decomposed('ábar') })], query: 'b' })).toEqual([])
  })
  it('전체 NFC 는 Orca 219 와의 의도적 차이다 — 분해형 한글 제목을 완성형으로 찾고, 조합 자모 하나로는 찾지 않는다 (R5-02, RESULT D-목록)', () => {
    const decomposedTitle = '\u1100\u1161\u1102\u1161\u1103\u1161' // 가나다 (macOS 경로 이름처럼 NFD)
    const found = (query: string): string[] => searchOpenTabs({ entries: [entry({ tabId: 't1', title: decomposedTitle })], query }).map((result) => result.tabId)
    expect(found('\uAC00')).toEqual(['t1']) // 완성형 가 — Orca 219 제외, corral 포함
    expect(found('\u1100\u1161')).toEqual(['t1']) // 분해형 가 — Orca 219 제외, corral 포함
    expect(found('\u1100')).toEqual([]) // 조합 자모 ᄀ — Orca 219 포함, corral 제외(대가)
  })
  it('브랜치(컨테이너)·에이전트로도 찾되 제목 일치가 앞선다', () => {
    const entries = [entry({ tabId: 't1', title: 'logs', agent: 'claude' }), entry({ tabId: 't2', title: 'claude notes' })]
    expect(searchOpenTabs({ entries, query: 'claude' }).map((result) => result.tabId)).toEqual(['t2', 't1'])
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: 'logs', branch: 'feature-x' })], query: 'feature' }).map((result) => result.tabId)).toEqual(['t1'])
  })
  it('모든 토큰이 어딘가에 맞아야 한다', () => {
    expect(searchOpenTabs({ entries: [entry({ tabId: 't1', title: 'build logs' })], query: 'build deploy' })).toEqual([])
  })
  it('키보드로 고른 행은 상한 밖이어도 남긴다 (Orca capPaletteSection)', () => {
    const entries = Array.from({ length: 6 }, (_, index) => entry({ tabId: `t${index}`, title: `build ${index}` }))
    const results = searchOpenTabs({ entries, query: 'build', retainedResultId: 'tab:t5' })
    expect(results).toHaveLength(OPEN_TAB_SEARCH_RESULT_LIMIT)
    expect(results.at(-1)?.tabId).toBe('t5')
  })
})

describe('결과 조립·선택 (Orca TabBarCreateEntry)', () => {
  const agents = buildAgentLaunchOptions()
  it('열린 탭 → 메뉴 매칭 → 에이전트 매칭 순', () => {
    const options = buildActiveOptions({ query: 'terminal', entries: [entry({ tabId: 't1', title: 'claude' })], agents })
    expect(options.map(activeOptionId)).toEqual(['tab:t1', 'menu:new-terminal'])
    const withAgent = buildActiveOptions({ query: 'claude', entries: [entry({ tabId: 't1', title: 'claude' })], agents })
    expect(withAgent.map(activeOptionId)).toEqual(['tab:t1', 'agent:claude'])
  })
  it('빈 질의는 결과 없음 + 정적 메뉴가 보인다', () => {
    expect(buildActiveOptions({ query: '', entries: [entry({ tabId: 't1', title: 'claude' })], agents })).toEqual([])
    expect(showStaticCreateMenu('')).toBe(true)
    expect(showStaticCreateMenu('  ')).toBe(true)
    expect(showStaticCreateMenu('x')).toBe(false)
  })
  it('선택 = 고정 행이 있으면 그것, 아니면 첫 행', () => {
    const options = buildActiveOptions({ query: 'claude', entries: [entry({ tabId: 't1', title: 'claude' })], agents })
    expect(selectedIndex({ options, pinnedId: null })).toBe(0)
    expect(selectedIndex({ options, pinnedId: 'agent:claude' })).toBe(1)
    expect(selectedIndex({ options, pinnedId: 'tab:gone' })).toBe(0)
    expect(selectedIndex({ options: [], pinnedId: null })).toBeNull()
  })
  it('↑/↓ 는 감긴다', () => {
    expect(stepSelection({ count: 3, current: 2, delta: 1 })).toBe(0)
    expect(stepSelection({ count: 3, current: 0, delta: -1 })).toBe(2)
    expect(stepSelection({ count: 3, current: null, delta: 1 })).toBe(0)
    expect(stepSelection({ count: 3, current: null, delta: -1 })).toBe(2)
    expect(stepSelection({ count: 0, current: null, delta: 1 })).toBeNull()
  })
  it('정적 메뉴 안에서는 끝에서 멈춘다 (Radix 기본)', () => {
    expect(stepStaticItem({ count: 4, current: 3, delta: 1 })).toBe(3)
    expect(stepStaticItem({ count: 4, current: 0, delta: -1 })).toBe(0)
    expect(stepStaticItem({ count: 4, current: 1, delta: 1 })).toBe(2)
  })
})

describe('기동 워치독 판정 (Orca QuickLaunchButton 조건의 corral 등가물)', () => {
  const watch = { paneId: 'w1:p2', workspaceId: 'w1', label: 'Claude' }
  it('에이전트가 오면 성공', () => {
    expect(launchWatchdogVerdict({ watch, pane: { workspaceId: 'w1', agent: 'claude' }, activeWorkspaceId: 'w1' })).toBe('detected')
  })
  it('탭이 닫혔으면 알리지 않는다', () => {
    expect(launchWatchdogVerdict({ watch, pane: null, activeWorkspaceId: 'w1' })).toBe('gone')
  })
  it('pane 이 다른 workspace 로 갔으면 알리지 않는다', () => {
    expect(launchWatchdogVerdict({ watch, pane: { workspaceId: 'w2', agent: null }, activeWorkspaceId: 'w2' })).toBe('gone')
  })
  it('사용자가 다른 worktree 를 보고 있으면 알리지 않는다', () => {
    expect(launchWatchdogVerdict({ watch, pane: { workspaceId: 'w1', agent: null }, activeWorkspaceId: 'w3' })).toBe('elsewhere')
  })
  it('같은 worktree 에서 에이전트가 없으면 missing', () => {
    expect(launchWatchdogVerdict({ watch, pane: { workspaceId: 'w1', agent: null }, activeWorkspaceId: 'w1' })).toBe('missing')
  })
  it('시간·문구', () => {
    expect(LAUNCH_WATCHDOG_MS).toBe(10_000)
    expect(launchWatchdogMessage('Claude')).toContain('Claude 실행 실패')
    expect(launchWatchdogMessage('Claude')).toContain('10초')
  })
})
