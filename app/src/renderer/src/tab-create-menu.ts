// LIFE-496 T4 — 탭바 `+` 드롭다운의 순수 계산 (검색·정렬·결과 조립·키보드 이동·기동 워치독 판정).
//
// 기준 = Orca v1.4.219 (`~/repos/etc/orca` @ e3cb32791e, `src/renderer/src/components/tab-bar/`):
//   · 토큰 매칭 `query-token-match.ts` · 메뉴 매칭 `tab-create-menu-options.ts` · 에이전트 매칭 `tab-agent-launch-options.ts`
//   · 열린 탭 검색 `open-tab-search.ts`(최대 4건) + `lib/workspace-tab-palette-results.ts`(omnibox 필드 모드)
//   · 결과 순서 `TabBarCreateEntry.tsx` — 열린 탭 → 메뉴 매칭 → 에이전트 매칭(→ 파일·URL·히스토리는 corral 에 없다, 의도적)
//   · 워치독 `QuickLaunchButton.tsx` `waitForTerminalPty` — 대상만 corral 등가물로 바뀐다(아래 `launchWatchdogVerdict`).
//
// 의도적 차이 (RESULT.md 에 같은 목록):
//   · 토큰은 `[^a-z0-9]` 가 아니라 `[^\p{L}\p{N}]` 로 가른다 — corral 문구가 한국어라 Orca 규칙이면 "터미널" 이 토큰이 안 된다.
//   · 열린 탭 정렬은 Orca palette-match 엔진(약 2천 줄)을 옮기지 않고 그 **순위 키 순서**만 따른다:
//     목적지(제목 전체 일치 → 제목만으로 → 섞임 → 별칭·에이전트만) → 가장 약한 토큰 품질 → 컨테이너만 맞은 토큰 수 → 강도 → 자리(접두 → 단어 경계 → 그 밖)
//     → 위치(현재 탭 → 영역 순서·탭 순서) → id. 오타·compact 복구와 활동 시각 버킷은 없다(corral 탭에 활동 시각이 없다).

import type { DefaultAgent } from '../../shared/terminal-settings.js'
import type { AgentKind } from '../../shared/types.js'

// ── 토큰 매칭 (Orca query-token-match.ts) ─────────────────────────────────────────────

