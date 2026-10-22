// LIFE-628 P1 — 골격 재구성 재시도 스케줄(리뷰 r3 N1): in-flight 중 0 · 끝난 때 기준 간격 · 백오프 · 성공 시 초기화 · 영구 원인 최대 간격·사유.
import { describe, expect, it } from 'vitest'
import { createRebuildScheduler, FRESH_REBUILD_MS, REBUILD_BACKOFF_MS, skeletonHealth } from './rebuild-retry.js'
import type { RepoSkeleton } from './tree.js'

const repo = (root: string, errors: { gitError?: string; openError?: string } = {}): RepoSkeleton => ({
  root, name: root, error: errors.gitError ?? null, gitError: errors.gitError ?? null, openError: errors.openError ?? null, worktrees: [],
})

describe('skeletonHealth', () => {
  it('오류 없음 = ok', () => {
    expect(skeletonHealth([repo('/a'), repo('/b')])).toEqual({ kind: 'ok' })
    expect(skeletonHealth([])).toEqual({ kind: 'ok' })
  })
  it('타임아웃 등 = transient', () => {
    expect(skeletonHealth([repo('/a', { gitError: 'Error: timeout' })])).toEqual({ kind: 'transient' })
    expect(skeletonHealth([repo('/a', { openError: 'timeout: slow' })])).toEqual({ kind: 'transient' })
  })
  it('not_git_worktree(사라진 루트 — 리뷰 r3 실측 모양)·git 이 못 들어감 = permanent, 사유에 루트', () => {
    const dead = repo('/gone-repo', { gitError: 'Error: Command failed: git -C /gone-repo worktree list --porcel', openError: 'not_git_worktree: Herdr worktree actions require a path inside a Git work tree' })
    const health = skeletonHealth([repo('/a'), dead])
    expect(health.kind).toBe('permanent')
    expect(health.kind === 'permanent' ? health.reason : '').toContain('/gone-repo')
    expect(skeletonHealth([repo('/x', { gitError: "fatal: cannot change to '/x': No such file or directory" })]).kind).toBe('permanent')
    expect(skeletonHealth([repo('/x', { gitError: 'fatal: not a git repository' })]).kind).toBe('permanent')
  })
})

describe('createRebuildScheduler', () => {
  const clock = (): { now: () => number; at: (t: number) => void } => {
    let t = 0
    return { now: () => t, at: (next) => { t = next } }
  }

  it('처음엔 바로 걸 수 있다', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    expect(s.due('error')).toBe(true)
    expect(s.due('fresh')).toBe(true)
  })
  it('① 진행 중 재구성이 있으면(아무리 오래 걸려도) 걸지 않는다 — 겹친 둘이 모두 끝나야 다시', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    s.started()
    s.started()
    c.at(600_000)
    expect(s.due('error')).toBe(false)
    expect(s.due('fresh')).toBe(false)
    s.finished(null)
    expect(s.due('error')).toBe(false)
    s.finished({ kind: 'transient' })
    c.at(600_000 + REBUILD_BACKOFF_MS[0]!)
    expect(s.due('error')).toBe(true)
  })
  it('② 간격은 끝난 때부터 — 10초 걸린 재구성 뒤 5초는 끝난 시각 + 5초', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    s.started()
    c.at(10_000)
    s.finished({ kind: 'transient' })
    c.at(14_999)
    expect(s.due('error')).toBe(false)
    c.at(15_000)
    expect(s.due('error')).toBe(true)
  })
  it('③ 연속 실패마다 5 → 15 → 60 → 60초', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    const waits: number[] = []
    for (let i = 0; i < 4; i += 1) {
      s.started()
      s.finished({ kind: 'transient' })
      waits.push(s.waitMs('error'))
    }
    expect(waits).toEqual([5_000, 15_000, 60_000, 60_000])
  })
  it('③ 성공하면 처음 간격으로 돌아간다', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    for (let i = 0; i < 3; i += 1) {
      s.started()
      s.finished({ kind: 'transient' })
    }
    s.started()
    s.finished({ kind: 'ok' })
    s.started()
    s.finished({ kind: 'transient' })
    expect(s.waitMs('error')).toBe(5_000)
  })
  it('④ 영구 원인은 첫 실패부터 최대 간격·사유, 성공하면 사유가 걷힌다', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    s.started()
    s.finished({ kind: 'permanent', reason: '루트 없음' })
    expect(s.waitMs('error')).toBe(60_000)
    expect(s.permanentReason()).toBe('루트 없음')
    c.at(59_999)
    expect(s.due('error')).toBe(false)
    c.at(60_000)
    expect(s.due('error')).toBe(true)
    s.started()
    s.finished({ kind: 'ok' })
    expect(s.permanentReason()).toBeNull()
  })
  it('세대 가드에 버려진 결과(null)는 실패·성공으로 세지 않는다(간격 기준 시각만 옮긴다)', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    s.started()
    s.finished({ kind: 'transient' })
    s.started()
    c.at(1_000)
    s.finished(null)
    expect(s.waitMs('error')).toBe(5_000)
    expect(s.due('error')).toBe(false)
    c.at(6_000)
    expect(s.due('error')).toBe(true)
  })
  it('fresh 재구성은 실패 수와 무관하게 5초 — 같은 in-flight·끝난 때 규칙', () => {
    const c = clock()
    const s = createRebuildScheduler({ now: c.now })
    s.started()
    s.finished({ kind: 'permanent', reason: 'x' })
    expect(s.waitMs('fresh')).toBe(FRESH_REBUILD_MS)
    c.at(FRESH_REBUILD_MS)
    expect(s.due('fresh')).toBe(true)
    s.started()
    expect(s.due('fresh')).toBe(false)
  })
})
