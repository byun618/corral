// LIFE-603 C2·C6 — 시작 모달 순수 모델: 기본 레포 고르는 순서 · 진행 단계 · 실패 행동.
import { describe, expect, it } from 'vitest'
import { testRepo, testWorktree } from '../../shared/test-rows.js'
import type { StartStage, StartWorkResult } from '../../shared/work-start.js'
import { alreadyLinked, defaultStartRepo, failureActions, progressRows, startSignature, startSucceeded, uniqueStartName } from './start-work-model.js'

const repos = [testRepo({ root: '/a', worktrees: [] }), testRepo({ root: '/b', worktrees: [] })]
const done = (patch: Partial<StartWorkResult['stages']> = {}, worktreePath: string | null = '/a/w'): StartWorkResult => ({
  attemptId: 'x', joined: false, done: true, worktreePath, linkSaved: true, sourceLink: null, refused: null,
  stages: { worktree: { status: 'completed', code: null, message: null }, agent: { status: 'completed', code: null, message: null }, prompt: { status: 'completed', code: null, message: null }, ...patch },
})

describe('defaultStartRepo — 스페이스 기본 레포 → 활성 레포 → 고르기', () => {
  it('고르는 순서', () => {
    const repoDefaults = [{ repoRoot: '/b', connectionId: 'c', spaceKey: 'S' }]
    expect(defaultStartRepo({ repos, repoDefaults, connectionId: 'c', spaceKey: 'S', activeRepoRoot: '/a' })).toBe('/b')
    expect(defaultStartRepo({ repos, repoDefaults, connectionId: 'c', spaceKey: 'OTHER', activeRepoRoot: '/a' })).toBe('/a')
    expect(defaultStartRepo({ repos, repoDefaults: [], connectionId: 'c', spaceKey: 'S', activeRepoRoot: null })).toBeNull()
  })
  it('등록되지 않은 레포는 기본이 되지 않는다', () => {
    expect(defaultStartRepo({ repos, repoDefaults: [{ repoRoot: '/gone', connectionId: 'c', spaceKey: 'S' }], connectionId: 'c', spaceKey: 'S', activeRepoRoot: '/gone' })).toBeNull()
  })
})

describe('progressRows — 3단계(빈 터미널 2단계)', () => {
  it('진행 중엔 트리에 worktree 가 보이면 첫 단계 완료 · 다음 진행', () => {
    expect(progressRows({ result: null, running: true, agent: 'claude', submit: false, worktreeSeen: false }).map((row) => row.status)).toEqual(['running', 'pending', 'pending'])
    expect(progressRows({ result: null, running: true, agent: 'claude', submit: false, worktreeSeen: true }).map((row) => row.status)).toEqual(['completed', 'running', 'pending'])
  })
  it('라벨 — 초안 넣기 / 보내기까지 / 빈 터미널', () => {
    expect(progressRows({ result: null, running: false, agent: 'claude', submit: false, worktreeSeen: false }).map((row) => row.label)).toEqual(['worktree 만들기', '에이전트 띄우기', '프롬프트 초안 넣기'])
    expect(progressRows({ result: null, running: false, agent: 'codex', submit: true, worktreeSeen: false })[2]?.label).toBe('프롬프트 보내기까지')
    expect(progressRows({ result: null, running: false, agent: 'shell', submit: false, worktreeSeen: false }).map((row) => row.label)).toEqual(['worktree 만들기', '터미널 열기'])
  })
})

describe('failureActions — 실패한 단계에 맞는 행동만', () => {
  it('worktree → 이름 · 에이전트 → 다시 띄우기 + 열기 · 프롬프트 → 열기 · 미확정도 실패로 다룬다 · 성공·거절은 없음', () => {
    expect(failureActions(done({ worktree: { status: 'failed', code: 'already_exists', message: null } }, null))).toEqual([{ kind: 'rename' }])
    expect(failureActions(done({ agent: { status: 'unknown', code: null, message: null } }))).toEqual([{ kind: 'relaunch' }, { kind: 'open' }])
    expect(failureActions(done({ prompt: { status: 'failed', code: 'agent_blocked', message: null } }))).toEqual([{ kind: 'open' }])
    expect(failureActions(done())).toEqual([])
    expect(failureActions({ ...done(), refused: '런타임이 아직 서지 않았습니다.' })).toEqual([])
  })
})

