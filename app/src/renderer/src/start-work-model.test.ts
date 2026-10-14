// LIFE-603 C2·C6 — 시작 모달 순수 모델: 기본 레포 고르는 순서 · 진행 단계 · 실패 행동.
import { describe, expect, it } from 'vitest'
import { testRepo } from '../../shared/test-rows.js'
import type { StartWorkResult } from '../../shared/work-start.js'
import { defaultStartRepo, failureActions, progressRows, startSignature } from './start-work-model.js'

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
    const base = { repoRoot: '/a', name: 'K-1', agent: 'claude' as const, model: '', effort: '', submit: false, prompt: 'p' }
    expect(startSignature(base)).toBe(startSignature({ ...base }))
    expect(startSignature(base)).not.toBe(startSignature({ ...base, submit: true }))
  })
})
