// LIFE-694 — corral 밖에서 닫힌 workspace 의 보존(C1·C2)과 붙을 카드가 없어진 보존 행 걷기(C3), 행 하나 걷기의 store 쪽(C5ⓑⓔ).
// store 에 herdr 이벤트를 먹이므로 어댑터 안에 둔다(경계 ①·④). 정책은 main 이 꽂는 것과 같은 `keepRetention`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceRow } from '../../../shared/types.js'
import { retainedByWorktree } from '../../../shared/sidebar-agents.js'
import { directoryNow, keepRetention, prunableRetained } from '../../retention.js'
import { WorkspaceStore } from './store.js'

const HOME = '/Users/me'
const ROOT = '/r'
const LIVE = '/r/.claude/worktrees/live'
const DEAD = '/r/.claude/worktrees/gone'
const WORKTREES = [ROOT, LIVE]

/** 워크스페이스 하나(w1) · 탭 하나 · pane 하나(done) — cwd 만 바꿔 쓴다. */
function snapshotOf(panes: Array<{ id: string; tab: string; cwd: string | null; status?: string }>): unknown {
  return {
    workspaces: [{ workspace_id: 'w1', label: 'ws', number: 1, focused: true }],
    tabs: [...new Set(panes.map((pane) => pane.tab))].map((tabId, index) => ({ tab_id: tabId, workspace_id: 'w1', label: tabId, number: index + 1 })),
    panes: panes.map((pane) => ({ pane_id: pane.id, tab_id: pane.tab, workspace_id: 'w1', agent_status: pane.status ?? 'done', ...(pane.cwd === null ? {} : { cwd: pane.cwd }) })),
  }
}

/** main 이 꽂는 정책과 같은 모양 — 카드 밖 목록(판정 가능이면 배열, 불가면 null)과 디스크를 가짜로 준다. */
function storeWith(input: { cardless: 'w1' | 'none' | 'undeterminable'; existing: readonly string[] }): WorkspaceStore {
  const store = new WorkspaceStore()
  store.setRetentionPolicy(({ workspaceId, cwds }) => keepRetention({
    workspaceId,
    cwds,
    cardless: input.cardless === 'undeterminable' ? null : input.cardless === 'w1' ? store.rows().filter((row) => row.workspaceId === 'w1') : [],
    homes: [HOME],
    worktreePaths: WORKTREES,
    isDirectory: (target) => input.existing.includes(target),
  }))
  return store
}

const retainedIds = (store: WorkspaceStore): string[] => store.retainedRows().map((row) => row.paneId)

describe('C1 — 카드 밖·주인 없음 workspace 를 corral 밖에서 닫으면 보존하지 않는다', () => {
  it('ⓐ cwd 가 사라진 죽은 worktree 자리', () => {
    const store = storeWith({ cardless: 'w1', existing: [] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: DEAD }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual([])
  })
  it('ⓑ cwd 가 남은 죽은 worktree 자리(폴더만)', () => {
    const store = storeWith({ cardless: 'w1', existing: [DEAD] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: `${DEAD}/apps/api` }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual([])
  })
  it('ⓒ cwd = HOME', () => {
    const store = storeWith({ cardless: 'w1', existing: [HOME] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual([])
  })
  it('탭 닫기·pane 닫기 길도 같다 — 사라지는 길과 무관하게 한 판정', () => {
    const tab = storeWith({ cardless: 'w1', existing: [HOME] })
    tab.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }, { id: 'p2', tab: 't2', cwd: HOME }]))
    tab.applyEvent({ event: 'tab_closed', data: { tab_id: 't1' } })
    expect(retainedIds(tab)).toEqual([])
    const pane = storeWith({ cardless: 'w1', existing: [HOME] })
    pane.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    pane.applyEvent({ event: 'pane_closed', data: { pane_id: 'p1' } })
    expect(retainedIds(pane)).toEqual([])
  })
  it('형제 pane 하나라도 경로가 살아 있으면 주인 없음이 아니다 — 보존한다(사라지기 전에 cwd 를 모아 묻는다)', () => {
    const store = storeWith({ cardless: 'w1', existing: [HOME, '/elsewhere'] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }, { id: 'p2', tab: 't1', cwd: '/elsewhere' }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store).sort()).toEqual(['p1', 'p2'])
  })
  it('cwd 가 하나도 없으면 판정 근거가 없어 보존한다', () => {
    const store = storeWith({ cardless: 'w1', existing: [] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: null }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual(['p1'])
  })
})

