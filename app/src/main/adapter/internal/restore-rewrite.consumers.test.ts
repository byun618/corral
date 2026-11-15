// LIFE-772 C3 소비자 칸 — 재시작 고쳐 쓰기로 herdr 참조가 S0 → X 로 바뀐 뒤 소비자가 무엇을 보는지 (합성: 손으로 지은 기록·행).
// 6 작업 사건 열쇠 · 8 attach 연결 증명(769 F13) · 10 멈춘 에이전트 표시. 실제 herdr·Claude Code 동작의 근거는 아니다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testDigest, testPane, testRepo, testWorktree } from '../../../shared/test-rows.js'
import type { AgentSessionRef, PaneRow, WorkspaceRow } from '../../../shared/types.js'
import type { WorkActivityChange } from '../../../shared/work.js'
import { RepoRegistry } from '../../registry.js'
import { orphanSources, type PathOracle } from '../../resource-ipc.js'
import { clearTranscriptCache } from '../../transcript.js'
import { clearContinuedMemo } from '../../transcript-continued.js'
import { MemoryActivity } from '../../work/activity-store.js'
import { WorkLinks, type LinkWorkPort } from '../../work/links.js'
import { makeContinuedProof } from './attach-session.js'
import { rewriteRestoreRefs } from './restore-rewrite.js'

const S0 = '00000000-0000-4000-8000-0000000000a0'
const X = '00000000-0000-4000-8000-0000000000b0'
const row = (value: unknown): string => `${JSON.stringify(value)}\n`
const talk = (id: string): string =>
  row({ type: 'user', sessionId: id, uuid: `u-${id}`, parentUuid: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'q' } }) +
  row({ type: 'assistant', sessionId: id, uuid: `a-${id}`, parentUuid: null, timestamp: '2026-01-01T00:00:02.000Z', message: { id: `m-${id}`, role: 'assistant', model: 'x', content: [{ type: 'text', text: 'r' }] } })
const fork = (to: string, from: string): string => row({ type: 'continued-in', timestamp: '2026-01-01T00:00:00.000Z', sessionId: from, continuedInSessionId: to })
const claudeRef = (id: string): AgentSessionRef => ({ kind: 'id', agent: 'claude', source: 'herdr:claude', id })

let home = ''
let realHome: string | undefined
let projects = ''

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l772c-'))
  realHome = process.env['HOME']
  process.env['HOME'] = home
  projects = path.join(home, '.claude', 'projects', 'proj')
  fs.mkdirSync(projects, { recursive: true })
  clearTranscriptCache()
  clearContinuedMemo()
})

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.rmSync(home, { recursive: true, force: true })
  clearTranscriptCache()
  clearContinuedMemo()
})

/** 고쳐 쓰기를 실제로 돌려 재시작 뒤 herdr 가 pane 에 되살릴 참조 값을 얻는다. */
function restartedRef(): string {
  fs.writeFileSync(path.join(projects, `${S0}.jsonl`), talk(S0) + fork(X, S0))
  fs.writeFileSync(path.join(projects, `${X}.jsonl`), talk(X))
  const sessionDir = path.join(home, 'session')
  fs.mkdirSync(sessionDir)
  const pane = { cwd: '/', agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: S0 } }
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ workspaces: [{ identity_cwd: '/', tabs: [{ panes: { '1': pane } }] }] }))
  expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('rewritten')
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8')).workspaces[0].tabs[0].panes['1'].agent_session.value
}

describe('C3 소비자 8 합성 — 769 attach 연결 증명(F13)', () => {
  it('store 에 남은 참조가 고친 X 면 증명은 null — 푼 값 X 를 그대로 내보낸다(X 는 대화가 있는 대상만 고르므로 빈 화면이 아니다)', () => {
    const after = restartedRef()
    expect(after).toBe(X)
    const proof = makeContinuedProof()
    expect(proof({ previous: claudeRef(after), resolvedId: X })).toBeNull()
  })
  it('양성 대조: store 에 옛 S0 가 남아 있으면 지금처럼 S0 로 증명된다(고쳐 쓰기는 기록 파일을 바꾸지 않는다)', () => {
    restartedRef()
    const proof = makeContinuedProof()
    expect(proof({ previous: claudeRef(S0), resolvedId: X })).toBe(S0)
  })
})

describe('C3 소비자 10 합성 — 멈춘 에이전트 표시(resource-ipc)', () => {
  const paths: PathOracle = { isDirectory: () => true, realPath: () => null, checked: () => true, settle: async () => true, fresh: async () => ({ exists: true, real: null }) }
  const workspace = (pane: PaneRow): WorkspaceRow => ({ workspaceId: 'w1', label: 'w', number: 1, agentStatus: 'idle', focused: false, tabs: [{ tabId: 't1', workspaceId: 'w1', label: 't', number: 1, order: 0, agentStatus: 'idle', focused: false, panes: [pane], digest: testDigest() }] })
  it('참조 값이 S0 든 X 든 멈춘 에이전트 종류만 본다 — 결과가 같다', () => {
    const before = orphanSources({ workspaces: [workspace(testPane({ agent: null, session: S0 }))], homes: [], paths })
    const after = orphanSources({ workspaces: [workspace(testPane({ agent: null, session: X }))], homes: [], paths })
    expect(after).toEqual(before)
    expect(before[0]?.stoppedAgents).toEqual(['claude'])
  })
})

describe('C3 소비자 6 합성 — 작업 사건 열쇠(work/links sessionOf)', () => {
  function fakeWork(): LinkWorkPort & { activity: MemoryActivity } {
    const activity = new MemoryActivity()
    let n = 0
    return {
      activity,
      refreshEvent: (input) => activity.refresh(input),
      storeAutoLink: async () => ({ state: 'skipped', message: 'x' }),
      linkConnections: () => [{ id: 'c-la', sourceId: 'la', keyPattern: 'LIFE-\\d+' }],
      repoDefaultConnection: () => null,
      recordEvent: ({ connectionId, itemId, itemKey, eventKey, change }: { connectionId: string; itemId: string | null; itemKey: string; eventKey: string; change: WorkActivityChange }) =>
        activity.append({ id: `r${++n}`, connectionId, itemId: itemId ?? '', itemKey, at: n, writeId: eventKey, eventKey, change }),
      storeLink: async () => ({ state: 'skipped', message: 'x' }),
    }
  }
  it('측정: 같은 마지막 턴 결과를 참조 S0 → X 로 다시 보면 결과 사건이 한 줄 더 남는다(열쇠에 세션 id) — 남는 한계', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l772w-'))
    try {
      const registry = () => new RepoRegistry(dir)
      const work = fakeWork()
      const digest = testDigest({ outcome: { outcome: 'completed' }, outcomeAt: 70 })
      const repos = (session: string) => [testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/wt', branch: 'LIFE-772-x', panes: [testPane({ paneId: 'p1', status: 'idle', session, digest })] })] })]
      const links = new WorkLinks({ registry, work: () => work, log: () => {} })
      links.observe(links.annotate(repos(S0)))
      links.observe(links.annotate(repos(S0)))
      const beforeRestart = work.activity.records.filter((record) => record.change.field === 'agent' && record.change.event === 'result').length
      links.observe(links.annotate(repos(X)))
      const afterRestart = work.activity.records.filter((record) => record.change.field === 'agent' && record.change.event === 'result').length
      expect(beforeRestart).toBe(1)
      expect(afterRestart).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
