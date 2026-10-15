// 탐색기 이름 필터 (LIFE-593 E6 · Q7) — 순수 함수. ⌘P 와 같은 전체 파일 목록으로 트리를 다시 세워 **맞은 항목 + 그 조상만** 보인다(걸러냄).
//
// · 매칭: 이름(파일·폴더)에 대한 대소문자 무시 부분 문자열, 공백으로 나눈 단어는 AND(Orca 이름 필터·Q7). 한글은 NFC 로 맞춰 비교한다.
// · 조상 폴더는 펼쳐 보인다(사용자가 접으면 접힌다 — `collapsed`). 맞은 폴더(맞은 자손이 없는)는 접힌 채 보이고, 펼치면(`opened`) 그 안을 다 보인다.
//   이 펼침·접힘은 필터 안에서만 산다 — 필터를 지우면 필터 전 트리 펼침 상태로 돌아간다(E6ⓔ).
// · 접힌 폴더·아직 안 읽은 폴더 안도 찾는다(목록 = git 전체 목록 — 탐색기 「Git 제외 파일 보이기」 가 켜져 있으면 무시 파일 포함 목록).
// · 탐색기 표시 규칙을 따른다: `.git`·`node_modules` 는 늘 숨김, dotfile 토글이 꺼져 있으면 점으로 시작하는 성분이 있는 경로를 숨긴다(E6ⓒ).
// · 폴더는 파일 경로에서 나온다 — 빈 폴더는 필터에 나오지 않는다(git 목록의 한계 — 대조표에 적는다).
// 속도(E7ⓕ): 항목을 번호로 들고(부모 번호·폴더 여부·소문자 이름을 미리), 키 입력마다 이름만 훑어 맞은 것과 조상을 표시한 뒤 표시된 가지만 내려간다.
// 자식 정렬(폴더 먼저·숫자 인식 — 트리와 같은 순서)은 한 번만 — `sortFilterTree` 를 목록을 받은 뒤 미리 부르면 첫 키 입력이 정렬 값을 치르지 않는다.
import { ALWAYS_HIDDEN_NAMES, isDotfile, joinRel, type ExplorerRow } from '../../shared/explorer.js'

export type FilterTree = {
  /** 항목 번호별 — 경로·원래 이름·소문자 NFC 이름·부모 번호(루트의 자식은 -1)·폴더 여부. */
  rels: string[]
  names: string[]
  lower: string[]
  parent: Int32Array
  isDir: Uint8Array
  /** 폴더 번호 → 자식 번호들(루트 = `root`). `sorted` 가 거짓이면 아직 정렬 전. */
  children: Map<number, number[]>
  root: number[]
  sorted: boolean
}

/** 목록 → 트리. `showDotfiles` 가 꺼져 있으면 점 성분이 있는 경로를 뺀다. */
export function buildFilterTree(input: { files: readonly string[]; showDotfiles: boolean }): FilterTree {
  const rels: string[] = []
  const names: string[] = []
  const lower: string[] = []
  const parents: number[] = []
  const dirFlags: number[] = []
  const dirIndex = new Map<string, number>()
  const children = new Map<number, number[]>()
  const root: number[] = []
  const add = (input: { rel: string; name: string; parent: number; dir: boolean }): number => {
    const at = rels.length
    rels.push(input.rel)
    names.push(input.name)
    // ASCII 이름은 NFC 가 그대로다 — 정규화를 건너뛴다(큰 목록 만들기 시간).
    lower.push((NON_ASCII.test(input.name) ? input.name.normalize('NFC') : input.name).toLowerCase())
    parents.push(input.parent)
    dirFlags.push(input.dir ? 1 : 0)
    if (input.parent === -1) root.push(at)
    else children.get(input.parent)?.push(at)
    if (input.dir) {
      dirIndex.set(input.rel, at)
      children.set(at, [])
    }
    return at
  }
  const hidden = (part: string): boolean => ALWAYS_HIDDEN_NAMES.includes(part) || (!input.showDotfiles && isDotfile(part))
  outer: for (const file of input.files) {
    const parts = file.split('/')
    for (const part of parts) if (hidden(part)) continue outer
    let dir = ''
    let parent = -1
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index] ?? ''
      const rel = joinRel(dir, name)
      const last = index === parts.length - 1
      const known = dirIndex.get(rel)
      if (known !== undefined) parent = known
      else if (!last) parent = add({ rel, name, parent, dir: true })
      else add({ rel, name, parent, dir: false })
      dir = rel
    }
  }
  return { rels, names, lower, parent: Int32Array.from(parents), isDir: Uint8Array.from(dirFlags), children, root, sorted: false }
}

