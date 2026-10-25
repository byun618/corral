// LIFE-694 — corral 밖에서 닫힌 workspace 의 보존(C1·C2)과 붙을 카드가 없어진 보존 행 걷기(C3), 행 하나 걷기의 store 쪽(C5ⓑⓔ).
// store 에 herdr 이벤트를 먹이므로 어댑터 안에 둔다(경계 ①·④). 정책은 main 이 꽂는 것과 같은 `keepRetention` 이고,
// 죽은 자리는 main 과 같은 `confirmedDeadSlot`(목록 + 실제 파일시스템 확인, r1 리뷰 F1)으로 정한다 — 그래서 자리는 임시 디렉터리에 실제로 만든다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkspaceRow } from '../../../shared/types.js'
import { retainedByWorktree } from '../../../shared/sidebar-agents.js'
import { confirmedDeadSlot, directoryNow, keepRetention, prunableRetained, slotStateNow, slotStateOf } from '../../retention.js'
import { WorkspaceStore, type RetentionPolicy } from './store.js'

let TMP = ''
let ROOT = ''
let HOME = ''
/** 살아 있는 linked worktree — 목록에 있고 `.git` 이 있다. */
let LIVE = ''
/** 지워지고 폴더도 없는 자리. */
let GONE = ''
/** 지워졌지만 빌드 결과 폴더만 남은 자리(`.git` 없음 — LIFE-697 잔재). */
let FOLDER = ''
/** 골격이 아직 모르는 새 worktree — 목록에 없지만 `.git` 이 있다(r1 리뷰 Grok 2). */
let FRESH = ''
/** 접근 거부로 목록에서 빠진 worktree — 안을 못 읽는다(r1 리뷰 Grok 3). */
let LOCKED = ''
/** 심링크 자리 — 목록에는 실경로만 있다(r1 리뷰 Claude R6). */
let LINKED = ''
let WORKTREES: string[] = []

const mkdir = (target: string): void => {
  fs.mkdirSync(target, { recursive: true })
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'l694f-'))
  ROOT = path.join(TMP, 'r')
  HOME = path.join(TMP, 'home')
  const slot = (name: string): string => path.join(ROOT, '.claude/worktrees', name)
  LIVE = slot('live')
  GONE = slot('gone')
  FOLDER = slot('LIFE-608')
  FRESH = slot('fresh')
  LOCKED = slot('locked')
  LINKED = slot('linked')
  for (const dir of [HOME, path.join(ROOT, 'app'), path.join(LIVE, 'src'), path.join(FOLDER, 'apps/api'), FRESH, LOCKED]) mkdir(dir)
  for (const dir of [LIVE, FRESH, LOCKED]) fs.writeFileSync(path.join(dir, '.git'), 'gitdir: x\n')
  const real = path.join(TMP, 'elsewhere/linked')
  mkdir(path.join(real, 'src'))
  fs.writeFileSync(path.join(real, '.git'), 'gitdir: x\n')
  fs.symlinkSync(real, LINKED)
  fs.chmodSync(LOCKED, 0o000)
  // 골격 목록 — main · 살아 있는 worktree · 심링크 자리의 **실경로**. FRESH·LOCKED·LINKED(논리 경로)는 목록에 없다.
  WORKTREES = [ROOT, LIVE, real]
})

afterAll(() => {
  fs.chmodSync(LOCKED, 0o755)
  fs.rmSync(TMP, { recursive: true, force: true })
})

/** main 과 같은 죽은 자리 판정 — 목록 + 실제 파일시스템. */
const deadSlot = (target: string): boolean => confirmedDeadSlot({ path: target, worktreePaths: WORKTREES, slotState: slotStateNow })

/** 워크스페이스 하나(w1) — pane 마다 탭·cwd·상태를 준다. */
function snapshotOf(panes: Array<{ id: string; tab: string; cwd: string | null; status?: string }>): unknown {
  return {
    workspaces: [{ workspace_id: 'w1', label: 'ws', number: 1, focused: true }],
    tabs: [...new Set(panes.map((pane) => pane.tab))].map((tabId, index) => ({ tab_id: tabId, workspace_id: 'w1', label: tabId, number: index + 1 })),
    panes: panes.map((pane) => ({ pane_id: pane.id, tab_id: pane.tab, workspace_id: 'w1', agent_status: pane.status ?? 'done', ...(pane.cwd === null ? {} : { cwd: pane.cwd }) })),
  }
}

