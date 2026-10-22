// LIFE-628 G7 — 어댑터 `probeForeground` 의 `pane_not_found → missing:true` 매핑, `readOpenWorkspaces` 의 `is_prunable` 읽기.
// herdr 요청은 가짜(`request` 모킹) — 응답 모양만 바꾼다.
import { describe, expect, it, vi } from 'vitest'

const reply = vi.hoisted((): { next: unknown } => ({ next: null }))
vi.mock('./request.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request.js')>()
  return { ...actual, request: vi.fn(async () => reply.next) }
})

const { probeForeground } = await import('./lifecycle.js')
const { readOpenWorkspaces } = await import('./worktrees.js')

describe('probeForeground — 런타임 없음 구분 (LIFE-628 G7)', () => {
  it('pane_not_found 면 missing:true', async () => {
    reply.next = { id: 'x', error: { code: 'pane_not_found', message: 'pane wC5:p9 not found' } }
    expect(await probeForeground('/s', 'wC5:p9')).toMatchObject({ ok: false, missing: true, shellPid: null })
  })
  it('다른 오류는 missing:false (실행 중 쪽으로 기우는 판정 실패)', async () => {
    reply.next = { id: 'x', error: { code: 'timeout', message: 'slow' } }
    expect(await probeForeground('/s', 'p')).toMatchObject({ ok: false, missing: false })
  })
  it('정상 응답은 missing:false', async () => {
    reply.next = { id: 'x', result: { process_info: { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [] } } }
    expect(await probeForeground('/s', 'p')).toMatchObject({ ok: true, missing: false, shellPid: 10 })
  })
})

describe('readOpenWorkspaces — is_prunable (LIFE-628 G2)', () => {
  it('prunable 경로도 byPath 에는 싣고 prunable 에 따로 적는다(열린 id 가 없는 줄은 둘 다 없음)', async () => {
    reply.next = { id: 'x', result: { worktrees: [
      { path: '/nonexistent-l628/repo', open_workspace_id: 'w1', is_prunable: false },
      { path: '/nonexistent-l628/gone', open_workspace_id: 'w2', is_prunable: true },
      { path: '/nonexistent-l628/closed', is_prunable: true },
    ], source: { repo_name: 'repo' } } }
    const open = await readOpenWorkspaces('/s', '/nonexistent-l628/repo')
    expect([...open.byPath]).toEqual([['/nonexistent-l628/repo', 'w1'], ['/nonexistent-l628/gone', 'w2']])
    expect([...open.prunable]).toEqual(['/nonexistent-l628/gone'])
  })
})
