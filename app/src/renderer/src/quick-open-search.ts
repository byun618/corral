// ⌘P 빠른 열기 퍼지 검색 (LIFE-593 E2·E5ⓑ·E7ⓑ) — 순수 함수. 목록(루트 상대 경로)을 한 번 색인하고 키 입력마다 점수를 매겨 위 N 개만 고른다.
//
// 규칙 (VS Code·Orca 와 같은 결 — `raw/claude/k13-quickopen.md`):
//   · 대소문자 무시, 공백으로 나눈 단어는 AND. 단어에 `/` 를 넣으면 경로 일부(`main/index`)로 찾는다.
//   · 단어 하나의 점수 = 파일명 일치가 경로만 일치보다 위, 연속 일치가 흩어진 일치보다 위:
//       파일명과 같음 1000 > 파일명 앞부분 800 > 파일명 안 연속 600 > 경로 안 연속 400 > 파일명 안 흩어짐 200 > 경로 안 흩어짐 100 (+ 경계·연속 보너스)
//   · 같은 점수면 짧은 경로가 위, 그다음 경로 문자열 순(매번 같은 순서).
//   · 한글: 경로·질의를 NFC 로 맞춘 뒤 비교한다(macOS 디스크 이름은 NFD 일 수 있다 — E2ⓒ). 여는 경로는 원래 문자열 그대로.
// 최근 연 파일(Q6): 질의에 맞는 최근 파일을 최근 순으로 먼저(묶음 `recent`), 나머지를 점수 순(`file`). 빈 입력이면 최근 순 → 경로 순.
// 속도(E7ⓑ): 질의가 앞 질의를 늘린 것이면(같은 단어에 글자를 더하거나 단어를 더함) 앞 결과 안에서만 찾는다 — 늘린 질의에 맞으면 앞 질의에도 맞기 때문이다.
//   수정 r1 R1-C-10 — 색인·검색은 생성기(`fileIndexSteps`·`searchSteps`)로도 쓴다. 대화상자는 `sliced.ts drainSliced` 로 나눠 돌린다(20만 목록에서 긴 작업 0).
// 최근 기록 조회는 NFC 로 맞춘다(수정 r1 R1-C-02 — 목록은 디스크 이름(NFD 일 수 있음), 예전 기록은 NFC 일 수 있다).
import { drain, type Steps } from './sliced.js'

/** 이만큼 처리할 때마다 한 번 양보 지점(`yield`). */
const STEP = 2048

/** 결과 표시 상한(E2ⓓ — Orca 50 과 같다). 넘으면 「더 있음」. */
export const QUICK_OPEN_LIMIT = 50

export type FileIndex = {
  /** 원래 경로(여는 데 쓴다). */
  rels: readonly string[]
  /** NFC 로 맞춘 표시 문자열. */
  display: readonly string[]
  /** 표시 문자열을 소문자로 — 길이가 표시와 다르면(드문 유니코드 대소문자) 강조를 생략한다. */
  lower: readonly string[]
  /** 파일명 시작 위치(마지막 `/` 다음). */
  nameStart: Int32Array
  /** NFC 경로 → 번호(최근 기록 조회 — 기록의 정규화 형태와 상관없이 같은 파일). */
  byNfc: ReadonlyMap<string, number>
}

export function buildFileIndex(files: readonly string[]): FileIndex {
  return drain(fileIndexSteps(files))
}

export function* fileIndexSteps(files: readonly string[]): Steps<FileIndex> {
  const display: string[] = new Array<string>(files.length)
  const lower: string[] = new Array<string>(files.length)
  const nameStart = new Int32Array(files.length)
  const byNfc = new Map<string, number>()
  for (let index = 0; index < files.length; index += 1) {
    if (index % STEP === STEP - 1) yield
    const rel = files[index] ?? ''
    const shown = NON_ASCII.test(rel) ? rel.normalize('NFC') : rel
    display[index] = shown
    lower[index] = shown.toLowerCase()
    nameStart[index] = shown.lastIndexOf('/') + 1
    byNfc.set(shown, index)
  }
  return { rels: files, display, lower, nameStart, byNfc }
}

const NON_ASCII = /[\u0080-\uffff]/

