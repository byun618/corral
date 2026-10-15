// LIFE-603 C8·C9·C13 — 작업 링크: repos.json 영속(무손실 · 손상 버림 · 재시작 유지) · 떼기 예외 · 사건 기록 중복 0.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RepoRegistry } from '../registry.js'
import { MemoryActivity } from './activity-store.js'
import { WorkLinks, type LinkWorkPort } from './links.js'
import { testDigest, testPane, testRepo, testWorktree } from '../../shared/test-rows.js'
import type { WorkActivityChange, WorkLink } from '../../shared/work.js'
import type { StoredWorkLink } from '../../shared/work-link.js'
import type { StartSourceLink } from '../../shared/work-start.js'
import type { RepoRow } from '../../shared/types.js'

const env = { ...process.env }
const dirs: string[] = []
afterEach(() => {
  process.env = { ...env }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRegistry(): { dir: string; file: string; registry: () => RepoRegistry } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-links-'))
  dirs.push(dir)
  delete process.env.CORRAL_REGISTRY
  return { dir, file: path.join(dir, 'repos.json'), registry: () => new RepoRegistry(dir) }
}

/** 실제 활동 저장소 대신 메모리 — `recordEvent` 는 WorkService 와 같은 규칙(같은 eventKey 는 한 번). */
function fakeWork({ autoResult = { state: 'skipped', message: 'L1a' } }: { autoResult?: StartSourceLink | null } = {}): LinkWorkPort & { activity: MemoryActivity; stores: { link: WorkLink; action: string }[]; autoStores: { key: string; link: WorkLink }[] } {
  const activity = new MemoryActivity()
  const stores: { link: WorkLink; action: string }[] = []
  const autoStores: { key: string; link: WorkLink }[] = []
  let n = 0
  return {
    activity,
    stores,
    autoStores,
    refreshEvent: (input) => activity.refresh(input),
    storeAutoLink: async ({ key, link }) => { autoStores.push({ key, link }); return autoResult },
    linkConnections: () => [{ id: 'c-la', sourceId: 'la', keyPattern: 'LIFE-\\d+' }],
    repoDefaultConnection: () => null,
    recordEvent: ({ connectionId, itemId, itemKey, eventKey, change }: { connectionId: string; itemId: string | null; itemKey: string; eventKey: string; change: WorkActivityChange }) =>
      activity.append({ id: `r${++n}`, connectionId, itemId: itemId ?? '', itemKey, at: n, writeId: eventKey, eventKey, change }),
    storeLink: async ({ link, action }) => { stores.push({ link, action }); return { state: 'skipped', message: 'L1a' } },
  }
}

const LINK: StoredWorkLink = { sourceId: 'la', connectionId: 'c-la', itemId: 'uuid-603', key: 'LIFE-603', linkedAt: 1_760_000_000_000 }

/** 기존 v2 파일 — 지금 키 전부(LIFE-478·394 칸 포함). */
const V2 = {
  version: 2,
  repos: [{ id: 'repo-1', path: '/r', name: 'r', projectId: 'repo:repo-1', baseRef: 'main', displayName: 'R', worktreeBasePath: null, gitUsername: 'me', method: 'imported-existing-folder' }],
  setups: [{ id: 's-1', projectId: 'p-1', hostId: 'local', path: '/f', kind: 'folder', displayName: null, worktreeBasePath: null, gitUsername: null, state: 'ready', method: 'imported-existing-folder' }],
  worktrees: {
    '/r/.claude/worktrees/a': { repoId: 'repo-1', displayName: '이름', comment: '메모', linkedIssue: 12, linkedLinearIssue: { identifier: 'ENG-1', organizationKey: 'org', url: 'https://linear.app/org/issue/ENG-1' }, parentWorktreeId: 'repo-1::/r', workspaceStatus: 'in-review', createdBranch: true },
    '/r/.claude/worktrees/b': { repoId: 'repo-1', linkedIssue: null, linkedLinearIssue: null },
  },
}

describe('repos.json 작업 링크 칸 (C8)', () => {
  it('기존 v2 를 새 코드로 읽고 쓴 뒤 기존 키가 그대로다(무손실) — 링크 칸만 더해진다', () => {
    const { file, registry } = tempRegistry()
    fs.writeFileSync(file, JSON.stringify(V2, null, 2))
    const links = new WorkLinks({ registry, work: () => null, log: () => {} })
    expect(links.saveExplicit({ path: '/r/.claude/worktrees/b', link: LINK })).toBe(true)
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(after.repos).toEqual(V2.repos)
    expect(after.setups).toEqual(V2.setups)
    expect(after.worktrees['/r/.claude/worktrees/a']).toEqual(V2.worktrees['/r/.claude/worktrees/a'])
    expect(after.worktrees['/r/.claude/worktrees/b']).toEqual({ ...V2.worktrees['/r/.claude/worktrees/b'], workLink: LINK, workLinkSuppressed: false })
  })

  it('손상된 링크 값은 버리고 로그 — 레지스트리 전체는 산다(양성 대조: 같은 손상을 기존 칸에 넣으면 레지스트리가 죽는다)', () => {
    const { file, registry } = tempRegistry()
    const damaged = { ...V2, worktrees: { ...V2.worktrees, '/r/.claude/worktrees/b': { repoId: 'repo-1', workLink: { key: 7 }, workLinkSuppressed: 'yes' } } }
    fs.writeFileSync(file, JSON.stringify(damaged))
    const logs: unknown[] = []
    const links = new WorkLinks({ registry, work: () => null, log: (event, data) => logs.push({ event, data }) })
    const repos = links.annotate([testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/.claude/worktrees/b', branch: 'scratch' })] })])
    expect(repos[0]?.worktrees[0]?.workLink).toBeNull()
    expect(registry().metadata()['/r/.claude/worktrees/a']).toEqual(V2.worktrees['/r/.claude/worktrees/a'])
    expect(logs).toEqual([{ event: 'work.link_dropped', data: { dropped: [{ path: '/r/.claude/worktrees/b', field: 'workLink' }, { path: '/r/.claude/worktrees/b', field: 'workLinkSuppressed' }] } }])
    // 같은 손상이 계속 보여도 로그는 한 번(내보내기마다 쌓이지 않게).
    links.annotate([])
    expect(logs).toHaveLength(1)
    // 대조: 기존 칸(linkedIssue)의 손상은 지금처럼 레지스트리 오류다 — 새 칸만 너그럽다.
    fs.writeFileSync(file, JSON.stringify({ ...V2, worktrees: { '/x': { linkedIssue: 'seven' } } }))
    expect(() => registry().metadata()).toThrow('Invalid worktree metadata')
  })

  it('명시 링크는 새 인스턴스(앱 재시작)에서도 같고, 키 없는 브랜치에도 붙는다', () => {
    const { registry } = tempRegistry()
    new WorkLinks({ registry, work: () => null, log: () => {} }).saveExplicit({ path: '/r/wt', link: LINK })
    const work = fakeWork()
    const fresh = new WorkLinks({ registry, work: () => work, log: () => {} })
    const [repo] = fresh.annotate([testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/wt', branch: 'scratch' })] })])
    expect(repo?.worktrees[0]?.workLink).toEqual({ mode: 'explicit', sourceId: 'la', connectionId: 'c-la', key: 'LIFE-603', itemId: 'uuid-603', connected: true })
  })
})

describe('떼기 — 자동 연결 예외 (C9)', () => {
  const tree = (): RepoRow[] => [testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/wt', branch: 'LIFE-603-start' }), testWorktree({ path: '/r/other', branch: 'LIFE-12-x' })] })]
  it('자동 연결을 떼면 예외로 기억 — 재시작 뒤에도 다시 붙지 않는다, 다른 worktree 는 그대로', async () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    const before = links.annotate(tree())
    expect(before[0]?.worktrees.map((row) => row.workLink?.key ?? null)).toEqual(['LIFE-603', 'LIFE-12'])
    const target = before[0]!.worktrees[0]!
    expect(await links.detach({ worktree: target, repoRoot: '/r' })).toEqual({ ok: true, mode: 'auto', sourceLink: null })
    const restarted = new WorkLinks({ registry, work: () => work, log: () => {} }).annotate(tree())
    expect(restarted[0]?.worktrees.map((row) => row.workLink?.key ?? null)).toEqual([null, 'LIFE-12'])
    expect(work.activity.records.map((record) => record.change)).toEqual([{ field: 'run', event: 'detach', worktree: '/r/wt', branch: 'LIFE-603-start' }])
    expect(work.stores).toEqual([])
  })
  it('명시 링크를 떼면 지우고 예외로 둔다 — 브랜치 키로 다시 붙지 않는다, 출처 링크 지우기를 묻는다', async () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    links.saveExplicit({ path: '/r/wt', link: LINK })
    const target = links.annotate(tree())[0]!.worktrees[0]!
    expect(target.workLink?.mode).toBe('explicit')
    expect(await links.detach({ worktree: target, repoRoot: '/r' })).toEqual({ ok: true, mode: 'explicit', sourceLink: { state: 'skipped', message: 'L1a' } })
    expect(registry().metadata()['/r/wt']).toEqual({ workLinkSuppressed: true })
    expect(links.annotate(tree())[0]?.worktrees[0]?.workLink).toBeNull()
    expect(work.stores).toEqual([{ link: { kind: 'worktree', path: '/r/wt', repoRoot: '/r' }, action: 'remove' }])
  })
  it('링크 없는 worktree 떼기는 거절', async () => {
    const { registry } = tempRegistry()
    const links = new WorkLinks({ registry, work: () => fakeWork(), log: () => {} })
    expect(await links.detach({ worktree: testWorktree({ path: '/r/x', branch: 'main' }), repoRoot: '/r' })).toMatchObject({ ok: false })
  })
})

describe('사건 기록 — 같은 사건은 한 번 (C13)', () => {
  const QUESTION = [{ question: '이 파일을 지울까요?', header: null, options: [{ label: 'Yes', description: null }], multiSelect: false }]
  const linked = (panes: ReturnType<typeof testPane>[]) => [testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/wt', branch: 'LIFE-603-start', panes, git: { unstaged: 2, untracked: 1 } })] })]
  it('자동 연결 · 질문(본문) · 턴 결과를 남기고, 재방송 · 재시작(새 인스턴스)에 중복 0', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const panes = [
      testPane({ paneId: 'p1', status: 'blocked', reason: 'question', digest: testDigest({ questions: QUESTION, lastActivityAt: 50 }) }),
      testPane({ paneId: 'p2', status: 'done', digest: testDigest({ outcome: { outcome: 'completed' }, outcomeAt: 70 }) }),
    ]
    for (let round = 0; round < 3; round += 1) {
      const links = new WorkLinks({ registry, work: () => work, log: () => {} })
      links.observe(links.annotate(linked(panes)))
      links.observe(links.annotate(linked(panes)))
    }
    expect(work.activity.records.map((record) => record.change)).toEqual([
      { field: 'run', event: 'auto_link', worktree: '/r/wt', branch: 'LIFE-603-start' },
      { field: 'agent', event: 'question', agent: 'claude', worktree: '/r/wt', question: '이 파일을 지울까요?', noBody: null },
      { field: 'agent', event: 'result', agent: 'claude', worktree: '/r/wt', outcome: 'completed', detail: null, filesChanged: 3 },
    ])
    expect(work.activity.records.every((record) => record.itemKey === 'LIFE-603' && record.itemId === '')).toBe(true)
  })
  it('질문 본문을 못 읽는 에이전트는 본문 null + 이유, 새 턴 결과는 새 사건', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    links.observe(links.annotate(linked([testPane({ paneId: 'g', agent: 'grok', status: 'blocked', reason: 'question' })])))
    links.observe(links.annotate(linked([testPane({ paneId: 'g', agent: 'grok', status: 'idle', digest: testDigest({ outcome: { outcome: 'failed', error: 'rate_limit' }, outcomeAt: 10 }) })])))
    links.observe(links.annotate(linked([testPane({ paneId: 'g', agent: 'grok', status: 'idle', digest: testDigest({ outcome: { outcome: 'completed' }, outcomeAt: 20 }) })])))
    expect(work.activity.records.map((record) => record.change).filter((change) => change.field === 'agent')).toEqual([
      { field: 'agent', event: 'question', agent: 'grok', worktree: '/r/wt', question: null, noBody: '이 에이전트의 질문 본문은 읽지 못합니다.' },
      { field: 'agent', event: 'result', agent: 'grok', worktree: '/r/wt', outcome: 'failed', detail: 'rate_limit', filesChanged: 3 },
      { field: 'agent', event: 'result', agent: 'grok', worktree: '/r/wt', outcome: 'completed', detail: null, filesChanged: 3 },
    ])
  })
  it('일하는 중의 결과 · 결과 시각 없음 · 셸 pane · 링크 없는 worktree 는 남기지 않는다', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    links.observe(links.annotate(linked([
      testPane({ paneId: 'a', status: 'working', digest: testDigest({ outcome: { outcome: 'completed' }, outcomeAt: 5 }) }),
      testPane({ paneId: 'b', status: 'idle', digest: testDigest({ outcome: { outcome: 'completed' }, outcomeAt: null }) }),
      testPane({ paneId: 'c', agent: null, status: 'blocked', reason: 'question' }),
    ])))
    links.observe(links.annotate([testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/main', branch: 'main', panes: [testPane({ status: 'blocked', reason: 'question' })] })] })]))
    expect(work.activity.records.map((record) => record.change.field)).toEqual(['run'])
  })
})

describe('fix1 — 질문 표기 · 바뀐 파일 수 · 자동 연결 출처 저장', () => {
  const linkedWith = ({ panes, unstaged = 0 }: { panes: ReturnType<typeof testPane>[]; unstaged?: number }) =>
    [testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/wt', branch: 'LIFE-603-start', panes, git: { unstaged } })] })]
  const questions = (work: ReturnType<typeof fakeWork>) => work.activity.records.map((record) => record.change).filter((change) => change.field === 'agent' && change.event === 'question')
  it('R1-T grok 지문에 질문이 있으면 본문을 그대로 남긴다(숨기지 않는다)', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    const asked = [{ question: '어느 브랜치로?', header: null, options: [], multiSelect: null }]
    links.observe(links.annotate(linkedWith({ panes: [testPane({ paneId: 'g', agent: 'grok', status: 'blocked', reason: 'question', digest: testDigest({ questions: asked }) })] })))
    expect(questions(work)).toEqual([{ field: 'agent', event: 'question', agent: 'grok', worktree: '/r/wt', question: '어느 브랜치로?', noBody: null }])
  })
  it('R1-T grok 지문에 질문이 없으면 본문 null + 이유', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    links.observe(links.annotate(linkedWith({ panes: [testPane({ paneId: 'g', agent: 'grok', status: 'blocked', reason: 'question', digest: testDigest({ questions: null }) })] })))
    expect(questions(work)).toEqual([{ field: 'agent', event: 'question', agent: 'grok', worktree: '/r/wt', question: null, noBody: '이 에이전트의 질문 본문은 읽지 못합니다.' }])
  })
  it('R1-N 권한 대기는 권한 문구, 빈 질문 목록(`[]`)은 질문이 아니다(사유가 question 이면 본문 없음 이유)', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    links.observe(links.annotate(linkedWith({ panes: [
      testPane({ paneId: 'a', status: 'blocked', reason: 'permission', digest: testDigest({ lastActivityAt: 1 }) }),
      testPane({ paneId: 'b', status: 'idle', digest: testDigest({ questions: [], lastActivityAt: 2 }) }),
      testPane({ paneId: 'c', status: 'blocked', reason: 'question', digest: testDigest({ questions: [], lastActivityAt: 3 }) }),
    ] })))
    expect(questions(work).map((change) => (change.field === 'agent' && change.event === 'question' ? change.noBody : null))).toEqual([
      '권한 승인을 기다립니다 — 에이전트 화면에서 확인하세요.',
      '이 에이전트의 질문 본문은 읽지 못합니다.',
    ])
  })
  it('R1-L 본문 있는 질문은 기다리는 동안 기록 시각이 움직여도 한 번', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    const asked = [{ question: '지울까요?', header: null, options: [], multiSelect: null }]
    for (const at of [10, 20, 30]) links.observe(links.annotate(linkedWith({ panes: [testPane({ paneId: 'p', status: 'blocked', reason: 'question', digest: testDigest({ questions: asked, lastActivityAt: at }) })] })))
    expect(questions(work)).toHaveLength(1)
  })
  it('R1-M 결과 뒤 창 안에서는 바뀐 파일 수를 고치고, 창 밖에서는 굳힌다', () => {
    const { registry } = tempRegistry()
    const work = fakeWork()
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    const fresh = Date.now()
    const pane = (outcomeAt: number) => testPane({ paneId: 'p', status: 'idle', digest: testDigest({ outcome: { outcome: 'completed' }, outcomeAt }) })
    links.observe(links.annotate(linkedWith({ panes: [pane(fresh)], unstaged: 0 })))
    links.observe(links.annotate(linkedWith({ panes: [pane(fresh)], unstaged: 4 })))
    const old = fresh - 120_000
    links.observe(links.annotate(linkedWith({ panes: [pane(old)], unstaged: 1 })))
    links.observe(links.annotate(linkedWith({ panes: [pane(old)], unstaged: 9 })))
    const results = work.activity.records.map((record) => record.change).flatMap((change) => (change.field === 'agent' && change.event === 'result' ? [change.filesChanged] : []))
    expect(results).toEqual([4, 1])
  })
  it('R1-I 자동 연결은 출처 저장을 한 번 부른다 — 결과 미정(null)이면 다음 관측에서 다시, 실패면 활동에 남긴다', async () => {
    const { registry } = tempRegistry()
    let answer: StartSourceLink | null = null
    const work = fakeWork()
    const calls: string[] = []
    work.storeAutoLink = async ({ key, link }) => { calls.push(`${key}:${link.kind === 'worktree' ? link.path : ''}`); return answer }
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    const tick = async () => { links.observe(links.annotate(linkedWith({ panes: [] }))); await new Promise((resolve) => setTimeout(resolve, 0)) }
    await tick()
    expect(calls).toEqual(['LIFE-603:/r/wt'])
    answer = { state: 'failed', message: '출처에서 LIFE-603 를 찾지 못했습니다.' }
    await tick()
    await tick()
    expect(calls).toEqual(['LIFE-603:/r/wt', 'LIFE-603:/r/wt'])
    expect(work.activity.records.map((record) => record.change).filter((change) => change.field === 'run')).toEqual([
      { field: 'run', event: 'auto_link', worktree: '/r/wt', branch: 'LIFE-603-start' },
      { field: 'run', event: 'source_link_failed', worktree: '/r/wt', message: '출처에서 LIFE-603 를 찾지 못했습니다.' },
    ])
  })
  it('R1-I 출처가 저장했거나 닫혀 있으면(skipped) 실패 사건이 없다', async () => {
    const { registry } = tempRegistry()
    const work = fakeWork({ autoResult: { state: 'saved', message: null } })
    const links = new WorkLinks({ registry, work: () => work, log: () => {} })
    links.observe(links.annotate(linkedWith({ panes: [] })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    links.observe(links.annotate(linkedWith({ panes: [] })))
    expect(work.autoStores).toHaveLength(1)
    expect(work.activity.records.map((record) => record.change.field === 'run' ? record.change.event : null)).toEqual(['auto_link'])
  })
})