/** 결합 문자는 NFC 로 합친 뒤 비교한다(Orca normalized-text.ts:26 — `e` + U+0301 은 `é` 한 글자). */
export function normalizeMatchQuery(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

export function tokenizeMatchValue(value: string): string[] {
  return normalizeMatchQuery(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** 질의 토큰마다 가장 잘 맞는 후보 토큰 — 같음 3 · 접두 2 · 중간 1. */
export function scoreQueryTokens({ query, values }: { query: string; values: readonly string[] }): { allTokensMatched: boolean; score: number } {
  const candidateTokens = values.flatMap(tokenizeMatchValue)
  const queryTokens = tokenizeMatchValue(query)
  if (candidateTokens.length === 0 || queryTokens.length === 0) return { allTokensMatched: false, score: 0 }
  let score = 0
  let allTokensMatched = true
  for (const queryToken of queryTokens) {
    let best = 0
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) best = Math.max(best, 3)
      else if (candidateToken.startsWith(queryToken)) best = Math.max(best, 2)
      else if (candidateToken.includes(queryToken)) best = Math.max(best, 1)
    }
    if (best === 0) allTokensMatched = false
    score += best
  }
  return { allTokensMatched, score }
}

// ── 정적 생성 메뉴 (Orca tab-create-menu-options.ts — corral 은 New Terminal 하나) ─────────

export type TabCreateMenuOption = { id: 'new-terminal'; label: string; keywords: readonly string[] }

/** Browser·Markdown·Simulator·Windows 셸 갈래는 corral 에 없다(의도적). 영어 키워드는 Orca 그대로, 한국어를 더한다. */
export const TAB_CREATE_MENU_OPTIONS: readonly TabCreateMenuOption[] = [
  { id: 'new-terminal', label: '새 터미널', keywords: ['terminal', 'shell', 'new terminal', 'new shell', '터미널', '셸', '새 셸'] },
]

function scoreMenuOption({ normalizedQuery, option }: { normalizedQuery: string; option: TabCreateMenuOption }): number {
  const normalizedLabel = normalizeMatchQuery(option.label)
  if (normalizedQuery === normalizedLabel) return 100
  const tokenMatch = scoreQueryTokens({ query: normalizedQuery, values: [option.label, ...option.keywords] })
  if (!tokenMatch.allTokensMatched) return 0
  if (normalizedLabel.includes(normalizedQuery) || normalizedQuery.includes(normalizedLabel)) return 80 + tokenMatch.score
  return tokenMatch.score
}

export function findMatchingMenuOptions({ query, options = TAB_CREATE_MENU_OPTIONS }: { query: string; options?: readonly TabCreateMenuOption[] }): TabCreateMenuOption[] {
  const normalizedQuery = normalizeMatchQuery(query)
  if (!normalizedQuery) return []
  return options
    .map((option, index) => ({ index, option, score: scoreMenuOption({ normalizedQuery, option }) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (left.score !== right.score ? right.score - left.score : left.index - right.index))
    .map((entry) => entry.option)
}

// ── 에이전트 (Orca lib/agent-catalog.ts 순서 · tab-agent-launch-options.ts 매칭) ─────────────

export type LaunchAgent = Exclude<AgentKind, 'shell'>
export type AgentLaunchOption = { agent: LaunchAgent; label: string; aliases: readonly string[] }

/**
 * 카탈로그 순서 claude → codex → grok (Orca `agent-catalog.tsx:36,57,63`). 고정 3종 — 감지는 없다(LIFE-515 D1·D3, 감지는 후속 LIFE-520).
 * 기본 에이전트(LIFE-515)는 이 순서를 바꾸지 않고 빈 질의 Quick-launch 에서만 맨 앞으로 옮긴다(`orderAgentLaunchOptions`).
 */
type AgentCatalogEntry = { agent: LaunchAgent; label: string; cmd: string }
// 비어 있지 않은 튜플 — 자동(D1)이 첫 항목을 단언 없이 꺼낸다(fix1 R1-03).
const AGENT_CATALOG: readonly [AgentCatalogEntry, ...AgentCatalogEntry[]] = [
  { agent: 'claude', label: 'Claude', cmd: 'claude' },
  { agent: 'codex', label: 'Codex', cmd: 'codex' },
  { agent: 'grok', label: 'Grok', cmd: 'grok' },
]

const compactAlias = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/g, '')

export function buildAgentLaunchOptions(): AgentLaunchOption[] {
  return AGENT_CATALOG.map(({ agent, label, cmd }) => ({
    agent,
    label,
    aliases: [...new Set([agent, label.toLowerCase(), compactAlias(agent), compactAlias(label), cmd, compactAlias(cmd)])],
  }))
}

// ── 기본 에이전트 (LIFE-515 — Orca 198 `QuickLaunchButton.orderAgents`·`agent-tab-shortcuts.resolveDefaultAgentForNewTab`·`pickTuiAgent`) ──

/** ⌘⌥T 가 여는 탭 — 에이전트 탭(`launchAgent`, 워치독 포함) 또는 빈 터미널 탭(`createShell`, ⌘T 와 같은 결과). */
export type NewAgentTabTarget = { kind: 'agent'; agent: LaunchAgent } | { kind: 'shell' }

/**
 * 기본 에이전트 → ⌘⌥T 대상. 순수 함수(K3ⓑ).
 *   · 명시 에이전트 → 그 에이전트
 *   · 자동 → **카탈로그 첫 번째**(D1 — 감지가 없어 Orca `pickTuiAgent` 의 「감지·활성 중 첫 번째」 가 카탈로그 첫 번째가 된다)
 *   · agent 없음 → **빈 터미널**(D2 — Orca 는 이 값을 무시하고 자동으로 떨어진다. corral 에는 「새 workspace 를 agent 없이」 소비처가 없어
 *     Orca 의미면 이 값이 순서에만 걸리는 죽은 선택지가 된다 — 00-analysis §4)
 */
export function resolveNewAgentTab(defaultAgent: DefaultAgent): NewAgentTabTarget {
  switch (defaultAgent) {
    case 'auto':
      return { kind: 'agent', agent: AGENT_CATALOG[0].agent }
    case 'blank':
      return { kind: 'shell' }
    case 'claude':
    case 'codex':
    case 'grok':
      return { kind: 'agent', agent: defaultAgent }
  }
}

/** 명시 기본 에이전트 — 자동·agent 없음이면 null. Quick-launch 순서·칩이 이것만 본다(Orca `orderAgents`·`showsDefaultAgentShortcut`). */
export function explicitDefaultAgent(defaultAgent: DefaultAgent): LaunchAgent | null {
  switch (defaultAgent) {
    case 'auto':
    case 'blank':
      return null
    case 'claude':
    case 'codex':
    case 'grok':
      return defaultAgent
  }
}

/** 빈 질의 Quick-launch 순서 — 명시 기본 에이전트가 맨 앞, 나머지는 카탈로그 순서(Orca `orderAgents`, K4ⓐ). 검색 결과 순서에는 쓰지 않는다(K4ⓓ). */
export function orderAgentLaunchOptions({ options, defaultAgent }: { options: readonly AgentLaunchOption[]; defaultAgent: DefaultAgent }): AgentLaunchOption[] {
  const preferred = explicitDefaultAgent(defaultAgent)
  const first = options.find((option) => option.agent === preferred)
  if (first === undefined) return [...options]
  return [first, ...options.filter((option) => option !== first)]
}

/** 정확한 별칭 1000. 그 밖에는 질의 토큰마다 같음 3 · 접두 2(2글자 이상만 — 한 글자 접두는 거의 모든 에이전트에 걸린다). 중간 일치는 안 받는다. */
function scoreAgentLaunchOption({ normalizedQuery, compactQuery, option }: { normalizedQuery: string; compactQuery: string; option: AgentLaunchOption }): number {
  if (option.aliases.includes(normalizedQuery) || option.aliases.includes(compactQuery)) return 1000
  const candidateTokens = option.aliases.flatMap(tokenizeMatchValue)
  const queryTokens = tokenizeMatchValue(normalizedQuery)
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0
  let score = 0
  for (const queryToken of queryTokens) {
    let best = 0
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) best = Math.max(best, 3)
      else if (queryToken.length >= 2 && candidateToken.startsWith(queryToken)) best = Math.max(best, 2)
    }
    if (best === 0) return 0
    score += best
  }
  return score
}

