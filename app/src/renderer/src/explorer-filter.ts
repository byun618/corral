// 탐색기 이름 필터 (LIFE-593 E6 · Q7) — 순수 함수. ⌘P 와 같은 전체 파일 목록으로 트리를 다시 세워 **맞은 항목 + 그 조상만** 보인다(걸러냄).
//
// · 매칭: 이름(파일·폴더)에 대한 대소문자 무시 부분 문자열, 공백으로 나눈 단어는 AND(Orca 이름 필터·Q7). 한글은 NFC 로 맞춰 비교한다.
// · 조상 폴더는 펼쳐 보인다(사용자가 접으면 접힌다 — `collapsed`). 맞은 폴더(맞은 자손이 없는)는 접힌 채 보이고, 펼치면(`opened`) 그 안을 다 보인다.
//   이 펼침·접힘은 필터 안에서만 산다 — 필터를 지우면 필터 전 트리 펼침 상태로 돌아간다(E6ⓔ).
// · 접힌 폴더·아직 안 읽은 폴더 안도 찾는다(목록 = git 전체 목록 — 탐색기 「Git 제외 파일 보이기」 가 켜져 있으면 무시 파일 포함 목록).
// · 탐색기 표시 규칙을 따른다: `.git`·`node_modules` 는 늘 숨김, dotfile 토글이 꺼져 있으면 점으로 시작하는 성분이 있는 경로를 숨긴다(E6ⓒ).
// · 폴더는 파일 경로에서 나온다 — 빈 폴더는 필터에 나오지 않는다(git 목록의 한계 — 대조표에 적는다).
import { ALWAYS_HIDDEN_NAMES, compareEntries, isDotfile, joinRel, type ExplorerRow } from '../../shared/explorer.js'

export type FilterTree = {
  /** 폴더 → 직속 자식 이름들(정렬 전 — 정렬은 처음 내려갈 때 한 번). 루트 = ''. */
  children: Map<string, string[]>
  dirs: Set<string>
  /** 모든 항목(파일·폴더)의 경로·소문자 NFC 이름 — 매칭은 이 배열을 훑는다. */
  rels: string[]
  names: string[]
  sorted: Set<string>
}

/** 목록 → 트리. `showDotfiles` 가 꺼져 있으면 점 성분이 있는 경로를 뺀다. */
export function buildFilterTree(input: { files: readonly string[]; showDotfiles: boolean }): FilterTree {
  const children = new Map<string, string[]>([['', []]])
  const dirs = new Set<string>([''])
  const rels: string[] = []
  const names: string[] = []
  for (const file of input.files) {
    const parts = file.split('/')
    if (parts.some((part) => ALWAYS_HIDDEN_NAMES.includes(part) || (!input.showDotfiles && isDotfile(part)))) continue
    let dir = ''
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index] ?? ''
      const rel = joinRel(dir, name)
      const last = index === parts.length - 1
      if (!dirs.has(rel)) {
        if (!last) {
          dirs.add(rel)
          children.set(rel, [])
        }
        children.get(dir)?.push(name)
        rels.push(rel)
        names.push(name.normalize('NFC').toLowerCase())
      }
      dir = rel
    }
  }
  return { children, dirs, rels, names, sorted: new Set() }
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

const parentOf = (rel: string): string => {
  const index = rel.lastIndexOf('/')
  return index === -1 ? '' : rel.slice(0, index)
}

export type FilteredRows = {
  rows: ExplorerRow[]
  /** 행 경로 → 이름 강조 범위(맞은 항목만). */
  highlights: Map<string, [number, number][]>
  /** 맞은 항목 수(조상 제외). */
  matchCount: number
  /** 트리 순서로 첫 맞은 행(입력칸 Enter·↓ 가 고른다 — E6ⓓ). */
  firstMatch: string | null
  /** 폴더 행 → 펼침/접힘 토글이 바꿀 집합(조상 = `collapsed`, 그 밖 = `opened`). */
  toggles: Map<string, 'collapsed' | 'opened'>
}

/**
 * 걸러낸 행. `collapsed` = 사용자가 필터 안에서 접은 조상 폴더, `opened` = 필터 안에서 펼친 맞은 폴더(또는 그 안 폴더).
 * `isIgnored` = git 무시 판정(행 흐림 — 트리와 같다).
 */
export function filterRows(input: {
  tree: FilterTree
  words: readonly string[]
  collapsed: ReadonlySet<string>
  opened: ReadonlySet<string>
  isIgnored: (rel: string) => boolean
}): FilteredRows {
  const { tree, words } = input
  const highlights = new Map<string, [number, number][]>()
  const ancestors = new Set<string>()
  for (let index = 0; index < tree.rels.length; index += 1) {
    const rel = tree.rels[index] ?? ''
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const ranges = nameMatch({ name, lowerName: tree.names[index] ?? '', words })
    if (ranges === null) continue
    highlights.set(rel, ranges)
    for (let dir = parentOf(rel); dir !== '' && !ancestors.has(dir); dir = parentOf(dir)) ancestors.add(dir)
  }
  const rows: ExplorerRow[] = []
  const toggles = new Map<string, 'collapsed' | 'opened'>()
  let firstMatch: string | null = null
  const sortedChildren = (dir: string): string[] => {
    const list = tree.children.get(dir) ?? []
    if (!tree.sorted.has(dir)) {
      list.sort((a, b) => compareEntries({ name: a, kind: tree.dirs.has(joinRel(dir, a)) ? 'dir' : 'file', link: 'none' }, { name: b, kind: tree.dirs.has(joinRel(dir, b)) ? 'dir' : 'file', link: 'none' }))
      tree.sorted.add(dir)
    }
    return list
  }
  const walk = (dir: string, depth: number, inside: boolean): void => {
    for (const name of sortedChildren(dir)) {
      const rel = joinRel(dir, name)
      const isAncestor = ancestors.has(rel)
      const isMatch = highlights.has(rel)
      if (!isAncestor && !isMatch && !inside) continue
      const isDir = tree.dirs.has(rel)
      const byAncestor = isAncestor && !inside
      const expanded = isDir && (byAncestor ? !input.collapsed.has(rel) : input.opened.has(rel))
      if (isDir) toggles.set(rel, byAncestor ? 'collapsed' : 'opened')
      if (isMatch && firstMatch === null) firstMatch = rel
      rows.push({ rel, name, depth, kind: isDir ? 'dir' : 'file', link: 'none', expanded, loading: false, ignored: input.isIgnored(rel) })
      if (expanded) walk(rel, depth + 1, inside || !isAncestor)
    }
  }
  walk('', 1, false)
  return { rows, highlights, matchCount: highlights.size, firstMatch, toggles }
}
