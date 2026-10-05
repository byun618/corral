// 설정 검색 점수 (LIFE-511 K5) — Orca 198 `components/settings/settings-search.ts` 의 단계 점수를 옮겼다.
// 섹션 제목 > 항목 제목 > 설명 > 키워드, 단계마다 완전 일치 > 접두 > 포함. 첫 항목(섹션 자체)만 섹션 제목 점수를 받는다.
// 다른 점: 질의 크기 상한(2KB 바이트 검사)은 뺐다 — 입력이 설정 검색창 하나뿐이고 붙여넣기 폭주 경로가 없다.

export type SettingsSearchEntry = { title: string; description?: string; keywords?: readonly string[] }

type Tier = { exact: number; prefix: number; substring: number }
const SECTION_TITLE: Tier = { exact: 900, prefix: 850, substring: 800 }
const ENTRY_TITLE: Tier = { exact: 700, prefix: 650, substring: 600 }
const DESCRIPTION: Tier = { exact: 500, prefix: 450, substring: 400 }
const KEYWORD: Tier = { exact: 300, prefix: 250, substring: 200 }
const NO_MATCH = 0
const EMPTY_QUERY = 1

export function normalizeSettingsQuery(query: string): string {
  return query.trim().toLowerCase()
}

function scoreText(query: string, value: string | undefined, tier: Tier): number {
  if (!value) return NO_MATCH
  const normalized = value.toLowerCase()
  if (normalized === query) return tier.exact
  if (normalized.startsWith(query)) return tier.prefix
  if (normalized.includes(query)) return tier.substring
  return NO_MATCH
}

/** 질의가 비면 1(모두 보인다), 맞는 것이 없으면 0. 첫 항목이 섹션 자체다(`sectionSearchEntries`). */
export function scoreSettingsSearch(query: string, entries: readonly SettingsSearchEntry[]): number {
  const normalized = normalizeSettingsQuery(query)
  if (normalized === '') return EMPTY_QUERY
  return entries.reduce((score, entry, index) => Math.max(
    score,
    scoreText(normalized, entry.title, index === 0 ? SECTION_TITLE : ENTRY_TITLE),
    scoreText(normalized, entry.description, DESCRIPTION),
    ...(entry.keywords ?? []).map((keyword) => scoreText(normalized, keyword, KEYWORD)),
  ), NO_MATCH)
}

export function matchesSettingsSearch(query: string, entries: readonly SettingsSearchEntry[]): boolean {
  return scoreSettingsSearch(query, entries) > NO_MATCH
}

/** 맞는 것만 점수 내림차순(같으면 원래 순서). 질의가 비면 원래 순서 그대로 전부. */
export function rankSettingsSearch<T>(input: { query: string; items: readonly T[]; entriesOf: (item: T) => readonly SettingsSearchEntry[] }): T[] {
  if (normalizeSettingsQuery(input.query) === '') return [...input.items]
  return input.items
    .map((item, index) => ({ item, index, score: scoreSettingsSearch(input.query, input.entriesOf(item)) }))
    .filter((row) => row.score > NO_MATCH)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item)
}