/** main 이 꽂는 정책과 같은 모양 — 카드 밖 목록(판정 가능이면 store 의 지금 행, 불가면 null). 디스크는 실제. 호출 기록도 남긴다. */
function storeWith(cardless: 'w1' | 'none' | 'undeterminable'): { store: WorkspaceStore; calls: Array<{ workspaceId: string; cwd: string | null; keep: boolean }> } {
  const store = new WorkspaceStore()
  const calls: Array<{ workspaceId: string; cwd: string | null; keep: boolean }> = []
  const policy: RetentionPolicy = ({ workspaceId, cwd }) => {
    const keep = keepRetention({
      workspaceId,
      cwd,
      cardless: cardless === 'undeterminable' ? null : cardless === 'w1' ? store.rows().filter((row) => row.workspaceId === 'w1') : [],
      homes: [HOME],
      isDirectory: directoryNow,
      isDeadSlot: deadSlot,
    })
    calls.push({ workspaceId, cwd, keep })
    return keep
  }
  store.setRetentionPolicy(policy)
  return { store, calls }
}

const retainedIds = (store: WorkspaceStore): string[] => store.retainedRows().map((row) => row.paneId).sort()
const closeWorkspace = (store: WorkspaceStore): void => {
  store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
}

describe('자리 뿌리 파일시스템 확인 (F1)', () => {
  it('뿌리 없음·`.git` 없음 = dead, `.git` 있음·심링크 너머 `.git` = alive, 접근 거부 = unknown', async () => {
    const roots = [GONE, FOLDER, LIVE, FRESH, LINKED, LOCKED]
    const sync = roots.map(slotStateNow)
    expect(sync).toEqual(['dead', 'dead', 'alive', 'alive', 'alive', 'unknown'])
    expect(await Promise.all(roots.map(slotStateOf))).toEqual(sync)
  })
  it('확인된 죽은 자리 = 목록 판정 + 파일시스템 둘 다', () => {
    expect([GONE, `${FOLDER}/apps/api`].map(deadSlot)).toEqual([true, true])
    // 목록으로는 죽은 자리지만 파일시스템이 아니라고 하는 셋 — 거짓 양성이던 자리다.
    expect([FRESH, LOCKED, `${LINKED}/src`].map(deadSlot)).toEqual([false, false, false])
    // 목록으로도 아닌 자리는 파일시스템을 보지 않고 아니다.
    expect([LIVE, `${ROOT}/app`, HOME].map(deadSlot)).toEqual([false, false, false])
  })
})

describe('C1 — 카드 밖 workspace 의 pane 을 corral 밖에서 닫으면, 그 cwd 가 주인 없음이면 보존하지 않는다', () => {
  it('ⓐ cwd 가 사라진 죽은 worktree 자리', () => {
    const { store } = storeWith('w1')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: GONE }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual([])
  })
  it('ⓑ cwd 가 남은 죽은 worktree 자리(하위 폴더가 디렉터리로 남음 — 디렉터리 없음 갈래가 아니라 자리 갈래로 빠진다, F5)', () => {
    const cwd = `${FOLDER}/apps/api`
    expect(directoryNow(cwd)).toBe(true)
    const { store } = storeWith('w1')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual([])
  })
  it('ⓒ cwd = HOME', () => {
    const { store } = storeWith('w1')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual([])
  })
  it('F1 — 골격이 모르는 새 worktree·접근 거부 자리·심링크 자리의 pane 은 카드 밖이어도 보존한다', () => {
    const { store } = storeWith('w1')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: FRESH }, { id: 'p2', tab: 't2', cwd: LOCKED }, { id: 'p3', tab: 't3', cwd: `${LINKED}/src` }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual(['p1', 'p2', 'p3'])
  })
  it('cwd 가 없으면 판정 근거가 없어 보존한다', () => {
    const { store } = storeWith('w1')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: null }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual(['p1'])
  })
})

