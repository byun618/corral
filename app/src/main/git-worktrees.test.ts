// LIFE-491 K5ⓐ — `git worktree list --porcelain` 판독. 레코드 모양은 git 문서 Porcelain Format 예시 그대로
// (https://git-scm.com/docs/git-worktree#_porcelain_format): 비-bare 는 `HEAD <sha>` 가 늘 있고, detached 는 값 없는 `detached` 줄,
// bare 만 HEAD 줄이 없다. locked·prunable 은 값이 붙을 수 있는 줄.
import { describe, expect, it } from 'vitest'
import { parseWorktreePorcelain } from './git-worktrees.js'

const PORCELAIN = [
  'worktree /path/to/bare-source',
  'bare',
  '',
  'worktree /path/to/linked-worktree',
  'HEAD abcd1234abcd1234abcd1234abcd1234abcd1234',
  'branch refs/heads/master',
  '',
  'worktree /path/to/other-linked-worktree',
  'HEAD 1234abc1234abc1234abc1234abc1234abc1234a',
  'detached',
  '',
  'worktree /path/to/linked-worktree-locked-no-reason',
  'HEAD 5678abc5678abc5678abc5678abc5678abc5678c',
  'branch refs/heads/locked-no-reason',
  'locked',
  '',
  'worktree /path/to/linked-worktree-locked-with-reason',
  'HEAD 3456def3456def3456def3456def3456def3456b',
  'branch refs/heads/locked-with-reason',
  'locked reason why is locked',
  '',
  'worktree /path/to/linked-worktree-prunable',
  'HEAD 1233def1234def1234def1234def1234def1234b',
  'detached',
  'prunable gitdir file points to non-existent location',
  '',
  'worktree /path/to/gone',
  'HEAD 9999def1234def1234def1234def1234def1234b',
  'branch refs/heads/gone',
  '',
].join('\n')

describe('parseWorktreePorcelain', () => {
  const rows = parseWorktreePorcelain({ stdout: PORCELAIN, exists: (path) => path !== '/path/to/gone' })
  const by = (path: string) => rows.find((row) => row.path === path)
  it('브랜치 레코드 — 짧은 브랜치 이름 + 전체 HEAD', () => {
    expect(by('/path/to/linked-worktree')).toEqual({ path: '/path/to/linked-worktree', branch: 'master', head: 'abcd1234abcd1234abcd1234abcd1234abcd1234', isLinked: true })
  })
  it('detached — branch null(표시 문자열 없음) + HEAD 전체 sha', () => {
    expect(by('/path/to/other-linked-worktree')).toEqual({ path: '/path/to/other-linked-worktree', branch: null, head: '1234abc1234abc1234abc1234abc1234abc1234a', isLinked: true })
  })
  it('bare — HEAD 줄이 없어 head null, 첫 레코드라 주 체크아웃', () => {
    expect(by('/path/to/bare-source')).toEqual({ path: '/path/to/bare-source', branch: null, head: null, isLinked: false })
  })
  it('locked(값 있음·없음) — 브랜치·HEAD 는 그대로', () => {
    expect(by('/path/to/linked-worktree-locked-no-reason')).toMatchObject({ branch: 'locked-no-reason', head: '5678abc5678abc5678abc5678abc5678abc5678c' })
    expect(by('/path/to/linked-worktree-locked-with-reason')).toMatchObject({ branch: 'locked-with-reason', head: '3456def3456def3456def3456def3456def3456b' })
  })
  it('prunable(디렉터리는 있음) — detached 그대로 판독', () => {
    expect(by('/path/to/linked-worktree-prunable')).toMatchObject({ branch: null, head: '1233def1234def1234def1234def1234def1234b' })
  })
  it('디렉터리 없는 레코드는 뺀다(LIFE-445 S3) — 순번은 센다', () => {
    expect(by('/path/to/gone')).toBeUndefined()
    expect(rows).toHaveLength(6)
  })
  it('어느 행에도 `(detached)` 문자열이 없다', () => {
    expect(JSON.stringify(rows)).not.toContain('(detached)')
  })
})