export function findMatchingAgentLaunchOptions({ query, options }: { query: string; options: readonly AgentLaunchOption[] }): AgentLaunchOption[] {
  const normalizedQuery = normalizeMatchQuery(query)
  if (!normalizedQuery) return []
  const compactQuery = compactAlias(query)
  return options
    .map((option, index) => ({ index, option, score: scoreAgentLaunchOption({ normalizedQuery, compactQuery, option }) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (left.score !== right.score ? right.score - left.score : left.index - right.index))
    .map((entry) => entry.option)
}

// ── 열린 탭 검색 (Orca open-tab-search.ts · workspace-tab-palette-results.ts omnibox) ───────────

export const OPEN_TAB_SEARCH_RESULT_LIMIT = 4

/** 검색 대상 탭 하나 — **현재 worktree 의 모든 영역**에서 모은다(Orca: 한 worktree). */
export type OpenTabSearchEntry = {
  tabId: string
  groupId: string
  /** 화면 탭과 같은 제목(`sessionTitle`). */
  title: string
  /** worktree 브랜치 — Orca omnibox 가 허용하는 컨테이너 필드(worktree·repo 이름은 omnibox 에서 뺀다). */
  branch: string | null
  /** 탭을 차지한 에이전트(행 아이콘·에이전트 증거 매칭). 셸이면 null. */
  agent: string | null
  groupIndex: number
  tabIndex: number
  /** 활성 영역의 활성 탭 — Orca 는 현재 탭을 숨기지 않고 위치 점수에서 앞세운다. */
  isCurrent: boolean
}

export type OpenTabSearchResult = { id: string; tabId: string; groupId: string; title: string; agent: string | null }

/** Orca `TERMINAL_TYPE_SEARCH_ALIASES` — 행에는 안 쓰고 검색에만 쓴다. */
const TERMINAL_TYPE_ALIASES = ['terminal tab', 'terminal', '터미널'] as const

/** 토큰 품질 — 좋은 순(Orca match-quality.ts 앞 6단계). */
const QUALITY = { fieldExact: 0, wordExact: 1, fieldPrefix: 2, wordPrefix: 3, boundary: 4, literal: 5 } as const
type FieldRole = 'primary' | 'container' | 'alias' | 'evidence'

/** Orca palette-query `LATIN_OR_DIGIT` — 한 글자 라틴 문자·숫자. */
const SINGLE_LATIN_OR_DIGIT = /^[\p{Script=Latin}\p{Nd}]$/u

/**
 * Orca text-segments.ts `splitComponentIntoWords` — 글자·숫자 덩어리를 문자↔숫자 경계와 원문 camelCase 경계(대문자 앞이 대문자가 아님)에서 더 나눈다.
 * 한 글자 질의의 같음·접두 판정에만 쓴다(엔진 전체를 옮기지 않는다).
 */
function segmentWords(text: string): string[] {
  const words: string[] = []
  for (const run of text.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = [...run]
    let start = 0
    for (let index = 1; index < chars.length; index += 1) {
      const previous = chars[index - 1]!
      const current = chars[index]!
      const classChanged = (/\p{L}/u.test(previous) && /\p{N}/u.test(current)) || (/\p{N}/u.test(previous) && /\p{L}/u.test(current))
      const camel = /\p{Lu}/u.test(current) && !/\p{Lu}/u.test(previous)
      if (classChanged || camel) {
        words.push(chars.slice(start, index).join('').toLowerCase())
        start = index
      }
    }
    words.push(chars.slice(start).join('').toLowerCase())
  }
  return words
}

function tokenQuality({ token, fieldText }: { token: string; fieldText: string }): { quality: number; placement: number } | null {
  const field = normalizeMatchQuery(fieldText)
  if (!field) return null
  if (field === token) return { quality: QUALITY.fieldExact, placement: 0 }
  const words = tokenizeMatchValue(field)
  const wordIndex = words.indexOf(token)
  if (wordIndex >= 0) return { quality: QUALITY.wordExact, placement: wordIndex === 0 ? 0 : 1 }
  if (field.startsWith(token)) return { quality: QUALITY.fieldPrefix, placement: 0 }
  const prefixIndex = words.findIndex((word) => word.startsWith(token))
  if (prefixIndex >= 0) return { quality: QUALITY.wordPrefix, placement: prefixIndex === 0 ? 0 : 1 }
  // 한 글자 라틴 문자·숫자는 같음·접두만 받는다(Orca match-field.ts `SHORT_TOKEN_QUALITIES`, palette-query `isSingleLatinCharacter`, r2 R2-05).
  // 단어는 Orca text-segments 처럼 원문 camelCase 경계와 문자↔숫자 경계에서도 갈린다(`fooBar` 의 b · `notes v2` 의 2 — r3 R3-04).
  if (SINGLE_LATIN_OR_DIGIT.test(token)) {
    const segments = segmentWords(fieldText)
    const segmentIndex = segments.findIndex((word) => word.startsWith(token))
    if (segmentIndex < 0) return null
    return { quality: segments[segmentIndex] === token ? QUALITY.wordExact : QUALITY.wordPrefix, placement: segmentIndex === 0 ? 0 : 1 }
  }
  const at = field.indexOf(token)
  if (at < 0) return null
  const before = field.charAt(at - 1)
  const boundary = !/[\p{L}\p{N}]/u.test(before)
  return { quality: boundary ? QUALITY.boundary : QUALITY.literal, placement: 2 }
}

type TabRank = { destination: number; worstQuality: number; containerOnly: number; strength: number; placement: number }

export function rankOpenTab({ entry, query }: { entry: OpenTabSearchEntry; query: string }): TabRank | null {
  const tokens = [...new Set(tokenizeMatchValue(query))]
  if (tokens.length === 0) return null
  const fields: { role: FieldRole; text: string }[] = [
    { role: 'primary', text: entry.title },
    { role: 'container', text: entry.branch ?? '' },
    ...TERMINAL_TYPE_ALIASES.map((text) => ({ role: 'alias' as const, text })),
    { role: 'evidence', text: entry.agent ?? '' },
  ]
  let worstQuality = 0
  let strength = 0
  let containerOnly = 0
  let onTitle = 0
  let placement = 0
  let viaAliasOrEvidence = 0
  for (const token of tokens) {
    let best: { quality: number; placement: number; role: FieldRole } | null = null
    for (const field of fields) {
      const hit = tokenQuality({ token, fieldText: field.text })
      if (hit === null) continue
      // 별칭은 exact-alias 프로필 — 같음·단어 같음·접두·단어 접두까지 받고 중간 일치는 안 받는다
      // (Orca indexed-field.ts `EXACT_ALIAS_QUALITIES` = field-exact·word-exact·field-prefix·word-prefix, 리뷰 r1 R1-03).
      if (field.role === 'alias' && hit.quality > QUALITY.wordPrefix) continue
      const better = best === null || roleOrder(field.role) < roleOrder(best.role) || (roleOrder(field.role) === roleOrder(best.role) && hit.quality < best.quality)
      if (better) best = { ...hit, role: field.role }
    }
    if (best === null) return null
    worstQuality = Math.max(worstQuality, best.quality)
    strength += best.quality
    if (best.role === 'primary') {
      onTitle += 1
      placement = Math.max(placement, best.placement)
    } else placement = Math.max(placement, 2)
    if (best.role === 'container') containerOnly += 1
    if (best.role === 'alias' || best.role === 'evidence') viaAliasOrEvidence += 1
  }
  const destination =
    normalizeMatchQuery(query) === normalizeMatchQuery(entry.title) ? 0 : onTitle === tokens.length ? 1 : viaAliasOrEvidence === tokens.length ? 3 : 2
  return { destination, worstQuality, containerOnly, strength, placement }
}

/** 제목을 먼저 본다 — 같은 토큰이 제목과 별칭 둘 다에 맞으면 제목이 증거다(행이 스스로 설명된다). */
function roleOrder(role: FieldRole): number {
  return role === 'primary' ? 0 : role === 'container' ? 1 : role === 'alias' ? 2 : 3
}

const RANK_KEYS: readonly (keyof TabRank)[] = ['destination', 'worstQuality', 'containerOnly', 'strength', 'placement']

function positionScore(entry: OpenTabSearchEntry): number {
  const base = entry.groupIndex * 10 + entry.tabIndex
  return entry.isCurrent ? base - 4000 : base
}

export function searchOpenTabs(input: { entries: readonly OpenTabSearchEntry[]; query: string; retainedResultId?: string | null }): OpenTabSearchResult[] {
  if (!normalizeMatchQuery(input.query)) return []
  const ranked = input.entries.flatMap((entry) => {
    const rank = rankOpenTab({ entry, query: input.query })
    return rank === null ? [] : [{ entry, rank }]
  })
  ranked.sort((a, b) => {
    for (const key of RANK_KEYS) {
      const difference = a.rank[key] - b.rank[key]
      if (difference !== 0) return difference
    }
    const position = positionScore(a.entry) - positionScore(b.entry)
    if (position !== 0) return position
    return a.entry.tabId < b.entry.tabId ? -1 : a.entry.tabId > b.entry.tabId ? 1 : 0
  })
  const results = ranked.map(({ entry }) => ({ id: `tab:${entry.tabId}`, tabId: entry.tabId, groupId: entry.groupId, title: entry.title, agent: entry.agent }))
  return capResults({ results, retainedId: input.retainedResultId ?? null })
}

/** Orca `capPaletteSection` — 키보드로 고른 행은 상한 밖으로 밀려도 남긴다(마지막 자리를 내준다). */
function capResults({ results, retainedId }: { results: OpenTabSearchResult[]; retainedId: string | null }): OpenTabSearchResult[] {
  const visible = results.slice(0, OPEN_TAB_SEARCH_RESULT_LIMIT)
  if (retainedId === null || visible.some((result) => result.id === retainedId)) return visible
  const retained = results.find((result) => result.id === retainedId)
  if (retained === undefined) return visible
  return [...visible.slice(0, OPEN_TAB_SEARCH_RESULT_LIMIT - 1), retained]
}

// ── 결과 조립·키보드 (Orca TabBarCreateEntry.tsx) ─────────────────────────────────────

export type ActiveOption =
  | { kind: 'tab'; option: OpenTabSearchResult }
  | { kind: 'menu'; option: TabCreateMenuOption }
  | { kind: 'agent'; option: AgentLaunchOption }

export function activeOptionId(option: ActiveOption): string {
  switch (option.kind) {
    case 'tab':
      return option.option.id
    case 'menu':
      return `menu:${option.option.id}`
    case 'agent':
      return `agent:${option.option.agent}`
  }
}

/** 질의 결과 행 — 열린 탭 → 메뉴 매칭 → 에이전트 매칭. 빈 질의면 비어 있고 정적 메뉴가 대신 보인다. */
export function buildActiveOptions(input: {
  query: string
  entries: readonly OpenTabSearchEntry[]
  agents: readonly AgentLaunchOption[]
  retainedResultId?: string | null
}): ActiveOption[] {
  if (!normalizeMatchQuery(input.query)) return []
  return [
    ...searchOpenTabs({ entries: input.entries, query: input.query, retainedResultId: input.retainedResultId }).map((option) => ({ kind: 'tab' as const, option })),
    ...findMatchingMenuOptions({ query: input.query }).map((option) => ({ kind: 'menu' as const, option })),
    ...findMatchingAgentLaunchOptions({ query: input.query, options: input.agents }).map((option) => ({ kind: 'agent' as const, option })),
  ]
}

/** Orca `showStaticCreateMenuItems = createMenuQuery.trim().length === 0` — 질의가 있으면 정적 메뉴·Quick-launch 를 숨긴다. */
export function showStaticCreateMenu(query: string): boolean {
  return query.trim().length === 0
}

/**
 * 선택된 행 — 화살표로 고정한 행이 아직 결과에 있으면 그것, 아니면 순위 첫 행(Orca: pinned 가 null 이면 순위를 따른다).
 * 결과가 없으면 null.
 */
export function selectedIndex({ options, pinnedId }: { options: readonly ActiveOption[]; pinnedId: string | null }): number | null {
  if (options.length === 0) return null
  if (pinnedId !== null) {
    const at = options.findIndex((option) => activeOptionId(option) === pinnedId)
    if (at >= 0) return at
  }
  return 0
}

/** ↑/↓ — 끝에서 감긴다. 선택이 없으면 ↓ 는 첫 행, ↑ 는 마지막 행. */
export function stepSelection(input: { count: number; current: number | null; delta: 1 | -1 }): number | null {
  if (input.count === 0) return null
  if (input.current === null) return input.delta === 1 ? 0 : input.count - 1
  return (input.current + input.delta + input.count) % input.count
}

/** 정적 메뉴 안 ↑/↓ — Radix 메뉴 기본(감기지 않음)과 같다. 끝에서 멈춘다. */
export function stepStaticItem(input: { count: number; current: number; delta: 1 | -1 }): number {
  return Math.max(0, Math.min(input.count - 1, input.current + input.delta))
}

// ── 기동 워치독 (Orca QuickLaunchButton waitForTerminalPty 의 corral 등가물, 게이트 ⓪ Q2 ⓐ) ─────────

/**
 * 기다리는 시간. U2 실측(`raw/claude/u2/`): 실행 파일이 없으면 `agent.start` 는 **성공**으로 끝나고 pane.agent 는 20초 동안 오지 않는다(조용한 실패).
 * 정상 claude 는 격리 인스턴스에서 0.72~0.83초에 pane.agent 가 왔다(5/5). 네이티브(로그인 셸·사용자 설정) 도착은 K4 에서 잰다.
 * 10초 = 격리 최대값의 12배 — Orca 가 "에이전트 준비" 워치독을 오탐으로 버린 이력(#2643)이 있어 오탐 0 을 우선한다.
 */
export const LAUNCH_WATCHDOG_MS = 10_000

export type LaunchWatch = { paneId: string; workspaceId: string; label: string }

export type LaunchWatchdogVerdict =
  /** pane.agent 가 왔다 — 성공. */
  | 'detected'
  /** 탭이 닫혔거나 pane 이 다른 workspace 로 갔다 — 알리지 않는다(Orca `stillOpen`). */
  | 'gone'
  /** 사용자가 다른 worktree 를 보고 있다 — 알리지 않는다(Orca `activeWorktreeId !== worktreeId`). */
  | 'elsewhere'
  /** 아직 에이전트가 없다 — 기한이면 알린다. */
  | 'missing'

export function launchWatchdogVerdict(input: {
  watch: LaunchWatch
  pane: { workspaceId: string; agent: string | null } | null
  activeWorkspaceId: string | null
}): LaunchWatchdogVerdict {
  const { watch, pane } = input
  if (pane === null || pane.workspaceId !== watch.workspaceId) return 'gone'
  if (pane.agent !== null) return 'detected'
  if (input.activeWorkspaceId !== watch.workspaceId) return 'elsewhere'
  return 'missing'
}

export function launchWatchdogMessage(label: string): string {
  return `${label} 실행 실패 — ${LAUNCH_WATCHDOG_MS / 1000}초 안에 에이전트가 감지되지 않았습니다. 터미널 출력을 확인하세요.`
}