describe('F2 — 판정은 pane 단위·실제로 보존될 때만', () => {
  // 섞인 cwd 의 카드 밖 workspace — HOME pane 과 살아 있는 경로 pane(r1 리뷰 Grok 1).
  const mixed = (): unknown => snapshotOf([{ id: 'home', tab: 't1', cwd: HOME }, { id: 'app', tab: 't2', cwd: `${ROOT}/app` }])
  it('닫기 모양과 무관하게 같은 결과 — workspace 한 건 / 탭 순서 둘 / pane 순서 둘', () => {
    const results: string[][] = []
    const byWorkspace = storeWith('w1')
    byWorkspace.store.applySnapshot(mixed())
    closeWorkspace(byWorkspace.store)
    results.push(retainedIds(byWorkspace.store))
    for (const order of [['t1', 't2'], ['t2', 't1']]) {
      const { store } = storeWith('w1')
      store.applySnapshot(mixed())
      for (const tab of order) store.applyEvent({ event: 'tab_closed', data: { tab_id: tab } })
      results.push(retainedIds(store))
    }
    for (const order of [['home', 'app'], ['app', 'home']]) {
      const { store } = storeWith('w1')
      store.applySnapshot(mixed())
      for (const pane of order) store.applyEvent({ event: 'pane_closed', data: { pane_id: pane } })
      results.push(retainedIds(store))
    }
    expect(results).toEqual([['app'], ['app'], ['app'], ['app'], ['app']])
  })
  it('정책은 실제로 보존될 pane(done·억제 표 없음)에만 불린다 — false 는 곧 보존하지 않은 pane 이다', () => {
    const { store, calls } = storeWith('w1')
    store.applySnapshot(snapshotOf([
      { id: 'working', tab: 't1', cwd: HOME, status: 'working' },
      { id: 'mine', tab: 't2', cwd: HOME },
      { id: 'done', tab: 't3', cwd: HOME },
    ]))
    store.suppressRetention('mine')
    closeWorkspace(store)
    expect(calls).toEqual([{ workspaceId: 'w1', cwd: HOME, keep: false }])
    expect(retainedIds(store)).toEqual([])
  })
  it('pane 하나 닫기에 정책은 한 번', () => {
    const { store, calls } = storeWith('none')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: LIVE }]))
    store.applyEvent({ event: 'pane_closed', data: { pane_id: 'p1' } })
    expect(calls).toEqual([{ workspaceId: 'w1', cwd: LIVE, keep: true }])
  })
})

describe('C2 — 무회귀', () => {
  it('ⓐ 카드에 붙은 workspace 를 외부에서 닫으면 지금처럼 보존한다(cwd 가 HOME 이어도)', () => {
    const { store } = storeWith('none')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual(['p1'])
  })
  it('ⓑ corral 이 스스로 닫은 것은 지금처럼 보존하지 않는다(억제 표)', () => {
    const { store } = storeWith('none')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: LIVE }]))
    store.suppressRetention('w1')
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual([])
  })
  it('ⓒ 판정 불가면 주인 없는 모양이어도 보존한다 — 판정이 가능해진 뒤에는 C3 규칙만(HOME 행은 안 걷힘)', () => {
    const { store } = storeWith('undeterminable')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }, { id: 'p2', tab: 't2', cwd: GONE }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual(['p1', 'p2'])
    expect(prunableRetained({ retained: store.retainedRows(), determinable: true, isDeadSlot: deadSlot })).toEqual(['p2'])
  })
  it('ⓓ done 이 아닌 pane 은 지금처럼 보존하지 않는다', () => {
    const { store } = storeWith('none')
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: LIVE, status: 'working' }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual([])
  })
  it('정책이 없으면(시험·부팅 전) 지금처럼 보존한다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: HOME }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual(['p1'])
  })
  it('keepRetention — 카드 밖 목록에 없는 workspace 는 늘 보존 · 확인 불가(null) 경로는 있음 쪽', () => {
    const cardless: WorkspaceRow[] = [{ workspaceId: 'w1', label: 'ws', number: 1, focused: false, agentStatus: 'unknown', tabs: [] }]
    const base = { workspaceId: 'w1', homes: [HOME], isDeadSlot: () => false }
    expect(keepRetention({ ...base, cwd: HOME, cardless: [], isDirectory: () => true })).toBe(true)
    expect(keepRetention({ ...base, cwd: '/Volumes/locked', cardless, isDirectory: () => null })).toBe(true)
    expect(keepRetention({ ...base, cwd: '/Volumes/locked', cardless, isDirectory: () => false })).toBe(false)
  })
})

