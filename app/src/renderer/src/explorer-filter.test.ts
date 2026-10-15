// LIFE-593 E6 — 탐색기 이름 필터(순수).
import { describe, expect, it } from 'vitest'
import { buildFilterTree, filterRows, filterWords, nameMatch } from './explorer-filter.js'

const files = ['src/main/explorer-fs.ts', 'src/main/index.ts', 'src/renderer/Explorer.tsx', 'docs/guide.md', '.github/ci.yml', 'node_modules/x/explorer.js', 'deep/a/b/c/target.txt', '한글/파일.md'.normalize('NFD')]
const run = (input: { query: string; showDotfiles?: boolean; collapsed?: string[]; opened?: string[] }) =>
  filterRows({
    tree: buildFilterTree({ files, showDotfiles: input.showDotfiles ?? true }),
    words: filterWords(input.query),
    collapsed: new Set(input.collapsed ?? []),
    opened: new Set(input.opened ?? []),
    isIgnored: () => false,
  })

describe('E6ⓑ 걸러냄 — 맞은 항목 + 조상, 조상 펼침, 안 읽은 폴더 안도', () => {
  it('맞은 파일과 그 조상만, 트리 순서(폴더 먼저)', () => {
    const result = run({ query: 'explorer' })
    expect(result.rows.map((row) => [row.rel, row.depth, row.expanded])).toEqual([
      ['src', 1, true],
      ['src/main', 2, true],
      ['src/main/explorer-fs.ts', 3, false],
      ['src/renderer', 2, true],
      ['src/renderer/Explorer.tsx', 3, false],
    ])
    expect(result.matchCount).toBe(2)
    expect(result.firstMatch).toBe('src/main/explorer-fs.ts')
  })
  it('깊은 폴더 안 파일도 찾는다(목록 기반)', () => {
    expect(run({ query: 'target' }).rows.map((row) => row.rel)).toEqual(['deep', 'deep/a', 'deep/a/b', 'deep/a/b/c', 'deep/a/b/c/target.txt'])
  })
  it('맞은 글자 강조 범위', () => {
    expect(run({ query: 'fs' }).highlights.get('src/main/explorer-fs.ts')).toEqual([[9, 11]])
  })
  it('사용자가 접은 조상은 접힌다(필터 안에서만)', () => {
    expect(run({ query: 'explorer', collapsed: ['src/main'] }).rows.map((row) => row.rel)).toEqual(['src', 'src/main', 'src/renderer', 'src/renderer/Explorer.tsx'])
  })
  it('맞은 폴더는 접힌 채, 펼치면(opened) 그 안을 다 보인다', () => {
    expect(run({ query: 'docs' }).rows.map((row) => [row.rel, row.expanded])).toEqual([['docs', false]])
    expect(run({ query: 'docs', opened: ['docs'] }).rows.map((row) => row.rel)).toEqual(['docs', 'docs/guide.md'])
  })
})

describe('E6ⓒ 매칭·토글', () => {
  it('대소문자 무시 부분 문자열, 공백 단어 AND', () => {
    expect(run({ query: 'EXPLORER tsx' }).rows.map((row) => row.rel)).toEqual(['src', 'src/renderer', 'src/renderer/Explorer.tsx'])
  })
  it('node_modules·.git 은 늘 숨김, dotfile 토글을 따른다', () => {
    expect(run({ query: 'explorer' }).rows.some((row) => row.rel.startsWith('node_modules'))).toBe(false)
    expect(run({ query: 'ci' }).rows.map((row) => row.rel)).toEqual(['.github', '.github/ci.yml'])
    expect(run({ query: 'ci', showDotfiles: false }).rows).toEqual([])
  })
  it('한글(NFD 이름 · NFC 질의)', () => {
    expect(run({ query: '파일' }).matchCount).toBe(1)
  })
  it('ⓖ 일치 0', () => {
    expect(run({ query: 'zzzz' })).toMatchObject({ rows: [], matchCount: 0, firstMatch: null })
  })
  it('nameMatch — 단어 하나라도 없으면 null', () => {
    expect(nameMatch({ name: 'ab', lowerName: 'ab', words: ['a', 'z'] })).toBeNull()
  })
})
