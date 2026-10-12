// LIFE-589 E2 — 탐색기 순수 규칙: 정렬(ⓑ)·숨김(ⓒⓓⓔ)·지연 투영(ⓐ)·키보드(ⓙ)·가상 창(E3ⓒ).
import { describe, expect, it } from 'vitest'
import { compareEntries, keyAction, projectRows, visibleEntries, visibleRange, type ExplorerEntry } from './explorer.js'

const file = (name: string): ExplorerEntry => ({ name, kind: 'file', link: 'none' })
const dir = (name: string): ExplorerEntry => ({ name, kind: 'dir', link: 'none' })
const names = (entries: ExplorerEntry[]): string[] => entries.map((entry) => entry.name)
const show = { showDotfiles: true, showIgnored: true }

describe('E2ⓑ 폴더 우선 + 자연 정렬', () => {
  it('숫자를 수로 읽는다 — file2 < file10', () => {
    expect(names([file('file10'), file('file2'), file('file1')].sort(compareEntries))).toEqual(['file1', 'file2', 'file10'])
  })
  it('폴더가 파일보다 먼저', () => {
    expect(names([file('a'), dir('z'), file('b'), dir('c')].sort(compareEntries))).toEqual(['c', 'z', 'a', 'b'])
  })
  it('대소문자는 섞어 정렬하고, 같은 이름이면 순서가 매번 같다', () => {
    expect(names([file('b'), file('A'), file('a'), file('B')].sort(compareEntries))).toEqual(['A', 'a', 'B', 'b'])
  })
  it('한글·점 파일도 같은 규칙 — 점 파일은 이름 그대로 비교(VS Code 기본과 같다)', () => {
    const sorted = names([file('하나.md'), file('.env'), file('가.md'), file('readme.md'), dir('.github')].sort(compareEntries))
    expect(sorted[0]).toBe('.github')
    expect(sorted.indexOf('가.md')).toBeLessThan(sorted.indexOf('하나.md'))
    expect(sorted.indexOf('.env')).toBeLessThan(sorted.indexOf('readme.md'))
  })
})

describe('E2ⓒⓓⓔ 숨김', () => {
  const entries = [dir('.git'), dir('node_modules'), dir('src'), file('.env'), file('debug.log'), file('a.ts')]
  it('.git·node_modules 는 토글과 상관없이 항상 숨긴다', () => {
    expect(names(visibleEntries({ dir: '', entries, filter: show, isIgnored: () => false }))).toEqual(['src', '.env', 'a.ts', 'debug.log'])
  })
  it('dotfile 토글 끔 → 점 파일 숨김', () => {
    expect(names(visibleEntries({ dir: '', entries, filter: { showDotfiles: false, showIgnored: true }, isIgnored: () => false }))).toEqual(['src', 'a.ts', 'debug.log'])
  })
  it('ignored 토글 끔 → ignored 숨김(켜면 보이고 흐림은 행이 한다)', () => {
    const isIgnored = (rel: string): boolean => rel === 'debug.log'
    expect(names(visibleEntries({ dir: '', entries, filter: { showDotfiles: true, showIgnored: false }, isIgnored }))).toEqual(['src', '.env', 'a.ts'])
  })
  it('하위 폴더에서도 node_modules 는 숨는다(어느 깊이든)', () => {
    expect(names(visibleEntries({ dir: 'app', entries: [dir('node_modules'), file('x')], filter: show, isIgnored: () => false }))).toEqual(['x'])
  })
})

