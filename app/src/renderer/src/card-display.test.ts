// Compact 제목 hover 카드 내용 (LIFE-477 K3 · Q-W1) — 열 이유가 있을 때만, 내용 = 브랜치·제목(다를 때)·git 상태.
import { describe, expect, it } from 'vitest'
import type { GitStatusSummary } from '../../shared/types.js'
import { compactHoverContent, gitStatusWords } from './card-display.js'

const CLEAN: GitStatusSummary = { branch: 'feat/x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }

describe('compactHoverContent', () => {
  it('ⓐ 제목 = 브랜치이고 git 마크가 없으면 열지 않는다(corral 의 보통 카드)', () => {
    expect(compactHoverContent({ branch: 'feat/x', title: 'feat/x', gitStatus: CLEAN })).toBeNull()
  })
  it('ⓐ git 마크가 있으면 연다 — 브랜치 + git 상태(제목은 브랜치와 같아 다시 쓰지 않는다)', () => {
    const got = compactHoverContent({ branch: 'feat/x', title: 'feat/x', gitStatus: { ...CLEAN, dirty: true, unstaged: 2, untracked: 1, ahead: 3 } })
    expect(got).toEqual({ branch: 'feat/x', title: null, git: { mark: '●3 ↑3', tone: 'dirty', words: '변경 3 · 앞섬 3' } })
  })
  it('ⓐ 198 조건 — 브랜치 ≠ 제목이면 git 마크가 없어도 연다(branch-first)', () => {
    expect(compactHoverContent({ branch: 'feat/x', title: 'Fancy name', gitStatus: CLEAN })).toEqual({ branch: 'feat/x', title: 'Fancy name', git: null })
  })
  it('detached(브랜치 없음) — git 마크가 있을 때만, 제목을 싣는다', () => {
    expect(compactHoverContent({ branch: null, title: '(브랜치 없음)', gitStatus: CLEAN })).toBeNull()
    expect(compactHoverContent({ branch: null, title: '(브랜치 없음)', gitStatus: { ...CLEAN, behind: 2 } })).toEqual({
      branch: null,
      title: '(브랜치 없음)',
      git: { mark: '↓2', tone: 'behind', words: '뒤처짐 2' },
    })
  })
  it('git 상태 말 — 마크와 같은 순서', () => {
    expect(gitStatusWords({ ...CLEAN, staged: 1, conflicted: 1, ahead: 1, behind: 4 })).toBe('변경 2 · 앞섬 1 · 뒤처짐 4')
  })
})
