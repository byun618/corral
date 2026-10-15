// LIFE-593 E5ⓐⓒ — 최근 연 파일 기록 규칙(순수).
import { describe, expect, it } from 'vitest'
import { dropRecentFile, pushRecentFile, readRecentFiles, RECENT_FILES_PER_ROOT, RECENT_FILES_ROOTS } from './recent-files.js'

describe('pushRecentFile', () => {
  it('ⓐ 연 파일이 맨 앞 — 이미 있으면 앞으로 옮긴다', () => {
    let recent = pushRecentFile({ recent: {}, root: '/wt', rel: 'a.ts' })
    recent = pushRecentFile({ recent, root: '/wt', rel: 'b.ts' })
    recent = pushRecentFile({ recent, root: '/wt', rel: 'a.ts' })
    expect(recent['/wt']).toEqual(['a.ts', 'b.ts'])
  })
  it('같은 파일이 이미 맨 앞이면 같은 객체(저장 생략)', () => {
    const recent = pushRecentFile({ recent: {}, root: '/wt', rel: 'a.ts' })
    expect(pushRecentFile({ recent, root: '/wt', rel: 'a.ts' })).toBe(recent)
  })
  it('ⓒ worktree 마다 따로, 상한을 넘으면 오래된 것부터 버린다', () => {
    let recent = {}
    for (let index = 0; index < RECENT_FILES_PER_ROOT + 5; index += 1) recent = pushRecentFile({ recent, root: '/wt', rel: `f${index}.ts` })
    recent = pushRecentFile({ recent, root: '/other', rel: 'x.ts' })
    const list = readRecentFiles(recent)['/wt'] ?? []
    expect(list).toHaveLength(RECENT_FILES_PER_ROOT)
    expect(list[0]).toBe(`f${RECENT_FILES_PER_ROOT + 4}.ts`)
    expect(list).not.toContain('f0.ts')
    expect(readRecentFiles(recent)['/other']).toEqual(['x.ts'])
  })
  it('worktree 수 상한 — 가장 오래 안 쓴 worktree 부터 버린다', () => {
    let recent = {}
    for (let index = 0; index <= RECENT_FILES_ROOTS; index += 1) recent = pushRecentFile({ recent, root: `/wt${index}`, rel: 'a.ts' })
    expect(Object.keys(recent)).toHaveLength(RECENT_FILES_ROOTS)
    expect(Object.keys(recent)).not.toContain('/wt0')
  })
  it('E8ⓔ 안전하지 않은 경로는 기록하지 않는다', () => {
    const recent = {}
    for (const rel of ['/etc/passwd', '../x', 'a/../b', '', 'a\0b']) expect(pushRecentFile({ recent, root: '/wt', rel })).toBe(recent)
  })
})

describe('dropRecentFile (수정 r2 R2-C-03)', () => {
  it('그 경로만 빼고, 없으면 같은 객체, 비면 worktree 칸을 지운다', () => {
    const recent = { '/a': ['x.ts', 'y.ts'], '/b': ['z.ts'] }
    expect(dropRecentFile({ recent, root: '/a', rel: 'x.ts' })).toEqual({ '/a': ['y.ts'], '/b': ['z.ts'] })
    expect(dropRecentFile({ recent, root: '/a', rel: 'nope.ts' })).toBe(recent)
    expect(dropRecentFile({ recent, root: '/b', rel: 'z.ts' })).toEqual({ '/a': ['x.ts', 'y.ts'] })
  })
})
