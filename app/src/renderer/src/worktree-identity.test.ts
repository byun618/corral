// LIFE-491 — 198 `getWorktreeGitIdentityDisplay` 와 같은 판정·문구(글자 단위).
import { describe, expect, it } from 'vitest'
import { worktreeIdentity } from './worktree-identity.js'

describe('worktreeIdentity', () => {
  it('브랜치가 있으면 branch — refs/heads/ 접두와 공백을 걷는다', () => {
    expect(worktreeIdentity({ branch: 'feat/x', head: 'abc' })).toEqual({ kind: 'branch', branchName: 'feat/x' })
    expect(worktreeIdentity({ branch: 'refs/heads/main ', head: null })).toEqual({ kind: 'branch', branchName: 'main' })
  })
  it('브랜치가 없고 HEAD 가 있으면 detached — 앞 7자, 198 문구 그대로', () => {
    expect(worktreeIdentity({ branch: null, head: ' 02d98271f3c4a5b6c7d8e9f00112233445566778\n' })).toEqual({
      kind: 'detached',
      shortHead: '02d9827',
      sidebarLabel: 'Detached HEAD @ 02d9827',
      tooltip: 'Detached HEAD at 02d9827. You are viewing a commit, not a branch.',
    })
    expect(worktreeIdentity({ branch: '  ', head: 'abc' })?.kind).toBe('detached')
  })
  it('둘 다 없으면 null(bare 등) — detached 로 세지 않는다', () => {
    expect(worktreeIdentity({ branch: null, head: null })).toBeNull()
    expect(worktreeIdentity({ branch: '', head: '   ' })).toBeNull()
  })
})
