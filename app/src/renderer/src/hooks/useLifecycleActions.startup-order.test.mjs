// @vitest-environment happy-dom
/* global document, window -- happy-dom 환경 */
// LIFE-691 f1 A — 재기동 때 `getState` 와 `getUiPrefs`(배치 hydrate) 도착 순서와 무관하게 첫 선택 pane 이 기준 동작(herdr 포커스)이다.
// 리뷰 r1 프로브(`raw/review/claude-r1-raw/probe/zz-review-probe-startup.test.tsx`)와 같은 결: 저장 활성 t2, herdr 포커스 p2(t2), 첫 탭 t1(p1).
// 고치기 전 HEAD(df6d5c394)는 state 먼저에서 p1 (화면 t2 와 갈림).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useGroupLayout } from './useGroupLayout.js'
import { useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const pane = (paneId, tabId, focused = false) => ({ paneId, tabId, workspaceId: 'w1', focused })
const tab = (tabId, panes) => ({ tabId, workspaceId: 'w1', panes })
const stateOf = (tabs) => ({
  home: '/h',
  herdrTabIds: tabs.map((row) => row.tabId),
  repos: [{ root: '/r', worktrees: [{ path: '/r', isLinked: false, openWorkspaceId: 'w1', workspace: { workspaceId: 'w1', focused: true, tabs } }] }],
})
const full = () => [tab('t1', [pane('p1', 't1')]), tab('t2', [pane('p2', 't2', true)]), tab('t3', [pane('p3', 't3')])]
const stored = [{ worktreePath: '/r', layoutFormat: 2, layout: { activeGroupId: 'g1', root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1', 't2', 't3'], activeTabId: 't2' } } } }]

let out = { selected: null, shown: null }
let hook = null
function Harness({ state, ready }) {
  const lifecycle = useLifecycleActions(state)
  const liveTabIds = state === null ? [] : state.repos[0].worktrees[0].workspace.tabs.map((row) => row.tabId)
  const layout = useGroupLayout({ worktreePath: '/r', liveTabIds, ready, stored: ready ? stored : [], pinned: new Set(), herdrTabIds: null })
  const active = layout.groups.find((group) => group.groupId === layout.activeGroupId)?.activeTabId ?? null
  // App.tsx 와 같은 배선 — 렌더마다 화면 탭을 채운다.
  lifecycle.shownTabRef.current = active
  hook = lifecycle
  out = { selected: lifecycle.selectedPane, shown: active }
  return null
}

let host
let root
const push = (props) => act(() => root.render(createElement(Harness, props)))
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', { setUiPrefs: () => {} })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('재기동 도착 순서 (f1 A)', () => {
  it('state 먼저(배치 hydrate 전) — 선택 pane = herdr 포커스 p2, 화면 t2 와 맞는다', () => {
    push({ state: stateOf(full()), ready: false })
    push({ state: stateOf(full()), ready: true })
    console.log(`state-first ${JSON.stringify(out)}`)
    expect(out).toEqual({ selected: 'p2', shown: 't2' })
  })
  it('prefs 먼저 — 선택 pane = p2', () => {
    push({ state: null, ready: true })
    push({ state: stateOf(full()), ready: true })
    console.log(`prefs-first ${JSON.stringify(out)}`)
    expect(out).toEqual({ selected: 'p2', shown: 't2' })
  })
  it('재기동 뒤 선택 탭(t2)을 닫으면 화면의 새 활성 탭 — K2ⓑ 는 그대로 (MRU 없음 → 오른쪽 t3, herdr 포커스는 t1 로 옮겨 감)', () => {
    push({ state: stateOf(full()), ready: false })
    push({ state: stateOf(full()), ready: true })
    expect(hook.selectedPane).toBe('p2')
    push({ state: stateOf([tab('t1', [pane('p1', 't1', true)]), tab('t3', [pane('p3', 't3')])]), ready: true })
    expect(out).toEqual({ selected: 'p3', shown: 't3' })
  })
})
