// LIFE-603 C10·C12 — 링크된 worktree 의 점·라벨·급한 순서·질문 본문, 작업 중 보기 전환.
import { describe, expect, it } from 'vitest'
import type { AgentStatus, BlockedReason } from '../../shared/types.js'
import { testDigest, testPane, testRepo, testWorktree } from '../../shared/test-rows.js'
import type { WorktreeWorkLink } from '../../shared/work-link.js'
import { buildAgentRows } from './sidebar-agents.js'
import { chipOf, linkedTrees, loudLabel, treesFor, workingFromLinks, worktreeDot } from './work-links-model.js'

const auto = (key: string): WorktreeWorkLink => ({ mode: 'auto', sourceId: 'la', connectionId: 'c1', key, itemId: null, connected: true })
const explicit = (key: string, itemId: string): WorktreeWorkLink => ({ mode: 'explicit', sourceId: 'la', connectionId: 'c1', key, itemId, connected: true })

describe('C10 같은 pane 입력 → 사이드바와 같은 점', () => {
  const statuses: AgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown']
  const reasons: (BlockedReason | null)[] = [null, 'trust', 'question', 'permission', 'login']
  it('상태 × 막힘 사유 × 안 읽음 × 질문 본문 전 조합', () => {
    let compared = 0
    for (const status of statuses) for (const reason of reasons) for (const unread of [false, true]) for (const questions of [null, [{ question: '진행할까요?', header: null, options: [], multiSelect: false }]]) {
      const pane = testPane({ paneId: 'p1', status, reason, digest: testDigest({ questions }) })
      const worktree = testWorktree({ path: '/r/w', branch: 'LIFE-1-x', panes: [pane], workLink: auto('LIFE-1') })
      const unreadPanes = new Set(unread ? ['p1'] : [])
      const sidebar = buildAgentRows({ tabs: worktree.workspace?.tabs ?? [], retained: [], lineage: { state: 'ready', entries: [] }, livePaneIds: new Set(['p1']), integrations: [], home: '/', unreadPanes })
      const [tree] = linkedTrees({ repos: [testRepo({ root: '/r', worktrees: [worktree] })], unreadPanes })
      expect([status, reason, unread, questions !== null, tree?.dot]).toEqual([status, reason, unread, questions !== null, sidebar[0]?.dot])
      expect(worktreeDot({ worktree, unreadPanes })).toBe(sidebar[0]?.dot)
      compared += 1
    }
    expect(compared).toBe(statuses.length * reasons.length * 4)
  })
})

