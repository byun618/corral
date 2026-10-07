// @vitest-environment happy-dom
/* global document, window -- happy-dom 환경 */
// LIFE-490 K2 — 열기·생성 응답이 state 보다 먼저 와도 활성이 남는가, 그리고 보류의 가장자리(실패·미도착·사용자 선택·도착 뒤 닫힘·재기동).
// 실제 React 로 훅을 돌리고, IPC 는 손으로 푸는 약속, state push 는 Harness 다시 그리기로 흉내 낸다.
// 순서는 격리 계측(`specs/LIFE-490-sidebar-card/raw/claude/k1/`)에서 본 그대로다: 응답 → 새 workspace 없는 push → 늦게 도착.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const ws = (workspaceId, focused = false) => ({ workspaceId, focused, tabs: [] })
const row = (path, workspace, isLinked = true) => ({ path, isLinked, workspace, openWorkspaceId: workspace?.workspaceId ?? null })
/** 주 체크아웃 w1(focused) + 링크 a·b·c. `open` 은 열린 링크 → workspace id. */
const stateOf = (open) => ({
  home: '/h',
  repos: [{ root: '/r', worktrees: [row('/r', ws('w1', true), false), ...['a', 'b', 'c'].map((name) => row(`/r-${name}`, open[name] === undefined ? null : ws(open[name])))] }],
})
const wt = (state, name) => state.repos[0].worktrees.find((item) => item.path === `/r-${name}`)

let host
let root
let hook = null
let opens
let creates
let rows
function Harness({ state }) {
  hook = useLifecycleActions(state)
  return null
}
const push = (state) => act(() => root.render(createElement(Harness, { state })))
const deferred = (list) => () => new Promise((resolve) => list.push(resolve))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  opens = []
  creates = []
  rows = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', { openWorktree: deferred(opens), createWorktree: deferred(creates), createRow: deferred(rows) })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('열기 응답이 state 보다 먼저 온다 (결함 경로)', () => {
  it('응답 → 새 workspace 없는 push → 늦게 도착: 활성은 끝까지 연 워크트리', async () => {
    const before = stateOf({})
    push(before)
    expect(hook.activeWorkspaceId).toBe('w1')
    act(() => hook.actions.openWorktree('/r', wt(before, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    expect(hook.activeWorkspaceId).toBe('w9')
    push(stateOf({})) // 새 workspace 가 아직 없는 push — 옛 규칙은 여기서 w1 로 승격했다
    expect(hook.activeWorkspaceId).toBe('w9')
    push(stateOf({ a: 'w9' }))
    expect(hook.activeWorkspaceId).toBe('w9')
  })
  it('열린 workspace 0 에서 출발 — 부모(main)가 먼저 도착해 승격돼도 응답이 오면 연 워크트리', async () => {
    const empty = { home: '/h', repos: [{ root: '/r', worktrees: [row('/r', null, false), row('/r-a', null)] }] }
    push(empty)
    expect(hook.activeWorkspaceId).toBe(null)
    act(() => hook.actions.openWorktree('/r', empty.repos[0].worktrees[1]))
    push(stateOf({})) // 부모 w1 도착 → 승격
    expect(hook.activeWorkspaceId).toBe('w1')
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null, parentOpened: true }))
    push(stateOf({}))
    expect(hook.activeWorkspaceId).toBe('w9')
    push(stateOf({ a: 'w9' }))
    expect(hook.activeWorkspaceId).toBe('w9')
  })
})

