// @vitest-environment happy-dom
/* global document, window -- happy-dom 환경 */
// LIFE-691 f2 I — 「화면 탭」 승격은 **같은 워크스페이스**에서 선택 탭이 닫혔을 때만(`useLifecycleActions` selectedWorkspaceRef 가드).
// w1 에서 선택한 뒤 w1 이 닫혀 활성 워크스페이스가 w2 로 넘어가면, 화면 탭(shownTabRef = u1)이 아니라 기준대로 w2 의 herdr 포커스(q2).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const pane = (paneId, tabId, workspaceId, focused = false) => ({ paneId, tabId, workspaceId, focused })
const tab = (tabId, workspaceId, panes) => ({ tabId, workspaceId, panes })
const w1 = { workspaceId: 'w1', focused: false, tabs: [tab('t1', 'w1', [pane('p1', 't1', 'w1', true)])] }
const w2 = { workspaceId: 'w2', focused: true, tabs: [tab('u1', 'w2', [pane('q1', 'u1', 'w2')]), tab('u2', 'w2', [pane('q2', 'u2', 'w2', true)])] }
const stateOf = (input) => ({
  home: '/h',
  repos: [{
    root: '/r',
    worktrees: [
      { path: '/r', isLinked: false, openWorkspaceId: input.w1 ? 'w1' : null, workspace: input.w1 ? w1 : null },
      { path: '/r2', isLinked: true, openWorkspaceId: 'w2', workspace: w2 },
    ],
  }],
})

let host
let root
let hook = null
function Harness({ state }) {
  hook = useLifecycleActions(state)
  return null
}
const push = (state) => act(() => root.render(createElement(Harness, { state })))
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', {})
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('w1 선택 → w1 닫혀 활성 w2 — 화면 탭 u1 이 아니라 w2 의 herdr 포커스 q2', () => {
  push(stateOf({ w1: true }))
  act(() => hook.selectPane('p1'))
  push(stateOf({ w1: true }))
  expect(hook.selectedPane).toBe('p1')
  expect(hook.activeWorkspaceId).toBe('w1')
  hook.shownTabRef.current = 'u1'
  push(stateOf({ w1: false }))
  push(stateOf({ w1: false }))
  expect(hook.activeWorkspaceId).toBe('w2')
  expect(hook.selectedPane).toBe('q2')
})
