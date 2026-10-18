// LIFE-592 — 탐색기 파일 조작 UI 의 순수 규칙(단위): 끌어 놓기 가능 여부(E6ⓑ)·새 항목 입력 행 자리(E1ⓑ)·행 메뉴 항목(E1ⓐ·E2ⓐ·E3ⓐ·E8ⓐ).
import { describe, expect, it } from 'vitest'
import { canDropOn, createSlot, rowMenuEntries } from './Explorer.js'
import type { ExplorerRow } from '../../../shared/explorer.js'

const row = (rel: string, kind: 'dir' | 'file', expanded = false): ExplorerRow => ({ rel, name: rel.slice(rel.lastIndexOf('/') + 1), depth: rel.split('/').length, kind, link: 'none', expanded, loading: false, ignored: false })

describe('E6ⓑ 끌어 놓기', () => {
  it('자기 자신·자기 하위·같은 부모는 놓을 수 없다', () => {
    expect(canDropOn({ from: 'src', dir: 'src' })).toBe(false)
    expect(canDropOn({ from: 'src', dir: 'src/lib' })).toBe(false)
    expect(canDropOn({ from: 'src/a.ts', dir: 'src' })).toBe(false)
    expect(canDropOn({ from: 'a.ts', dir: '' })).toBe(false)
  })
  it('다른 폴더·루트·이름이 접두사만 같은 형제 폴더는 된다', () => {
    expect(canDropOn({ from: 'src/a.ts', dir: '' })).toBe(true)
    expect(canDropOn({ from: 'src', dir: 'src2' })).toBe(true)
    expect(canDropOn({ from: 'a.ts', dir: 'src/lib' })).toBe(true)
  })
})

describe('E1ⓑ 입력 행 자리 — 폴더 우선 정렬', () => {
  const rows = [row('src', 'dir', true), row('src/lib', 'dir', true), row('src/lib/x.ts', 'file'), row('src/util', 'dir'), row('src/a.ts', 'file'), row('src/b.ts', 'file'), row('z.md', 'file')]
  it('새 폴더 = 그 폴더 첫 자식 자리, 새 파일 = 하위 폴더 묶음(펼친 하위 포함) 뒤', () => {
    expect(createSlot({ rows, dir: 'src', type: 'dir' })).toEqual({ index: 1, depth: 2 })
    expect(createSlot({ rows, dir: 'src', type: 'file' })).toEqual({ index: 4, depth: 2 })
  })
  it('루트', () => {
    expect(createSlot({ rows, dir: '', type: 'dir' })).toEqual({ index: 0, depth: 1 })
    expect(createSlot({ rows, dir: '', type: 'file' })).toEqual({ index: 6, depth: 1 })
  })
  it('빈 폴더(자식 없음)·끝 폴더', () => {
    const tail = [row('a', 'dir', true)]
    expect(createSlot({ rows: tail, dir: 'a', type: 'file' })).toEqual({ index: 1, depth: 2 })
  })
})

describe('행 메뉴', () => {
  it('새 파일·새 폴더 · 경로·보기 · 복제·이름 바꾸기·삭제 · (폴더) 접기', () => {
    const actions = (input: { kind: 'dir' | 'file'; expanded: boolean }) => rowMenuEntries(input).flatMap((entry) => (entry.kind === 'item' ? [entry.action] : ['|']))
    expect(actions({ kind: 'file', expanded: false })).toEqual(['newFile', 'newFolder', '|', 'copyPath', 'copyRelativePath', '|', 'reveal', 'openTerminal', '|', 'duplicate', 'rename', 'trash'])
    expect(actions({ kind: 'dir', expanded: true }).slice(-2)).toEqual(['|', 'collapse'])
  })
})