describe('E2ⓐ 지연 투영 · ⓗ 링크', () => {
  const listings = new Map<string, ExplorerEntry[]>([
    ['', [dir('src'), dir('lib'), file('a.ts'), { name: 'out', kind: 'dir', link: 'outside' }]],
    ['src', [file('b.ts')]],
  ])
  it('펼친 폴더만 내려간다 — 펼치지 않은 lib 는 목록이 없어도 된다', () => {
    const rows = projectRows({ listings, expanded: new Set(['src']), filter: show, isIgnored: () => false })
    expect(rows.map((row) => `${row.rel}@${row.depth}`)).toEqual(['lib@1', 'out@1', 'src@1', 'src/b.ts@2', 'a.ts@1'])
  })
  it('펼쳤지만 목록이 아직 없으면 loading', () => {
    const rows = projectRows({ listings, expanded: new Set(['lib']), filter: show, isIgnored: () => false })
    expect(rows.find((row) => row.rel === 'lib')).toMatchObject({ expanded: true, loading: true })
  })
  it('루트 밖 링크 폴더는 펼침 상태여도 펼치지 않는다', () => {
    const rows = projectRows({ listings, expanded: new Set(['out']), filter: show, isIgnored: () => false })
    expect(rows.find((row) => row.rel === 'out')).toMatchObject({ expanded: false, link: 'outside' })
  })
})

describe('E2ⓙ 키보드', () => {
  const listings = new Map<string, ExplorerEntry[]>([
    ['', [dir('src'), file('a.ts')]],
    ['src', [file('b.ts')]],
  ])
  const collapsed = projectRows({ listings, expanded: new Set(), filter: show, isIgnored: () => false })
  const open = projectRows({ listings, expanded: new Set(['src']), filter: show, isIgnored: () => false })
  it('↑↓ 이동 · Home/End', () => {
    expect(keyAction({ key: 'ArrowDown', rows: open, selected: 'src' })).toEqual({ kind: 'select', rel: 'src/b.ts' })
    expect(keyAction({ key: 'ArrowUp', rows: open, selected: 'src/b.ts' })).toEqual({ kind: 'select', rel: 'src' })
    expect(keyAction({ key: 'ArrowDown', rows: open, selected: null })).toEqual({ kind: 'select', rel: 'src' })
    expect(keyAction({ key: 'End', rows: open, selected: 'src' })).toEqual({ kind: 'select', rel: 'a.ts' })
    expect(keyAction({ key: 'Home', rows: open, selected: 'a.ts' })).toEqual({ kind: 'select', rel: 'src' })
  })
  it('→ 접힌 폴더 펼치기, 펼친 폴더는 첫 자식으로', () => {
    expect(keyAction({ key: 'ArrowRight', rows: collapsed, selected: 'src' })).toEqual({ kind: 'expand', rel: 'src' })
    expect(keyAction({ key: 'ArrowRight', rows: open, selected: 'src' })).toEqual({ kind: 'select', rel: 'src/b.ts' })
  })
  it('← 펼친 폴더 접기, 아니면 부모로', () => {
    expect(keyAction({ key: 'ArrowLeft', rows: open, selected: 'src' })).toEqual({ kind: 'collapse', rel: 'src' })
    expect(keyAction({ key: 'ArrowLeft', rows: open, selected: 'src/b.ts' })).toEqual({ kind: 'select', rel: 'src' })
  })
  it('Enter·Space 는 폴더 토글, 파일은 아무것도 안 한다(열기는 F2)', () => {
    expect(keyAction({ key: 'Enter', rows: collapsed, selected: 'src' })).toEqual({ kind: 'expand', rel: 'src' })
    expect(keyAction({ key: ' ', rows: open, selected: 'src' })).toEqual({ kind: 'collapse', rel: 'src' })
    expect(keyAction({ key: 'Enter', rows: open, selected: 'a.ts' })).toEqual({ kind: 'none' })
  })
})

describe('E3ⓒ 가상 창', () => {
  it('보이는 행 + overscan 만', () => {
    expect(visibleRange({ scrollTop: 22 * 100, viewport: 22 * 30, rowHeight: 22, count: 10_000, overscan: 10 })).toEqual({ start: 90, end: 140 })
    expect(visibleRange({ scrollTop: 0, viewport: 220, rowHeight: 22, count: 5, overscan: 10 })).toEqual({ start: 0, end: 5 })
  })
})
