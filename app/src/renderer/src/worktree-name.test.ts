// LIFE-490 fix1 F3 (r1 L3) — 팔레트 항목 이름: detached 끼리 구별되는가.
import { describe, expect, it } from 'vitest'
import { paletteWorktreeName, worktreeSearchContainer } from './worktree-name.js'

const row = (over: { displayName?: string | null; branch?: string | null; head?: string | null }) => ({
  displayName: null,
  branch: null,
  head: null,
  repoName: 'det-repo',
  path: '/r/wt/da',
  ...over,
})

describe('paletteWorktreeName', () => {
  it('브랜치가 있으면 브랜치(표시 이름이 있어도 — 지금 팔레트 그대로)', () => {
    expect(paletteWorktreeName(row({ branch: 'feat-x', head: 'a'.repeat(40), displayName: 'named' }))).toBe('feat-x')
  })
  it('detached 는 카드 제목 + 짧은 HEAD — 같은 레포 detached 둘이 다른 이름', () => {
    expect(paletteWorktreeName(row({ head: '6377dcf314fb7205a504d426690cd090549535f3' }))).toBe('det-repo @ 6377dcf')
    expect(paletteWorktreeName(row({ head: '513a44d97659478dcbe5782f7c72813c2ccbffbe' }))).toBe('det-repo @ 513a44d')
    expect(paletteWorktreeName(row({ head: '513a44d97659478dcbe5782f7c72813c2ccbffbe', displayName: 'named-det' }))).toBe('named-det @ 513a44d')
  })
  it('브랜치도 HEAD 도 없으면 카드 제목만', () => {
    expect(paletteWorktreeName(row({}))).toBe('det-repo')
  })
})

describe('worktreeSearchContainer (fix2 L-3 — 탭 검색 container)', () => {
  it('브랜치면 브랜치, detached 면 제목 + identity 라벨(「detached」 로 찾힌다), 둘 다 없으면 null', () => {
    expect(worktreeSearchContainer(row({ branch: 'feat-x', head: 'a'.repeat(40) }))).toBe('feat-x')
    expect(worktreeSearchContainer(row({ head: '6377dcf314fb7205a504d426690cd090549535f3' }))).toBe('det-repo Detached HEAD @ 6377dcf')
    expect(worktreeSearchContainer(row({}))).toBe(null)
  })
})