/** 질의 → 단어들(NFC·소문자·공백 분리). */
export function queryTerms(query: string): string[] {
  return query
    .normalize('NFC')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

const BOUNDARY = new Set(['/', '-', '_', '.', ' '])
const atBoundary = (text: string, index: number): boolean => index === 0 || BOUNDARY.has(text[index - 1] ?? '')

type TermMatch = { score: number; positions: number[] }

/** 흩어진 일치 — `from` 부터 앞으로 탐욕적으로. 연속 글자 수·경계 수를 센다. 못 찾으면 null. */
function subsequence(text: string, term: string, from: number): { positions: number[]; runs: number; bounds: number; gaps: number } | null {
  const positions: number[] = []
  let at = from
  let runs = 0
  let bounds = 0
  for (const char of term) {
    const found = text.indexOf(char, at)
    if (found === -1) return null
    if (positions.length > 0 && found === (positions[positions.length - 1] ?? -2) + 1) runs += 1
    if (atBoundary(text, found)) bounds += 1
    positions.push(found)
    at = found + char.length
  }
  const first = positions[0] ?? 0
  const last = positions[positions.length - 1] ?? 0
  return { positions, runs, bounds, gaps: last - first + 1 - positions.length }
}

const range = (start: number, length: number): number[] => Array.from({ length }, (_value, offset) => start + offset)

/** 단어 하나를 경로 하나에 맞춘다(소문자 경로·파일명 시작). 안 맞으면 null. */
export function matchTerm(lower: string, nameStart: number, term: string): TermMatch | null {
  const name = nameStart === 0 ? lower : lower.slice(nameStart)
  if (!term.includes('/')) {
    if (name === term) return { score: 1000, positions: range(nameStart, term.length) }
    const inName = name.indexOf(term)
    if (inName === 0) return { score: 800 + Math.max(0, 50 - (name.length - term.length)), positions: range(nameStart, term.length) }
    if (inName > 0) return { score: 600 + (atBoundary(name, inName) ? 50 : 0), positions: range(nameStart + inName, term.length) }
  }
  // 경로 안 연속 — 파일명에 가까운(뒤쪽) 것을 고른다.
  const inPath = lower.lastIndexOf(term)
  if (inPath !== -1) {
    const end = inPath + term.length
    return { score: 400 + (atBoundary(lower, inPath) ? 50 : 0) + (end > nameStart ? 50 : 0), positions: range(inPath, term.length) }
  }
  if (!term.includes('/')) {
    const scattered = subsequence(name, term, 0)
    if (scattered !== null) return { score: 200 + scattered.runs * 8 + scattered.bounds * 6 - Math.min(60, scattered.gaps), positions: scattered.positions.map((position) => position + nameStart) }
  }
  const scattered = subsequence(lower, term, 0)
  if (scattered === null) return null
  return { score: Math.max(1, 100 + scattered.runs * 4 + scattered.bounds * 3 - Math.min(90, scattered.gaps)), positions: scattered.positions }
}

export type QuickOpenRow = { rel: string; display: string; nameStart: number; group: 'recent' | 'file'; positions: number[] }

export type QuickOpenResult = {
  rows: QuickOpenRow[]
  /** 질의에 맞은 전체 수(최근 포함) — 표시 수보다 많으면 「더 있음」. */
  total: number
  /** 다음 키 입력이 좁혀 찾을 후보(맞은 색인) — 질의를 늘리면 이 안에서만 찾는다. */
  matched: Int32Array | null
  query: string
}

/** 질의가 앞 질의를 늘린 것인가 — 앞 단어들이 새 단어들의 앞부분이고(마지막 단어만 길어질 수 있음) 단어가 줄지 않았다. */
export function narrows(previous: string, next: string): boolean {
  const before = queryTerms(previous)
  const after = queryTerms(next)
  if (before.length === 0 || after.length < before.length) return false
  for (let index = 0; index < before.length; index += 1) {
    const old = before[index] ?? ''
    const now = after[index] ?? ''
    if (index < before.length - 1 ? old !== now : !now.startsWith(old)) return false
  }
  return true
}

type Scored = { index: number; score: number; positions: number[] }

/** 위 K 개를 점수 순으로 유지(삽입 정렬 — K 가 작다). */
function better(index: FileIndex, a: Scored, b: Scored): boolean {
  if (a.score !== b.score) return a.score > b.score
  const al = index.lower[a.index]?.length ?? 0
  const bl = index.lower[b.index]?.length ?? 0
  if (al !== bl) return al < bl
  return (index.lower[a.index] ?? '') < (index.lower[b.index] ?? '')
}

function insertTop(input: { index: FileIndex; top: Scored[]; item: Scored; limit: number }): void {
  const { index, top, item, limit } = input
  if (top.length >= limit && !better(index, item, top[top.length - 1] ?? item)) return
  let at = top.length
  while (at > 0 && better(index, item, top[at - 1] ?? item)) at -= 1
  top.splice(at, 0, item)
  if (top.length > limit) top.pop()
}

const toRow = (index: FileIndex, item: { index: number; positions: number[] }, group: 'recent' | 'file'): QuickOpenRow => ({
  rel: index.rels[item.index] ?? '',
  display: index.display[item.index] ?? '',
  nameStart: index.nameStart[item.index] ?? 0,
  group,
  positions: (index.lower[item.index]?.length ?? -1) === (index.display[item.index]?.length ?? -2) ? item.positions : [],
})

/**
 * 검색. `recent` = 그 worktree 의 최근 연 파일(최근이 앞) — 목록에 없는 것은 보이지 않는다(E5ⓓ). `previous` 가 있고 질의가 그것을 늘린 것이면 그 후보 안에서만 찾는다.
 */
export function searchFiles(input: SearchInput): QuickOpenResult {
  return drain(searchSteps(input))
}

type SearchInput = { index: FileIndex; query: string; recent: readonly string[]; limit?: number; previous?: QuickOpenResult | null }

export function* searchSteps(input: SearchInput): Steps<QuickOpenResult> {
  const { index } = input
  const limit = input.limit ?? QUICK_OPEN_LIMIT
  const terms = queryTerms(input.query)
  const recentIndexes: number[] = []
  const recentSeen = new Set<number>()
  for (const rel of input.recent) {
    const at = index.byNfc.get(NON_ASCII.test(rel) ? rel.normalize('NFC') : rel)
    if (at !== undefined && !recentSeen.has(at)) {
      recentSeen.add(at)
      recentIndexes.push(at)
    }
  }
  if (terms.length === 0) {
    const recentSet = new Set(recentIndexes)
    const rows = recentIndexes.slice(0, limit).map((at) => toRow(index, { index: at, positions: [] }, 'recent'))
    const room = limit - rows.length
    if (room > 0) {
      // 경로 순 위 `room` 개 — 전체 정렬 없이 고른다.
      const top: number[] = []
      for (let at = 0; at < index.lower.length; at += 1) {
        if (at % STEP === STEP - 1) yield
        if (recentSet.has(at)) continue
        const value = index.lower[at] ?? ''
        if (top.length >= room && value >= (index.lower[top[top.length - 1] ?? 0] ?? '')) continue
        let slot = top.length
        while (slot > 0 && value < (index.lower[top[slot - 1] ?? 0] ?? '')) slot -= 1
        top.splice(slot, 0, at)
        if (top.length > room) top.pop()
      }
      for (const at of top) rows.push(toRow(index, { index: at, positions: [] }, 'file'))
    }
    return { rows, total: index.rels.length, matched: null, query: input.query }
  }
  const previous = input.previous ?? null
  const candidates = previous !== null && previous.matched !== null && narrows(previous.query, input.query) ? previous.matched : null
  const recentSet = new Set(recentIndexes)
  const recentHits = new Map<number, number[]>()
  const top: Scored[] = []
  const matched: number[] = []
  const consider = (at: number): void => {
    const lower = index.lower[at] ?? ''
    const nameStart = index.nameStart[at] ?? 0
    let score = 0
    const positions: number[] = []
    for (const term of terms) {
      const hit = matchTerm(lower, nameStart, term)
      if (hit === null) return
      score += hit.score
      for (const position of hit.positions) positions.push(position)
    }
    matched.push(at)
    if (recentSet.has(at)) recentHits.set(at, positions)
    else insertTop({ index, top, item: { index: at, score, positions }, limit })
  }
  const count = candidates === null ? index.lower.length : candidates.length
  for (let step = 0; step < count; step += 1) {
    if (step % STEP === STEP - 1) yield
    consider(candidates === null ? step : (candidates[step] ?? 0))
  }
  const rows: QuickOpenRow[] = []
  for (const at of recentIndexes) {
    const positions = recentHits.get(at)
    if (positions !== undefined && rows.length < limit) rows.push(toRow(index, { index: at, positions }, 'recent'))
  }
  for (const item of top) if (rows.length < limit) rows.push(toRow(index, item, 'file'))
  return { rows, total: matched.length, matched: Int32Array.from(matched), query: input.query }
}
