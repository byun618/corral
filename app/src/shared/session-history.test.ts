// LIFE-808 C4·C5 — 범위·검색 순수 함수. 경계 fixture 는 손으로 만든 행이다.
import { describe, expect, it } from 'vitest'
import { isPathWithin, isSessionId, readHistoryAgents, readSessionKey, scopeRows, searchRows, type SessionHistoryRow } from './session-history.js'

let seq = 0
function row(input: Partial<SessionHistoryRow> & { cwdKey: string | null }): SessionHistoryRow {
  seq += 1
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
  return { provider: 'claude', id, file: `/f/${id}.jsonl`, title: null, cwd: input.cwdKey, cwdExists: true, branch: null, model: null, firstPrompt: null, lastPrompt: null, lastActivityAt: seq, empty: false, ...input }
}

describe('C4 범위 전환', () => {
  const root = '/r/corral'
  const wtA = '/r/corral/.claude/worktrees/A'
  const rows = {
    inA: row({ cwdKey: wtA }),
    underA: row({ cwdKey: `${wtA}/app/src` }),
    sibling: row({ cwdKey: '/r/corral/.claude/worktrees/AB' }),
    deletedWt: row({ cwdKey: '/r/corral/.claude/worktrees/GONE' }),
    rootItself: row({ cwdKey: root }),
    rootPrefix: row({ cwdKey: '/r/corral-specs' }),
    linkedOutside: row({ cwdKey: '/elsewhere/wt-x/sub' }),
    other: row({ cwdKey: '/x/other' }),
    noCwd: row({ cwdKey: null }),
  }
  const all = Object.values(rows)
  const context = { worktree: wtA, repo: { root, worktrees: [root, wtA, '/elsewhere/wt-x'] } }
  const idsOf = (result: ReturnType<typeof scopeRows>): string[] => (result.kind === 'rows' ? result.rows.map((entry) => entry.id) : [result.kind])

  it('현재 worktree = 같거나 그 아래 — `/…/A` 는 `/…/AB` 를 품지 않는다', () => {
    expect(idsOf(scopeRows({ rows: all, scope: 'worktree', context }))).toEqual([rows.inA.id, rows.underA.id])
  })
  it('프로젝트 = root 아래(지운 worktree 포함) 또는 연결 worktree 아래 — `/r/corral` 은 `/r/corral-specs` 를 품지 않는다', () => {
    expect(idsOf(scopeRows({ rows: all, scope: 'project', context }))).toEqual([rows.inA.id, rows.underA.id, rows.sibling.id, rows.deletedWt.id, rows.rootItself.id, rows.linkedOutside.id])
  })
  it('머신 전체 = 전부(cwd 없는 행 포함)', () => {
    expect(idsOf(scopeRows({ rows: all, scope: 'machine', context }))).toHaveLength(9)
  })
  it('활성 worktree 없음 → 빈 목록이 아니라 no-worktree (현재 worktree·프로젝트), 머신 전체는 그대로', () => {
    const none = { worktree: null, repo: null }
    expect(scopeRows({ rows: all, scope: 'worktree', context: none })).toEqual({ kind: 'no-worktree' })
    expect(scopeRows({ rows: all, scope: 'project', context: none })).toEqual({ kind: 'no-worktree' })
    expect(idsOf(scopeRows({ rows: all, scope: 'machine', context: none }))).toHaveLength(9)
  })
  it('경로 경계', () => {
    expect(isPathWithin({ child: '/a/foo', parent: '/a/foo' })).toBe(true)
    expect(isPathWithin({ child: '/a/foo/b', parent: '/a/foo/' })).toBe(true)
    expect(isPathWithin({ child: '/a/foobar', parent: '/a/foo' })).toBe(false)
    expect(isPathWithin({ child: '/a', parent: '/' })).toBe(true)
  })
})

describe('C5 검색', () => {
  const target = row({ cwdKey: '/w/Alpha', cwd: '/w/Alpha', title: 'Login Flaky Fix', branch: 'feat/Gamma', model: 'claude-Delta', firstPrompt: 'first Epsilon prompt', lastPrompt: 'last Zeta prompt' })
  const other = row({ cwdKey: '/w/other', cwd: '/w/other', title: 'unrelated', branch: 'main', model: 'gpt-x', firstPrompt: 'hello', lastPrompt: 'bye' })
  const rows = [target, other]
  const hit = (query: string): string[] => searchRows({ rows, query }).map((entry) => entry.id)
  it.each([
    ['제목', 'flaky'],
    ['cwd', 'ALPHA'],
    ['브랜치', 'gamma'],
    ['모델', 'delta'],
    ['첫 프롬프트', 'epsilon'],
    ['마지막 프롬프트', 'zeta'],
  ])('%s 적중 1 (대소문자 무시)', (_field, query) => {
    expect(hit(query)).toEqual([target.id])
  })
  it.each([
    ['제목', 'flakyy'],
    ['cwd', '/w/alphaz'],
    ['브랜치', 'feat/gammaz'],
    ['모델', 'claude-deltaz'],
    ['첫 프롬프트', 'epsilonz'],
    ['마지막 프롬프트', 'zetaz'],
  ])('%s 비적중 1', (_field, query) => {
    expect(hit(query)).toEqual([])
  })
  it('여러 낱말 = 모두 일치(AND) — 낱말마다 다른 칸이어도 된다', () => {
    expect(hit('flaky gamma')).toEqual([target.id])
    expect(hit('flaky bye')).toEqual([])
  })
  it('빈 검색어 = 그대로', () => {
    expect(hit('   ')).toEqual([target.id, other.id])
  })
})

describe('식별자·ui-prefs 읽기', () => {
  it('세션 id 는 UUID 꼴만', () => {
    expect(isSessionId('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isSessionId('../11111111-1111-4111-8111-111111111111')).toBe(false)
    expect(readSessionKey({ provider: 'codex', id: '11111111-1111-4111-8111-111111111111', extra: 1 })).toEqual({ provider: 'codex', id: '11111111-1111-4111-8111-111111111111' })
    expect(readSessionKey({ provider: 'grok', id: '11111111-1111-4111-8111-111111111111' })).toBeNull()
  })
  it('에이전트 필터 칸 — 칸마다 따로 기본(켬)', () => {
    expect(readHistoryAgents({ claude: false, codex: 'x' })).toEqual({ claude: false, codex: true })
    expect(readHistoryAgents(null)).toEqual({ claude: true, codex: true })
  })
})