describe('보류의 가장자리 (K2)', () => {
  it('ⓐ 열기 실패·거절 → 활성 불변', async () => {
    const state = stateOf({ b: 'w2' })
    push(state)
    act(() => hook.actions.activateWorkspace('w2'))
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: false, workspaceId: null, rejection: null, error: 'herdr down' }))
    expect(hook.activeWorkspaceId).toBe('w2')
    act(() => hook.actions.openWorktree('/r', wt(state, 'c')))
    await act(async () => opens[1]({ ok: false, workspaceId: null, rejection: { code: 'x', message: 'no' }, error: null }))
    push(stateOf({ b: 'w2' }))
    expect(hook.activeWorkspaceId).toBe('w2')
  })
  it('ⓑ 응답은 왔는데 끝내 state 에 안 들어옴 → 기한(레포 1 = 36초) 뒤 focused 로, push 가 더 없어도', async () => {
    const state = stateOf({})
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    push(stateOf({}))
    act(() => vi.advanceTimersByTime(35_999))
    expect(hook.activeWorkspaceId).toBe('w9')
    act(() => vi.advanceTimersByTime(1))
    expect(hook.activeWorkspaceId).toBe('w1')
  })
  it('ⓒ 기다리는 사이 사용자가 다른 행을 누름 → 사용자 선택이 이긴다(늦은 응답이 빼앗지 않음)', async () => {
    const state = stateOf({ b: 'w2' })
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    act(() => hook.actions.activateWorkspace('w2'))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    expect(hook.activeWorkspaceId).toBe('w2')
    push(stateOf({ a: 'w9', b: 'w2' }))
    expect(hook.activeWorkspaceId).toBe('w2')
  })
  it('ⓒ 응답 뒤·도착 전 사용자가 세션을 누름 → 그 선택, 도착해도 그대로', async () => {
    const withPane = (open) => {
      const state = stateOf(open)
      wt(state, 'b').workspace.tabs = [{ tabId: 't2', workspaceId: 'w2', panes: [{ paneId: 'p2', focused: true, agent: null }] }]
      return state
    }
    const state = withPane({ b: 'w2' })
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    expect(hook.activeWorkspaceId).toBe('w9')
    act(() => hook.selectPane('p2'))
    expect(hook.activeWorkspaceId).toBe('w2')
    push(withPane({ a: 'w9', b: 'w2' }))
    expect(hook.activeWorkspaceId).toBe('w2')
  })
  it('ⓒ 두 열기가 겹치면 나중에 누른 것이 이긴다 — 응답이 거꾸로 와도', async () => {
    const state = stateOf({})
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    act(() => hook.actions.openWorktree('/r', wt(state, 'c')))
    await act(async () => opens[1]({ ok: true, workspaceId: 'w8', rejection: null, error: null }))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    expect(hook.activeWorkspaceId).toBe('w8')
    push(stateOf({ a: 'w9', c: 'w8' }))
    expect(hook.activeWorkspaceId).toBe('w8')
  })
  it('ⓓ 도착 뒤 닫힘 → 옛 규칙(focused)', async () => {
    const state = stateOf({})
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    push(stateOf({ a: 'w9' }))
    expect(hook.activeWorkspaceId).toBe('w9')
    push(stateOf({}))
    expect(hook.activeWorkspaceId).toBe('w1')
  })
  it('ⓔ 재기동 — 열린 workspace 들과 함께 뜨면 focused 승격 그대로', () => {
    const state = stateOf({ b: 'w2' })
    state.repos[0].worktrees[0].workspace.focused = false
    wt(state, 'b').workspace.focused = true
    push(state)
    expect(hook.activeWorkspaceId).toBe('w2')
  })
  it('응답 때 이미 state 에 있으면 보류 없이 바로 — 기한 타이머도 걸지 않는다', async () => {
    const state = stateOf({ a: 'w9' })
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    expect(hook.activeWorkspaceId).toBe('w9')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('보류 중 같은 workspace 로의 사용자 동작 (fix1 F1 · r1 G-1)', () => {
  it('응답 뒤·도착 전 ⌘T(같은 id) → push 가 와도 활성 유지, 도착 뒤 그 workspace', async () => {
    const state = stateOf({})
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    act(() => hook.createShell()) // 대상 = 지금 활성 w9 — createRow 가 setActive(w9) 를 부른다
    expect(rows.length).toBe(1)
    push(stateOf({})) // 새 workspace 없는 push — r1 은 여기서 보류가 지워져 w1 로 승격했다
    expect(hook.activeWorkspaceId).toBe('w9')
    push(stateOf({ a: 'w9' }))
    expect(hook.activeWorkspaceId).toBe('w9')
  })
  it('같은 id 로 활성화(행 클릭) 뒤에도 기한은 그대로 — 끝내 안 오면 focused 로', async () => {
    const state = stateOf({})
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    act(() => hook.actions.activateWorkspace('w9'))
    push(stateOf({}))
    expect(hook.activeWorkspaceId).toBe('w9')
    act(() => vi.runOnlyPendingTimers())
    expect(hook.activeWorkspaceId).toBe('w1')
  })
  it('다른 id 로 활성화하면 보류는 버린다 — 지금 규칙 그대로', async () => {
    const state = stateOf({ b: 'w2' })
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    act(() => hook.actions.activateWorkspace('w2'))
    push(stateOf({ a: 'w9', b: 'w2' }))
    expect(hook.activeWorkspaceId).toBe('w2')
  })
})

describe('보류 만료는 타이머가 정한다 (fix1 F2 · r1 L4)', () => {
  it('타이머가 벽시계 기한보다 먼저 울려도(시계가 뒤로 감) 만료한다 — 죽은 id 에 머물지 않는다', async () => {
    const state = stateOf({})
    push(state)
    act(() => hook.actions.openWorktree('/r', wt(state, 'a')))
    await act(async () => opens[0]({ ok: true, workspaceId: 'w9', rejection: null, error: null }))
    push(stateOf({}))
    vi.setSystemTime(Date.now() - 60_000) // 벽시계만 뒤로 — 타이머 발화 시점의 Date.now() 는 기한 전이다
    act(() => vi.runOnlyPendingTimers())
    expect(hook.activeWorkspaceId).toBe('w1')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('생성(+) 경로 (D3)', () => {
  it('성공 → 새 워크트리가 활성, 늦게 도착해도 유지', async () => {
    push(stateOf({ b: 'w2' }))
    act(() => hook.actions.activateWorkspace('w2'))
    const created = hook.createWorktree({ repoRoot: '/r', branch: 'n', path: '/r-n' })
    let result = null
    await act(async () => {
      creates[0]({ ok: true, workspaceId: 'w7', rejection: null, error: null })
      result = await created
    })
    expect(result.ok).toBe(true)
    expect(hook.activeWorkspaceId).toBe('w7')
    push(stateOf({ b: 'w2' }))
    expect(hook.activeWorkspaceId).toBe('w7')
  })
  it('실패 → 활성 불변', async () => {
    push(stateOf({ b: 'w2' }))
    act(() => hook.actions.activateWorkspace('w2'))
    const created = hook.createWorktree({ repoRoot: '/r', branch: 'b', path: '/r-b' })
    await act(async () => {
      creates[0]({ ok: false, workspaceId: null, rejection: null, error: 'branch exists' })
      await created
    })
    expect(hook.activeWorkspaceId).toBe('w2')
  })
})