describe('startSignature — 입력이 같으면 같은 시도', () => {
  it('하나라도 다르면 다른 지문', () => {
    const base: Parameters<typeof startSignature>[0] = { repoRoot: '/a', name: 'K-1', agent: 'claude', model: '', effort: '', submit: false, prompt: 'p' }
    expect(startSignature(base)).toBe(startSignature({ ...base }))
    expect(startSignature(base)).not.toBe(startSignature({ ...base, submit: true }))
  })
})

describe('fix1 R1-A·B·P — 합류 · 미확정 · 줄에 넣음 · 이름 유일화', () => {
  const joined = done({ worktree: { status: 'skipped', code: 'already_linked', message: null }, agent: { status: 'skipped', code: 'already_linked', message: null }, prompt: { status: 'skipped', code: 'already_linked', message: null } })
  it('합류는 성공이 아니고 열기 · 다시 띄우기', () => {
    expect(alreadyLinked(joined)).toBe(true)
    expect(startSucceeded(joined)).toBe(false)
    expect(failureActions(joined)).toEqual([{ kind: 'open' }, { kind: 'relaunch' }])
    expect(alreadyLinked(done())).toBe(false)
  })
  it('worktree 미확정인데 경로가 보이면 열기, 없으면 이름 바꾸기', () => {
    expect(failureActions(done({ worktree: { status: 'unknown', code: 'outcome_unknown', message: null } }, '/a/w'))).toEqual([{ kind: 'open' }, { kind: 'relaunch' }])
    expect(failureActions(done({ worktree: { status: 'unknown', code: 'outcome_unknown', message: null } }, null))).toEqual([{ kind: 'rename' }])
  })
  it('줄에 넣음(queued)은 실패가 아니고 이유 문구가 붙는다', () => {
    const queued = done({ prompt: { status: 'queued', code: null, message: null } })
    expect(startSucceeded(queued)).toBe(true)
    expect(progressRows({ result: queued, running: false, agent: 'claude', submit: true, worktreeSeen: true })[2]).toMatchObject({ status: 'queued', note: '줄에 넣음 — 에이전트가 받았는지는 아직 모릅니다.' })
  })
  it('uniqueStartName — 브랜치 · 폴더 이름과 겹치면 -2, -3', () => {
    const taken = [testRepo({ root: '/a', worktrees: [testWorktree({ path: '/a/wt/K-1', branch: 'refs/heads/K-1' }), testWorktree({ path: '/a/wt/K-1-2', branch: 'other' })] })]
    expect(uniqueStartName({ base: 'K-1', repos: taken })).toBe('K-1-3')
    expect(uniqueStartName({ base: 'K-9', repos: taken })).toBe('K-9')
  })
})

describe('LIFE-813 C9 — setup 명령 실패는 성공으로 세지 않는다', () => {
  const failed: StartStage = { status: 'failed', code: 'setup_failed', message: 'Setup command failed (exit 1); log: /u/logs/x.log' }
  it('세 단계가 다 완료여도 setup 이 실패면 성공이 아니다 · 완료 · 건너뜀(없음)은 성공 그대로', () => {
    expect(startSucceeded(done())).toBe(true)
    expect(startSucceeded({ ...done(), setup: failed })).toBe(false)
    expect(startSucceeded({ ...done(), setup: { status: 'unknown', code: null, message: null } })).toBe(false)
    expect(startSucceeded({ ...done(), setup: { status: 'completed', code: null, message: null } })).toBe(true)
  })
  it('진행 줄에 worktree 다음 setup 줄이 메시지(로그 경로)와 함께 보인다 · 결과에 없으면 줄도 없다', () => {
    const rows = progressRows({ result: { ...done(), setup: failed }, running: false, agent: 'claude', submit: false, worktreeSeen: true })
    expect(rows.map((row) => [row.name, row.status])).toEqual([['worktree', 'completed'], ['setup', 'failed'], ['agent', 'completed'], ['prompt', 'completed']])
    expect(rows[1]?.note).toContain('/u/logs/x.log')
    expect(progressRows({ result: done(), running: false, agent: 'claude', submit: false, worktreeSeen: true }).map((row) => row.name)).toEqual(['worktree', 'agent', 'prompt'])
  })
  it('실패 행동 — worktree 가 있으면 열기', () => {
    expect(failureActions({ ...done(), setup: failed })).toEqual([{ kind: 'open' }])
  })
})