describe('C2 — 무회귀', () => {
  it('ⓐ 카드에 붙은 workspace 를 외부에서 닫으면 지금처럼 보존한다(cwd 가 HOME 이어도)', () => {
    const store = storeWith({ cardless: 'none', existing: [HOME] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual(['p1'])
  })
  it('ⓑ corral 이 스스로 닫은 것은 지금처럼 보존하지 않는다(억제 표)', () => {
    const store = storeWith({ cardless: 'none', existing: [LIVE] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: LIVE }]))
    store.suppressRetention('w1')
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual([])
  })
  it('ⓒ 판정 불가면 주인 없는 모양이어도 보존한다', () => {
    const store = storeWith({ cardless: 'undeterminable', existing: [] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual(['p1'])
    // 판정이 가능해진 뒤에는 C3 규칙만 — HOME 행은 죽은 자리가 아니라 걷지 않는다.
    expect(prunableRetained({ retained: store.retainedRows(), determinable: true, worktreePaths: WORKTREES })).toEqual([])
  })
  it('ⓓ done 이 아닌 pane 은 지금처럼 보존하지 않는다', () => {
    const store = storeWith({ cardless: 'none', existing: [LIVE] })
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: LIVE, status: 'working' }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual([])
  })
  it('정책이 없으면(시험·부팅 전) 지금처럼 보존한다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store)).toEqual(['p1'])
  })
  it('keepRetention — 카드 밖 목록에 없는 workspace 는 늘 보존', () => {
    const other: WorkspaceRow[] = []
    expect(keepRetention({ workspaceId: 'w1', cwds: [HOME], cardless: other, homes: [HOME], worktreePaths: WORKTREES, isDirectory: () => true })).toBe(true)
  })
  it('keepRetention — 확인 불가(null) 경로는 있음 쪽이다', () => {
    const cardless: WorkspaceRow[] = [{ workspaceId: 'w1', label: 'ws', number: 1, focused: false, agentStatus: 'unknown', tabs: [] }]
    expect(keepRetention({ workspaceId: 'w1', cwds: ['/Volumes/locked'], cardless, homes: [HOME], worktreePaths: WORKTREES, isDirectory: () => null })).toBe(true)
    expect(keepRetention({ workspaceId: 'w1', cwds: ['/Volumes/locked'], cardless, homes: [HOME], worktreePaths: WORKTREES, isDirectory: () => false })).toBe(false)
  })
})

describe('C3 — 붙을 카드가 없어진 보존 행은 공급에서 걷는다', () => {
  it('worktree 가 지워져 cwd 가 죽은 자리가 되면 걷고, 같은 경로에 새 worktree 를 만들어도 옛 행이 붙지 않는다', () => {
    const store = new WorkspaceStore()
    const slot = '/r/.claude/worktrees/feat'
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: slot }, { id: 'p2', tab: 't2', cwd: '/r/app' }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(retainedIds(store).sort()).toEqual(['p1', 'p2'])
    // worktree 가 살아 있는 동안은 걷지 않는다.
    expect(prunableRetained({ retained: store.retainedRows(), determinable: true, worktreePaths: [ROOT, slot] })).toEqual([])
    // 지워진 뒤 — 골격 갱신 후 판정 가능 상태에서 걷는다. main 의 일반 하위 폴더 행은 남는다.
    const gone = prunableRetained({ retained: store.retainedRows(), determinable: true, worktreePaths: [ROOT] })
    expect(gone).toEqual(['p1'])
    expect(store.dropRetained(gone)).toEqual(['p1'])
    expect(retainedIds(store)).toEqual(['p2'])
    // 같은 경로에 새 worktree — 옛 행은 이미 공급에 없다.
    const reborn = retainedByWorktree({ repos: [{ worktrees: [{ path: ROOT, workspace: null }, { path: slot, workspace: null }] }], retained: store.retainedRows() })
    expect(reborn.get(slot)).toBeUndefined()
  })
  it('판정 불가 동안에는 걷지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: DEAD }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(prunableRetained({ retained: store.retainedRows(), determinable: false, worktreePaths: WORKTREES })).toEqual([])
  })
})

describe('C5 store 쪽 — 행 하나 걷기(dropRetained)', () => {
  it('ⓑ 그 행만 빠진다 · ⓒ 다른 보존 행은 그대로 · ⓔ 모르는 id 는 무동작', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: LIVE }, { id: 'p2', tab: 't2', cwd: LIVE }]))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(store.dropRetained(['nope'])).toEqual([])
    expect(retainedIds(store).sort()).toEqual(['p1', 'p2'])
    expect(store.dropRetained(['p1'])).toEqual(['p1'])
    expect(retainedIds(store)).toEqual(['p2'])
    expect(store.dropRetained(['p1'])).toEqual([])
  })
})

describe('directoryNow — 사라지는 순간의 동기 확인', () => {
  it('디렉터리 true · 없음 false · 파일 false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l694-'))
    try {
      const file = path.join(dir, 'f')
      fs.writeFileSync(file, '')
      expect(directoryNow(dir)).toBe(true)
      expect(directoryNow(path.join(dir, 'missing'))).toBe(false)
      expect(directoryNow(file)).toBe(false)
      expect(directoryNow(path.join(file, 'under'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