describe('C3 — 붙을 카드가 없어진 보존 행은 공급에서 걷는다', () => {
  it('worktree 가 지워져 cwd 가 죽은 자리가 되면 걷고, 같은 경로에 새 worktree 를 만들어도 옛 행이 붙지 않는다', () => {
    const slot = path.join(ROOT, '.claude/worktrees/feat')
    mkdir(path.join(slot, 'src'))
    fs.writeFileSync(path.join(slot, '.git'), 'gitdir: x\n')
    const store = new WorkspaceStore()
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: `${slot}/src` }, { id: 'p2', tab: 't2', cwd: `${ROOT}/app` }]))
    closeWorkspace(store)
    expect(retainedIds(store)).toEqual(['p1', 'p2'])
    const prune = (worktreePaths: string[]): string[] =>
      prunableRetained({ retained: store.retainedRows(), determinable: true, isDeadSlot: (target) => confirmedDeadSlot({ path: target, worktreePaths, slotState: slotStateNow }) })
    // worktree 가 살아 있는 동안은 걷지 않는다 — 목록에 있을 때도, 골격이 아직 따라오기 전(목록에 없고 `.git` 있음)에도.
    expect(prune([ROOT, slot])).toEqual([])
    expect(prune([ROOT])).toEqual([])
    // 지워진 뒤 — 골격 갱신 후 판정 가능 상태에서 걷는다. main 의 일반 하위 폴더 행은 남는다.
    fs.rmSync(slot, { recursive: true, force: true })
    const gone = prune([ROOT])
    expect(gone).toEqual(['p1'])
    expect(store.dropRetained(gone)).toEqual(['p1'])
    expect(retainedIds(store)).toEqual(['p2'])
    // 같은 경로에 새 worktree — 옛 행은 이미 공급에 없다.
    const reborn = retainedByWorktree({ repos: [{ worktrees: [{ path: ROOT, workspace: null }, { path: slot, workspace: null }] }], retained: store.retainedRows() })
    expect(reborn.get(slot)).toBeUndefined()
  })
  it('F1 — 새 worktree·접근 거부·심링크 자리의 보존 행은 걷지 않는다 · 판정 불가 동안에는 아무것도 걷지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshotOf([{ id: 'fresh', tab: 't1', cwd: FRESH }, { id: 'locked', tab: 't2', cwd: LOCKED }, { id: 'linked', tab: 't3', cwd: `${LINKED}/src` }, { id: 'gone', tab: 't4', cwd: GONE }]))
    closeWorkspace(store)
    expect(prunableRetained({ retained: store.retainedRows(), determinable: true, isDeadSlot: deadSlot })).toEqual(['gone'])
    expect(prunableRetained({ retained: store.retainedRows(), determinable: false, isDeadSlot: deadSlot })).toEqual([])
  })
})

describe('C5 store 쪽 — 행 하나 걷기(dropRetained)', () => {
  it('ⓑ 그 행만 빠진다 · ⓒ 다른 보존 행은 그대로 · ⓔ 모르는 id 는 무동작', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshotOf([{ id: 'p1', tab: 't1', cwd: LIVE }, { id: 'p2', tab: 't2', cwd: LIVE }]))
    closeWorkspace(store)
    expect(store.dropRetained(['nope'])).toEqual([])
    expect(retainedIds(store)).toEqual(['p1', 'p2'])
    expect(store.dropRetained(['p1'])).toEqual(['p1'])
    expect(retainedIds(store)).toEqual(['p2'])
    expect(store.dropRetained(['p1'])).toEqual([])
  })
})

describe('directoryNow — 사라지는 순간의 동기 확인', () => {
  it('디렉터리 true · 없음 false · 파일 false · 파일 아래 false', () => {
    const file = path.join(TMP, 'f')
    fs.writeFileSync(file, '')
    expect(directoryNow(TMP)).toBe(true)
    expect(directoryNow(path.join(TMP, 'missing'))).toBe(false)
    expect(directoryNow(file)).toBe(false)
    expect(directoryNow(path.join(file, 'under'))).toBe(false)
  })
})