const NON_ASCII = /[\u0080-\uffff]/
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 자식 정렬 — 폴더 먼저, 숫자 인식 자연 정렬, 같으면 코드 단위(`shared/explorer.ts compareEntries` 와 같은 순서). 한 번만 한다. */
export function sortFilterTree(tree: FilterTree): void {
  if (tree.sorted) return
  const compare = (a: number, b: number): number => {
    const ad = tree.isDir[a] ?? 0
    const bd = tree.isDir[b] ?? 0
    if (ad !== bd) return bd - ad
    const an = tree.names[a] ?? ''
    const bn = tree.names[b] ?? ''
    const byName = collator.compare(an, bn)
    if (byName !== 0) return byName
    return an < bn ? -1 : an > bn ? 1 : 0
  }
  tree.root.sort(compare)
  for (const list of tree.children.values()) list.sort(compare)
  tree.sorted = true
}

/** 필터 단어 — NFC·소문자·공백 분리. 비면 필터 아님. */
export function filterWords(query: string): string[] {
  return query
    .normalize('NFC')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
}

/** 이름에서 단어들의 강조 범위 [시작, 끝) — 단어마다 첫 일치. 하나라도 없으면 null. 원래 이름(NFC 아님)의 길이가 다르면 강조 없이 맞음만. */
export function nameMatch(input: { name: string; lowerName: string; words: readonly string[] }): [number, number][] | null {
  const ranges: [number, number][] = []
  for (const word of input.words) {
    const at = input.lowerName.indexOf(word)
    if (at === -1) return null
    ranges.push([at, at + word.length])
  }
  return input.lowerName.length === input.name.length ? ranges : []
}

export type FilteredRows = {
  rows: ExplorerRow[]
  /** 맞은 항목 수(조상 제외). */
  matchCount: number
  /** 트리 순서로 첫 맞은 행(입력칸 Enter·↓ 가 고른다 — E6ⓓ). */
  firstMatch: string | null
  /** 폴더 행 → 펼침/접힘 토글이 바꿀 집합(조상 = `collapsed`, 그 밖 = `opened`). */
  toggles: Map<string, 'collapsed' | 'opened'>
  /** 맞은 행의 이름 강조 범위(그릴 때만 — 보이는 행만 부른다). 맞지 않은 행(조상 등)은 null. */
  highlight: (row: ExplorerRow) => [number, number][] | null
}

/**
 * 걸러낸 행. `collapsed` = 사용자가 필터 안에서 접은 조상 폴더, `opened` = 필터 안에서 펼친 맞은 폴더(또는 그 안 폴더).
 * `ignored` = git 무시 경로(자신 또는 조상이 들어 있으면 흐림 — 트리 `isIgnoredPath` 와 같은 판정, 부모에서 물려받아 한 번씩만 본다).
 */
export function filterRows(input: { tree: FilterTree; words: readonly string[]; collapsed: ReadonlySet<string>; opened: ReadonlySet<string>; ignored: ReadonlySet<string> | null }): FilteredRows {
  const { tree, words } = input
  sortFilterTree(tree)
  const count = tree.rels.length
  // 0 = 아님 · 1 = 맞음 · 2 = 조상(맞은 것을 품음) · 3 = 둘 다
  const marks = new Uint8Array(count)
  let matchCount = 0
  for (let at = 0; at < count; at += 1) {
    const name = tree.lower[at] ?? ''
    let hit = true
    for (const word of words) {
      if (name.indexOf(word) === -1) {
        hit = false
        break
      }
    }
    if (!hit) continue
    marks[at] = (marks[at] ?? 0) | 1
    matchCount += 1
    for (let up = tree.parent[at] ?? -1; up !== -1 && ((marks[up] ?? 0) & 2) === 0; up = tree.parent[up] ?? -1) marks[up] = (marks[up] ?? 0) | 2
  }
  const rows: ExplorerRow[] = []
  const toggles = new Map<string, 'collapsed' | 'opened'>()
  let firstMatch: string | null = null
  const ignored = input.ignored !== null && input.ignored.size > 0 ? input.ignored : null
  const walk = (list: readonly number[], depth: number, inside: boolean, parentIgnored: boolean): void => {
    for (const at of list) {
      const mark = marks[at] ?? 0
      if (mark === 0 && !inside) continue
      const rel = tree.rels[at] ?? ''
      const isAncestor = (mark & 2) !== 0
      const isDir = tree.isDir[at] === 1
      const byAncestor = isAncestor && !inside
      const expanded = isDir && (byAncestor ? !input.collapsed.has(rel) : input.opened.has(rel))
      if (isDir) toggles.set(rel, byAncestor ? 'collapsed' : 'opened')
      if ((mark & 1) !== 0 && firstMatch === null) firstMatch = rel
      const isIgnored = parentIgnored || (ignored !== null && ignored.has(rel))
      rows.push({ rel, name: tree.names[at] ?? '', depth, kind: isDir ? 'dir' : 'file', link: 'none', expanded, loading: false, ignored: isIgnored })
      if (expanded) walk(tree.children.get(at) ?? [], depth + 1, inside || !isAncestor, isIgnored)
    }
  }
  walk(tree.root, 1, false, false)
  const highlight = (row: ExplorerRow): [number, number][] | null => {
    const lowerName = row.name.normalize('NFC').toLowerCase()
    return words.length === 0 ? null : nameMatch({ name: row.name, lowerName, words })
  }
  return { rows, matchCount, firstMatch, toggles, highlight }
}
