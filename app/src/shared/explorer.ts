// 탐색기 (LIFE-589 F1) — main·렌더러가 같이 쓰는 모양과 순수 규칙.
//
// main 은 **읽기 전용**으로 한 폴더의 항목만 준다(`corral:explorerList`). 무엇을 숨기고 어떤 순서로 보이는지는 여기 순수 함수가 정한다 —
// 숨김 규칙(Orca: `.git`·`node_modules` 항상 숨김)과 정렬(VS Code `explorer.sortOrder: default` — 폴더 먼저, 숫자 인식)은 단위 시험으로 덮는다.
// 경로는 **worktree 루트 기준 상대 경로**(구분자 `/`, 루트 = '')로 주고받는다 — 절대 경로를 렌더러가 조립하지 않게 해 가둠을 main 한 곳에 둔다.

/** 한 항목. `kind` 는 링크를 따라간 대상의 종류(디렉터리 링크는 `dir`), `link` 는 그 항목 자체가 심볼릭 링크인지. */
export type ExplorerEntry = {
  name: string
  kind: 'dir' | 'file'
  /** 심볼릭 링크 — `broken` 대상 없음 · `outside` 대상이 worktree 루트 밖(가둠 — 펼치지 않는다). 둘 다 펼칠 수 없다. */
  link: 'none' | 'ok' | 'broken' | 'outside'
}

/** 거절 사유 — E7ⓑ 양성 대조가 「그 검사에서 났다」 를 이 코드로 보인다. */
export type ExplorerRefusal =
  | 'not_worktree' // 열린 worktree 루트가 아니다(등록 안 된 루트)
  | 'invalid_argument' // 형 위반(문자열 아님·절대 경로·NUL 등)
  | 'outside_root' // realpath 뒤 루트 밖(`..` 탈출·밖을 가리키는 링크)
  | 'not_found'
  | 'not_directory'
  | 'io_error'

export type ExplorerListResult =
  | { ok: true; dir: string; entries: ExplorerEntry[] }
  | { ok: false; dir: string; code: ExplorerRefusal; error: string }

/** 트리에서 **항상** 숨기는 이름 (Orca `file-explorer-entries.ts` — 어느 깊이든 이 이름이면 숨긴다). 감시 제외 목록과는 별개다. */
export const ALWAYS_HIDDEN_NAMES: readonly string[] = ['.git', 'node_modules']

export const isDotfile = (name: string): boolean => name.startsWith('.')

/** 상대 경로 이어 붙이기 — 루트('')의 자식은 이름 그대로. */
export const joinRel = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

export const parentRel = (rel: string): string => {
  const index = rel.lastIndexOf('/')
  return index === -1 ? '' : rel.slice(0, index)
}

export const depthOf = (rel: string): number => (rel === '' ? 0 : rel.split('/').length)

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * 폴더 먼저 + 숫자 인식 자연 정렬 (VS Code `compareFileNamesDefault` 와 같은 결 — `Intl.Collator({ numeric: true })`).
 * 대소문자만 다른 이름은 collator 가 같다고 보므로 코드 단위 순서로 한 번 더 가른다(순서가 매번 같게).
 */