describe('C10 급한 순 · 큰소리 라벨 · 질문 본문', () => {
  const repos = [testRepo({ root: '/r', worktrees: [
    testWorktree({ path: '/r/idle', branch: 'LIFE-1-a', panes: [testPane({ paneId: 'a', status: 'idle' })], workLink: auto('LIFE-1') }),
    testWorktree({ path: '/r/work', branch: 'LIFE-1-b', panes: [testPane({ paneId: 'b', status: 'working' })], workLink: auto('LIFE-1') }),
    testWorktree({ path: '/r/ask', branch: 'LIFE-1-c', panes: [testPane({ paneId: 'c', status: 'blocked', reason: 'question', digest: testDigest({ questions: [{ question: '테스트를 지울까요?', header: null, options: [], multiSelect: false }] }) })], workLink: auto('LIFE-1') }),
    testWorktree({ path: '/r/other', branch: 'LIFE-2-x', panes: [testPane({ paneId: 'd', status: 'working' })], workLink: auto('LIFE-2') }),
    testWorktree({ path: '/r/plain', branch: 'main', panes: [testPane({ paneId: 'e', status: 'working' })] }),
  ] })]
  const trees = linkedTrees({ repos, unreadPanes: new Set() })
  it('링크 없는 worktree 는 빠지고, 작업마다 급한 순(질문 대기 > 일하는 중 > 쉼)', () => {
    expect(trees.map((tree) => tree.path)).not.toContain('/r/plain')
    const mine = treesFor({ trees, connectionId: 'c1', itemId: 'id-1', key: 'LIFE-1' })
    expect(mine.map((tree) => tree.dot)).toEqual(['waiting', 'working', 'idle'])
    expect(chipOf(mine)).toMatchObject({ tree: { path: '/r/ask' }, more: 2 })
    expect(loudLabel(mine[0]?.dot ?? null)).toBe('질문 대기')
    expect(loudLabel('working')).toBeNull()
    expect(loudLabel('done')).toBe('끝남 안 봄')
  })
  it('질문 대기면 본문과 그 pane — 본문 없는 에이전트(grok)는 본문 공백 + 이유', () => {
    expect(trees.find((tree) => tree.path === '/r/ask')?.question).toEqual({ paneId: 'c', text: '테스트를 지울까요?', reason: null })
    const grok = linkedTrees({ repos: [testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/g', branch: 'LIFE-3', panes: [testPane({ paneId: 'g', agent: 'grok', status: 'blocked', reason: 'question' })], workLink: auto('LIFE-3') })] })], unreadPanes: new Set() })
    expect(grok[0]?.dot).toBe('waiting')
    expect(grok[0]?.question).toEqual({ paneId: 'g', text: null, reason: '이 에이전트의 질문 본문은 읽지 못합니다.' })
  })
  it('명시 링크는 작업 id 로, 자동 링크는 키로 맞춘다', () => {
    const both = linkedTrees({ repos: [testRepo({ root: '/r', worktrees: [
      testWorktree({ path: '/r/x', branch: 'scratch', panes: [], workLink: explicit('LIFE-9', 'id-9') }),
      testWorktree({ path: '/r/y', branch: 'LIFE-9-y', panes: [], workLink: auto('LIFE-9') }),
    ] })], unreadPanes: new Set() })
    expect(treesFor({ trees: both, connectionId: 'c1', itemId: 'id-9', key: 'LIFE-9' }).map((tree) => tree.path).sort()).toEqual(['/r/x', '/r/y'])
    expect(treesFor({ trees: both, connectionId: 'c1', itemId: 'other', key: 'LIFE-8' })).toEqual([])
  })
})

describe('C12 작업 중 보기 = 링크 모델', () => {
  it('명시 링크(키 없는 브랜치)는 들어오고, 링크 없음(떼기 = main 이 null)·닫힌·연결 해제는 빠진다', () => {
    const trees = linkedTrees({ repos: [testRepo({ root: '/r', worktrees: [
      testWorktree({ path: '/r/explicit', branch: 'scratch', panes: [], workLink: explicit('LIFE-5', 'id-5') }),
      testWorktree({ path: '/r/detached', branch: 'LIFE-6-x', panes: [], workLink: null }),
      testWorktree({ path: '/r/closed', branch: 'LIFE-7-x', workLink: auto('LIFE-7'), open: false }),
      testWorktree({ path: '/r/gone', branch: 'LIFE-8-x', panes: [], workLink: { ...auto('LIFE-8'), connected: false } }),
    ] })], unreadPanes: new Set() })
    expect(workingFromLinks(trees).map((entry) => [entry.key, entry.trees.map((tree) => tree.path)])).toEqual([['LIFE-5', ['/r/explicit']]])
  })
})

describe('fix1 R1-N·T — 질문 칩 본문·이유', () => {
  const one = (pane: ReturnType<typeof testPane>) => linkedTrees({ repos: [testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/q', branch: 'LIFE-4', panes: [pane], workLink: auto('LIFE-4') })] })], unreadPanes: new Set() })[0]?.question
  it('grok 지문에 질문이 있으면 본문을 보인다(숨기지 않는다)', () => {
    expect(one(testPane({ paneId: 'g', agent: 'grok', status: 'blocked', reason: 'question', digest: testDigest({ questions: [{ question: '어느 쪽?', header: null, options: [], multiSelect: null }] }) }))).toEqual({ paneId: 'g', text: '어느 쪽?', reason: null })
  })
  it('grok 지문에 질문이 없으면 본문 null + 이유', () => {
    expect(one(testPane({ paneId: 'g', agent: 'grok', status: 'blocked', reason: 'question', digest: testDigest({ questions: null }) }))).toEqual({ paneId: 'g', text: null, reason: '이 에이전트의 질문 본문은 읽지 못합니다.' })
  })
  it('권한 대기는 권한 문구 — 「질문 본문을 못 읽음」 이 아니다', () => {
    expect(one(testPane({ paneId: 'p', status: 'blocked', reason: 'permission' }))).toEqual({ paneId: 'p', text: null, reason: '권한 승인을 기다립니다 — 에이전트 화면에서 확인하세요.' })
  })
  it('빈 질문 목록(`[]`)은 본문 없음과 같다 — 이유가 붙는다', () => {
    expect(one(testPane({ paneId: 'p', status: 'blocked', reason: 'question', digest: testDigest({ questions: [] }) }))).toEqual({ paneId: 'p', text: null, reason: '이 에이전트의 질문 본문은 읽지 못합니다.' })
  })
})