export function compareEntries(a: ExplorerEntry, b: ExplorerEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  const byName = collator.compare(a.name, b.name)
  if (byName !== 0) return byName
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

export type ExplorerFilter = { showDotfiles: boolean; showIgnored: boolean }

/** 보이는 항목 — 항상 숨김 → dotfile 토글 → ignored 토글 순. `isIgnored` 는 상대 경로를 받는다(ignored 판정은 git 결과). */
export function visibleEntries(input: { dir: string; entries: readonly ExplorerEntry[]; filter: ExplorerFilter; isIgnored: (rel: string) => boolean }): ExplorerEntry[] {
  return input.entries
    .filter((entry) => !ALWAYS_HIDDEN_NAMES.includes(entry.name))
    .filter((entry) => input.filter.showDotfiles || !isDotfile(entry.name))
    .filter((entry) => input.filter.showIgnored || !input.isIgnored(joinRel(input.dir, entry.name)))
    .sort(compareEntries)
}

export const isExpandable = (entry: { kind: 'dir' | 'file'; link: ExplorerEntry['link'] }): boolean => entry.kind === 'dir' && entry.link !== 'broken' && entry.link !== 'outside'

/** 화면 한 줄 — 평탄 투영(가상 스크롤이 index 로 자른다). */
export type ExplorerRow = {
  rel: string
  name: string
  depth: number
  kind: 'dir' | 'file'
  link: ExplorerEntry['link']
  expanded: boolean
  /** 펼쳤지만 아직 목록을 못 받은 폴더(로딩 중). */
  loading: boolean
  ignored: boolean
}

/**
 * 펼친 폴더를 따라 평탄 행 목록을 만든다 (Orca `file-explorer-row-projection.ts` 와 같은 자리). **목록을 받은 폴더만** 내려간다 —
 * 지연 로딩: 펼치지 않은 폴더는 읽지 않는다(E2ⓐ). 깨진 링크는 펼칠 수 없다.
 */
export function projectRows(input: {
  listings: ReadonlyMap<string, readonly ExplorerEntry[]>
  expanded: ReadonlySet<string>
  filter: ExplorerFilter
  isIgnored: (rel: string) => boolean
}): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const walk = (dir: string, depth: number): void => {
    const entries = input.listings.get(dir)
    if (entries === undefined) return
    for (const entry of visibleEntries({ dir, entries, filter: input.filter, isIgnored: input.isIgnored })) {
      const rel = joinRel(dir, entry.name)
      const expandable = isExpandable(entry)
      const expanded = expandable && input.expanded.has(rel)
      rows.push({ rel, name: entry.name, depth, kind: entry.kind, link: entry.link, expanded, loading: expanded && !input.listings.has(rel), ignored: input.isIgnored(rel) })
      if (expanded) walk(rel, depth + 1)
    }
  }
  walk('', 1)
  return rows
}

/**
 * 키보드 이동 (E2ⓙ — VS Code 트리 키): ↑↓ 이동 · ← 펼친 폴더면 접기, 아니면 부모로 · → 접힌 폴더면 펼치기, 펼친 폴더면 첫 자식으로 ·
 * Enter·Space 폴더 토글(파일은 선택만 — 열기는 F2) · Home/End. 결과는 「무엇을 할지」 만 돌려준다(상태 변경은 부르는 쪽).
 */
export type ExplorerKeyAction =
  | { kind: 'select'; rel: string }
  | { kind: 'expand'; rel: string }
  | { kind: 'collapse'; rel: string }
  | { kind: 'none' }

export function keyAction(input: { key: string; rows: readonly ExplorerRow[]; selected: string | null }): ExplorerKeyAction {
  const { rows } = input
  if (rows.length === 0) return { kind: 'none' }
  const index = input.selected === null ? -1 : rows.findIndex((row) => row.rel === input.selected)
  const row = index === -1 ? null : rows[index]
  const at = (i: number): ExplorerKeyAction => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, i))]
    return target === undefined ? { kind: 'none' } : { kind: 'select', rel: target.rel }
  }
  switch (input.key) {
    case 'ArrowDown':
      return at(index + 1)
    case 'ArrowUp':
      return index === -1 ? at(0) : at(index - 1)
    case 'Home':
      return at(0)
    case 'End':
      return at(rows.length - 1)
    case 'ArrowLeft': {
      if (row === null || row === undefined) return at(0)
      if (row.kind === 'dir' && row.expanded) return { kind: 'collapse', rel: row.rel }
      const parent = parentRel(row.rel)
      return parent === '' ? { kind: 'none' } : { kind: 'select', rel: parent }
    }
    case 'ArrowRight': {
      if (row === null || row === undefined) return at(0)
      if (!isExpandable(row)) return { kind: 'none' }
      if (!row.expanded) return { kind: 'expand', rel: row.rel }
      const child = rows[index + 1]
      return child !== undefined && parentRel(child.rel) === row.rel ? { kind: 'select', rel: child.rel } : { kind: 'none' }
    }
    case 'Enter':
    case ' ': {
      if (row === null || row === undefined || !isExpandable(row)) return { kind: 'none' }
      return row.expanded ? { kind: 'collapse', rel: row.rel } : { kind: 'expand', rel: row.rel }
    }
    default:
      return { kind: 'none' }
  }
}

/** 가상 스크롤 창 — 행 높이 고정(22px). overscan 은 위아래 각각. */
export function visibleRange(input: { scrollTop: number; viewport: number; rowHeight: number; count: number; overscan: number }): { start: number; end: number } {
  const first = Math.floor(input.scrollTop / input.rowHeight)
  const last = Math.ceil((input.scrollTop + input.viewport) / input.rowHeight)
  return { start: Math.max(0, first - input.overscan), end: Math.min(input.count, last + input.overscan) }
}
